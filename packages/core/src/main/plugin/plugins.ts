import type { ButinPlugin } from '@butinapp/sdk'

import { log } from '../log.js'

import { isButinPlugin } from './is-plugin.js'

// Plugin registry — AUTO-DISCOVERED, and load-ISOLATED. Every plugins/<id>/main.ts is picked up at
// build time, so adding a plugin is ZERO edits here AND nothing to install: a plugin is a folder in the
// single `@butinapp/plugins` package (not its own workspace member), so dropping the folder is the whole step.
//
// Loading is LAZY (not `eager: true`) on purpose: a plugin that throws at module-evaluation — a top-level
// `throw`, a bad import, a malformed `definePlugin` export — must not take down the whole app. Eager glob
// hoists every plugin into a static import, so one throw aborts the main bundle before any handler runs
// (the "A JavaScript error occurred in the main process" crash). Lazy thunks let us import each module in
// its own try/catch: a broken plugin is logged and skipped, every other plugin loads.
const loaders = import.meta.glob<Record<string, unknown>>('../../../../../plugins/*/main.ts')

// A plugin file exports its descriptor under its own name (e.g. `serperPlugin`); `isButinPlugin` finds it by
// shape so no naming convention is imposed, and lets a malformed/missing export be reported (with the file
// path) and skipped instead of silently vanishing OR crashing the portal.

// One plugin that didn't make it into the registry: its source path + why. Surfaced to the UI (a banner)
// so a silently-missing service is explainable instead of a console-only mystery.
export interface PluginLoadFailure {
  path: string
  reason: string
}

// Populated in place by loadPlugins(). Empty until loadPlugins() resolves, which bootstrap awaits before
// wiring IPC, so nothing reads it early.
export const plugins: ButinPlugin[] = []

// The load failures from the last loadPlugins() run, retained so an IPC handler can hand them to the UI.
let loadFailures: PluginLoadFailure[] = []

export const getLoadFailures = (): PluginLoadFailure[] => loadFailures

// Trim a discovered module path to the plugin folder name (…/plugins/<id>/main.ts → <id>) for a
// human-readable label in logs + the UI banner.
const pluginLabel = (path: string): string => path.match(/plugins\/([^/]+)\//)?.[1] ?? path

// Gate a shape-valid plugin against the id convention before it joins the registry. `meta.id` MUST equal
// the folder name — it's the permanent key for the session partition (`persist:butin:<id>`), the data
// folder, and the credential/config store, so a mismatch silently splits a service's storage across two
// keys. And no two plugins may claim the same id, since pluginById returns the first match and the second
// would be a permanently unreachable shadow. Pure over its inputs (node-testable without the bundler glob);
// mutates `seen` only on accept.
export const acceptPlugin = (
  found: ButinPlugin,
  label: string,
  seen: Set<string>
): { ok: true } | { ok: false; reason: string } => {
  const id = found.meta.id

  if (id !== label) {
    return { ok: false, reason: `meta.id "${id}" must equal its folder name "${label}"` }
  }

  if (seen.has(id)) {
    return { ok: false, reason: `duplicate plugin id "${id}" (already loaded)` }
  }

  seen.add(id)

  return { ok: true }
}

// Import every discovered plugin in isolation, then publish the survivors (alphabetical by name) into the
// shared `plugins` array. Awaited once during app bootstrap, before any IPC handler can run. Returns the
// failures so the caller can surface a non-fatal notice.
export const loadPlugins = async (): Promise<{ loaded: number; failed: PluginLoadFailure[] }> => {
  const ok: ButinPlugin[] = []
  const failed: PluginLoadFailure[] = []
  const seen = new Set<string>()

  for (const [path, load] of Object.entries(loaders)) {
    const label = pluginLabel(path)

    try {
      const mod = await load()
      const found = Object.values(mod).find(isButinPlugin)

      if (!found) {
        failed.push({ path: label, reason: 'no ButinPlugin export found' })
        log.warn('plugins', `no ButinPlugin export found in ${path} — skipping`)
        continue
      }

      const verdict = acceptPlugin(found, label, seen)

      if (!verdict.ok) {
        failed.push({ path: label, reason: verdict.reason })
        log.warn('plugins', `rejected ${path}: ${verdict.reason}`)
        continue
      }

      ok.push(found)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)

      failed.push({ path: label, reason })
      log.error('plugins', `failed to load ${path} — skipping`, err)
    }
  }

  ok.sort((a, b) => a.meta.name.localeCompare(b.meta.name))
  plugins.length = 0
  plugins.push(...ok)
  loadFailures = failed

  return { loaded: ok.length, failed }
}

export const pluginById = (id: string): ButinPlugin | undefined => plugins.find((p) => p.meta.id === id)
