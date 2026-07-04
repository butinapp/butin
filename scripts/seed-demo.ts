// Populate an isolated BUTIN_HOME with deterministic synthetic ledgers + current caches, so the app is fully
// demo-able with no real accounts. Default: one `personal` profile with every plugin. With `--scenario <name>`
// it seeds a COHORT of profiles that share the base seed — byte-identical data — diverging only by service
// subset + missed days. Run: pnpm seed-demo [--home ./.demo-home] [--scenario <name>]
// [--days 30] [--window 180] [--now <iso>]. View: BUTIN_HOME=./.demo-home pnpm dev (quit the real instance first).

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { type EvolveOptions } from '../packages/core/src/dev/seed/evolver.js'
import { fallbackSnapshot } from '../packages/core/src/dev/seed/fallback.js'
import { synthesizeCapability } from '../packages/core/src/dev/seed/synthesize.js'
import { type SeriesInput, evaluateChangeAlerts } from '../packages/core/src/main/alerts/change-alerts.js'
import { evaluateHealthChecks } from '../packages/core/src/main/alerts/health-checks.js'
import { mergeNotifications } from '../packages/core/src/main/alerts/merge.js'
import { isButinPlugin } from '../packages/core/src/main/plugin/is-plugin.js'
import { seriesPoints } from '../packages/core/src/main/store/project-ledger.js'
import type { OverviewTileDto } from '../packages/core/src/shared/ipc.js'
// The SDK is imported by RELATIVE path (like the core imports below): this root-level script is not a package,
// so `@butinapp/sdk` isn't resolvable as a bare specifier at runtime — only a type-only import would be erased.
import type { ButinPlugin, CapabilityResult, Summary } from '../packages/sdk/src/index.js'
import { resolveSampleConfig, type SampleConfig, type SampleSize } from '../packages/sdk/src/testing/index.js'
import { convert } from '../packages/sdk/src/util/index.js'
import { combineDailySpend, deriveDailySpend, type DailyPoint } from '../packages/shapes/src/index.js'

import type { SeedGap, SeedProfile, SeedScenario } from './seed-scenarios/types.js'

// The default change thresholds (DEFAULT_ALERT_CONFIG.change), inlined so the seed doesn't import the
// alerts-config store (which pulls the data-root/vault chain). A move > the % fires that window's alert.
const CHANGE_THRESHOLDS = {
  dod: { spend: 50, usage: 50 },
  wow: { spend: 30, usage: 50 },
  mom: { spend: 20, usage: 40 }
}

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`)

  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback
}

const numArg = (name: string): number | undefined => {
  const i = process.argv.indexOf(`--${name}`)

  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : undefined
}

const sizeArg = (): SampleSize | undefined => {
  const v = arg('size', '')

  return v === 'small' || v === 'medium' || v === 'large' || v === 'xlarge' ? v : undefined
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const home = resolve(arg('home', '.demo-home'))
const DEFAULT_NOW = '2026-06-17T12:00:00.000Z'

// Resolve `--scenario <name|path>` to its module: a bare name → scripts/seed-scenarios/<name>.ts; anything
// path-like is resolved as given. Absent → null (the default single-profile run).
const loadScenario = async (): Promise<SeedScenario | null> => {
  const name = arg('scenario', '')

  if (!name) {
    return null
  }

  const path =
    name.includes('/') || name.includes('\\') || name.endsWith('.ts')
      ? resolve(name)
      : join(ROOT, 'scripts', 'seed-scenarios', `${name}.ts`)
  const mod = (await import(pathToFileURL(path).href)) as { scenario?: SeedScenario }

  if (!mod.scenario) {
    throw new Error(`scenario module ${path} has no \`scenario\` export`)
  }

  return mod.scenario
}

// Import every plugin descriptor in isolation (a bad one is logged + skipped, never aborts the run).
const loadPlugins = async (): Promise<ButinPlugin[]> => {
  const pluginsDir = join(ROOT, 'plugins')
  const out: ButinPlugin[] = []

  for (const id of readdirSync(pluginsDir)) {
    const main = join(pluginsDir, id, 'src', 'main.ts')

    // plugins/ is a package dir; skip its own files (node_modules, .turbo, package.json, …) — a plugin is a
    // subdir with a src/main.ts.
    if (!existsSync(main)) {
      continue
    }

    try {
      const mod = (await import(pathToFileURL(main).href)) as Record<string, unknown>
      const found = Object.values(mod).find(isButinPlugin)

      if (found) {
        out.push(found)
      } else {
        console.warn(`[seed] no ButinPlugin export in ${id} — skipping`)
      }
    } catch (err) {
      console.warn(`[seed] failed to load ${id} — skipping:`, (err as Error).message)
    }
  }

  return out
}

const writeJson = (path: string, value: unknown): void => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2))
}

// Fixed demo FX rates (value in USD of 1 unit) so a non-USD plugin's spend converts + shows on the Overview
// instead of dropping to $0.00 + a missing-rate alert. A currency with no entry falls back to 0.75 — enough to
// convert (the point is the demo, not the exact rate). Real users enter/fetch their own in the FX pane.
const DEMO_FX_RATES: Record<string, number> = { CAD: 0.73, EUR: 1.08, GBP: 1.27, AUD: 0.66, CHF: 1.12, JPY: 0.0064 }

// A contributor's missed-day predicate from its gap ranges (inclusive, lexicographic on YYYY-MM-DD).
const buildSkipDay = (gaps?: SeedGap[]): EvolveOptions['skipDay'] =>
  gaps && gaps.length > 0 ? (day) => gaps.some((g) => day >= g.from && day <= g.to) : undefined

// The browser partition for a profile: `personal` keeps `persist:butin` (a single-profile install's logins are
// preserved); a cohort profile is isolated under `persist:butin-<id>`.
const partitionFor = (id: string): string => (id === 'personal' ? 'persist:butin' : `persist:butin-${id}`)

// Seed one profile's whole store: per-capability ledger + current cache, config.json (which services are
// installed/connected), fx.json, notifications.json. Mirrors runCapability's persistence so the store is shaped
// like a genuinely-fetched one. Returns the number of capabilities written. Plugins are scoped to the profile's
// `services` subset; days the profile missed (`gaps`) emit no observation.
const seedProfile = (
  profile: SeedProfile,
  plugins: ButinPlugin[],
  baseOpts: EvolveOptions,
  sampleConfig: SampleConfig
): number => {
  const profileDir = join(home, 'profiles', profile.id)
  const opts: EvolveOptions = { ...baseOpts, skipDay: buildSkipDay(profile.gaps) }
  const scoped = profile.services ? plugins.filter((p) => profile.services!.includes(p.meta.id)) : plugins
  // A diverging service salts its seed with the profile id so its values differ between contributors; every
  // other service shares the bare seed, so the cohort agrees exactly where it isn't deliberately conflicting.
  const seedFor = (pluginId: string, capId: string): string =>
    profile.diverge?.includes(pluginId) ? `${profile.id}:${pluginId}:${capId}` : `${pluginId}:${capId}`

  mkdirSync(profileDir, { recursive: true })

  let caps = 0
  // Every non-base currency the seeded data denominates spend/balance in — so fx.json can carry a rate for each.
  const currencies = new Set<string>()

  // Per-plugin rollup of what the alert evaluators need: deduped summaries (for health checks) + the spend/other
  // per-day series differenced from the ledger (for change alerts) — mirrors buildOverview + buildAlertSeries.
  type PluginRoll = {
    name: string
    currency: string
    connected: boolean
    summaries: Summary[]
    seen: Set<string>
    spendDaily: DailyPoint[]
    otherDaily: DailyPoint[]
  }
  const roll = new Map<string, PluginRoll>()
  // The config.json the app reads to decide which services are Installed (shown in the sidebar + Overview) and
  // Connected (the green dot). A session plugin reads connected off a stored `cookie`; an `external` plugin off
  // filled config — left disconnected here (no synthetic config), but still installed so it shows with its data.
  const configPlugins: Record<string, Record<string, unknown>> = {}

  for (const plugin of scoped) {
    for (const cap of plugin.capabilities) {
      // Shared per capability so contributors agree exactly on a day they both report — unless this service is
      // declared divergent for the profile, in which case the profile id salts it into a conflicting reading.
      const seed = seedFor(plugin.meta.id, cap.id)

      let snapshot: CapabilityResult

      try {
        snapshot = cap.sample ? cap.sample({ config: sampleConfig, seed }) : fallbackSnapshot(cap.id, seed)

        if (!cap.sample) {
          console.log(`[seed] ${profile.id}/${seed}: generic fallback (no sample declared)`)
        }
      } catch (err) {
        console.warn(`[seed] ${profile.id}/${seed}: sample threw — using fallback:`, (err as Error).message)
        snapshot = fallbackSnapshot(cap.id, seed)
      }

      try {
        const result = synthesizeCapability(snapshot, plugin.reportingCurrency, opts, seed)

        if (!result) {
          console.log(`[seed] ${profile.id}/${seed}: fully gapped — skipped`)
          continue
        }

        const { ledger, current, lastRunAt } = result

        // Track every currency the data is denominated in (summary + money-column), so fx.json gets a rate for each.
        for (const s of current.summaries ?? []) {
          if (s.currency) {
            currencies.add(s.currency)
          }
        }

        for (const ds of current.datasets ?? []) {
          for (const c of ds.columns ?? []) {
            if (c.currency) {
              currencies.add(c.currency)
            }
          }
        }

        // Accumulate this capability into its plugin's alert rollup: dedup summaries by section, track the spend
        // currency, and difference the ledger's spend/other section series into per-day points.
        const r = roll.get(plugin.meta.id) ?? {
          name: plugin.meta.name,
          currency: plugin.reportingCurrency,
          connected: plugin.auth.kind !== 'external',
          summaries: [],
          seen: new Set<string>(),
          spendDaily: [],
          otherDaily: []
        }

        for (const s of (current.summaries ?? []) as Summary[]) {
          if (!r.seen.has(s.section)) {
            r.seen.add(s.section)
            r.summaries.push(s)
          }

          if (s.section === 'spend' && s.currency) {
            r.currency = s.currency
          }
        }

        const spend = deriveDailySpend(seriesPoints(ledger, 'spend'))
        const other = deriveDailySpend(seriesPoints(ledger, 'other'))

        if (spend.length) {
          r.spendDaily = spend
        }

        if (other.length) {
          r.otherDaily = other
        }

        roll.set(plugin.meta.id, r)

        writeJson(join(profileDir, plugin.meta.id, 'ledger', `${cap.id}.json`), ledger)
        writeJson(join(profileDir, plugin.meta.id, 'current', `${cap.id}.json`), {
          pluginId: plugin.meta.id,
          capabilityId: cap.id,
          lastRunAt,
          data: current
        })
        caps++
        // First successful capability marks the plugin installed + enabled (the sidebar lists installed AND
        // enabled services; Overview only needs installed), onboarded (onboardedAt is set on a real first
        // refresh — without it the service page shows onboarding mode), + a verbatim cookie for the connected dot.
        configPlugins[plugin.meta.id] ??= {
          installed: true,
          enabled: true,
          onboardedAt: new Date(opts.now).getTime(),
          ...(plugin.auth.kind === 'external' ? {} : { cookie: 'demo-session', cookie_enc: false })
        }
      } catch (err) {
        console.warn(`[seed] ${profile.id}/${seed}: synthesize failed — skipping:`, (err as Error).message)
      }
    }
  }

  writeJson(join(profileDir, 'config.json'), { plugins: configPlugins })

  // fx.json: a USD base + a rate for every non-USD currency the data uses, so foreign-currency spend converts
  // and shows on the Overview (without it, a CAD plugin drops to $0.00 + a missing-rate alert).
  const rates = Object.fromEntries([...currencies].filter((c) => c !== 'USD').map((c) => [c, DEMO_FX_RATES[c] ?? 0.75]))

  writeJson(join(profileDir, 'fx.json'), { baseCurrency: 'USD', rates, source: 'demo seed', fetchedAt: opts.now })

  // notifications.json: run the real (pure) evaluators over the rollup so the demo's notifications panel is
  // populated — change alerts off the per-day series + health checks (missing-fx) off the tiles. The cross-
  // service spend total rides as the `__total__` series. Deterministic (now = opts.now; rates fixed above).
  const tiles: OverviewTileDto[] = []
  const series: SeriesInput[] = []
  const spendInBase: DailyPoint[][] = []

  for (const [id, r] of roll) {
    tiles.push({
      pluginId: id,
      name: r.name,
      state: r.connected ? 'connected' : 'disconnected',
      currency: r.currency,
      summaries: r.summaries,
      daily: r.spendDaily.length ? r.spendDaily : undefined
    })

    if (!r.connected) {
      continue
    }

    if (r.spendDaily.length) {
      series.push({ pluginId: id, facet: 'spend', currency: r.currency, daily: r.spendDaily })
      spendInBase.push(
        r.spendDaily.flatMap((p) => {
          const value = convert(p.value, r.currency, 'USD', rates)

          return value === null ? [] : [{ ...p, value }]
        })
      )
    }

    if (r.otherDaily.length && r.summaries.some((s) => s.section === 'other' && s.role === 'money')) {
      series.push({ pluginId: id, facet: 'usage', currency: r.currency, daily: r.otherDaily })
    }
  }

  const total = combineDailySpend(spendInBase)

  if (total.length) {
    series.push({ pluginId: '__total__', facet: 'spend', currency: 'USD', daily: total })
  }

  const now = new Date(opts.now)
  const change = evaluateChangeAlerts(series, CHANGE_THRESHOLDS, now)
  const health = evaluateHealthChecks(tiles, { baseCurrency: 'USD', rates })
  const notifications = mergeNotifications([], [...change, ...health], now.toISOString())

  writeJson(join(profileDir, 'notifications.json'), notifications)

  console.log(
    `[seed] ${profile.id}: ${caps} capabilities, ${Object.keys(configPlugins).length} plugins, ${change.length} change + ${health.length} health alerts`
  )

  return caps
}

const run = async (): Promise<void> => {
  const plugins = await loadPlugins()
  const scenario = await loadScenario()

  // One config drives both the sample generators (users/documents) and the evolver window (days/window). CLI
  // flags override the scenario's base; the scenario overrides the resolveSampleConfig defaults.
  const sampleConfig: SampleConfig = resolveSampleConfig({
    size: sizeArg() ?? scenario?.size,
    users: numArg('users') ?? scenario?.users,
    documents: numArg('documents') ?? scenario?.documents,
    days: numArg('days') ?? scenario?.days,
    window: numArg('window') ?? scenario?.window
  })
  const baseOpts: EvolveOptions = {
    now: arg('now', scenario?.now ?? DEFAULT_NOW),
    days: sampleConfig.days,
    window: sampleConfig.window
  }

  const profiles: SeedProfile[] = scenario?.profiles ?? [{ id: 'personal', name: 'Personal' }]

  // The registry + plaintext (OFF) profiles, so the app opens straight into the seeded data. The first profile
  // is active.
  writeJson(join(home, 'profiles.json'), {
    activeProfileId: profiles[0]!.id,
    profiles: profiles.map((p) => ({
      id: p.id,
      name: p.name,
      ...(p.color ? { color: p.color } : {}),
      createdAt: baseOpts.now,
      partition: partitionFor(p.id)
    }))
  })

  let totalCaps = 0

  for (const profile of profiles) {
    totalCaps += seedProfile(profile, plugins, baseOpts, sampleConfig)
  }

  console.log(`[seed] wrote ${totalCaps} capabilities across ${profiles.length} profile(s) → ${home}`)
  // `home` is absolute. Pass it verbatim: `pnpm dev` runs Electron from packages/core, so a RELATIVE BUTIN_HOME
  // would resolve against that dir (a different, empty folder) — the seed and the app must share one absolute path.
  console.log(`[seed] view it with:\n  BUTIN_HOME="${home}" pnpm dev`)
}

await run()
