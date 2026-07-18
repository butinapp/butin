import type { FxRates } from '@butinapp/sdk/util'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { dataRootDir } from './store.js'

// The user's currency settings: which currency the Overview rolls up into, and the rate table that gets
// foreign-currency services there. Rates are entered manually or filled by a transparent fetch; `source` +
// `fetchedAt` record where the current table came from. `rates[c]` = value in baseCurrency of 1 unit of c.
export type FxConfig = {
  baseCurrency: string
  rates: FxRates
  source?: string
  fetchedAt?: string
  // Set once the user fixes a base currency in Settings. Until then the base is auto-resolved to the dominant
  // currency of the connected services, so a single-currency user (all-CAD, say) needs no FX at all.
  baseExplicit?: boolean
}

const DEFAULT: FxConfig = { baseCurrency: 'USD', rates: {} }

const fxPath = (): string => join(dataRootDir(), 'fx.json')

export const getFxConfig = async (): Promise<FxConfig> => {
  try {
    const stored = JSON.parse(await readFile(fxPath(), 'utf8')) as Partial<FxConfig>

    return { ...DEFAULT, ...stored }
  } catch {
    return DEFAULT
  }
}

export const setFxConfig = async (cfg: FxConfig): Promise<void> => {
  await mkdir(dirname(fxPath()), { recursive: true })
  await writeFile(fxPath(), JSON.stringify(cfg, null, 2))
}

// A rate lookup: value in `to` of 1 unit of `from` (so `rates[from] = fetchRate(from, base)`), or null when it
// can't be had (offline, unsupported currency, a bad response). Best-effort and bounded — never throws.
export type RateFetcher = (from: string, to: string) => Promise<number | null>

const FETCH_TIMEOUT_MS = 5000
// How long a fetched table is trusted before the next overview/settings open re-fetches it. Rates move slowly;
// a half-day cache keeps a spend dashboard current without hitting the API on every open.
const RATE_TTL_MS = 12 * 60 * 60 * 1000

const readJson = async (url: string): Promise<{ rates?: Record<string, unknown> } | null> => {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)

  try {
    const res = await globalThis.fetch(url, { signal: ctrl.signal })

    return res.ok ? ((await res.json()) as { rates?: Record<string, unknown> }) : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

const rateFrom = (json: { rates?: Record<string, unknown> } | null, to: string): number | null => {
  const r = json?.rates?.[to]

  return typeof r === 'number' && Number.isFinite(r) && r > 0 ? r : null
}

// Frankfurter (European Central Bank reference rates, keyless) with an open.er-api.com fallback for currencies
// the ECB set doesn't cover. `?base=<from>&symbols=<to>` returns 1 from = N to, which IS the stored rate shape.
export const fetchRate: RateFetcher = async (from, to) => {
  if (from === to) {
    return 1
  }

  const frankfurter = rateFrom(await readJson(`https://api.frankfurter.dev/v1/latest?base=${from}&symbols=${to}`), to)

  return frankfurter ?? rateFrom(await readJson(`https://open.er-api.com/v6/latest/${from}`), to)
}

// The dominant currency among the services in play (the mode) — the auto base pick. Ties resolve to the first
// seen, so a stable currency list gives a deterministic base.
const dominant = (currencies: string[]): string | undefined => {
  const counts = new Map<string, number>()

  for (const c of currencies) {
    counts.set(c, (counts.get(c) ?? 0) + 1)
  }

  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
}

// Resolve the effective FX config for the currencies actually in play: auto-pick the base (the dominant one)
// unless the user has fixed it, then fill any missing/stale foreign rate from the keyless rate API. Best-effort
// — a failed fetch just leaves that rate absent (the Overview then shows native amounts rather than blanking).
// Persists the resolved table so the next open is instant and offline-safe.
export const resolveFxConfig = async (
  currenciesInPlay: string[],
  fetcher: RateFetcher = fetchRate,
  now: number = Date.now()
): Promise<FxConfig> => {
  const stored = await getFxConfig()
  const base = stored.baseExplicit ? stored.baseCurrency : (dominant(currenciesInPlay) ?? stored.baseCurrency)
  const foreign = [...new Set(currenciesInPlay)].filter((c) => c && c !== base)
  const isManual = stored.source === 'manual'
  const stale = !stored.fetchedAt || now - Date.parse(stored.fetchedAt) > RATE_TTL_MS
  const rates: FxRates = { ...stored.rates }

  // Fetch a currency we have no rate for; on an auto table, also refresh in-play rates once they're stale. A
  // manual table's hand-entered rates are never overwritten — only genuinely missing currencies get filled.
  const needed = foreign.filter((c) => rates[c] == null || (!isManual && stale))
  let fetched = false

  for (const c of needed) {
    const r = await fetcher(c, base)

    if (r != null) {
      rates[c] = r
      fetched = true
    }
  }

  const next: FxConfig = {
    baseCurrency: base,
    rates,
    source: isManual ? 'manual' : 'auto',
    fetchedAt: fetched ? new Date(now).toISOString() : stored.fetchedAt,
    ...(stored.baseExplicit ? { baseExplicit: true } : {})
  }

  if (fetched || base !== stored.baseCurrency) {
    await setFxConfig(next)
  }

  return next
}
