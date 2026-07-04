import { type ButinPlugin, type CollectContext, type ConfigOption, type IncrementalCapability } from '@butinapp/sdk'
import { resolveCurrencies, validateCapabilityResult, type CapabilityResult } from '@butinapp/sdk/data'
import { splitResult, toDisplayResult } from '@butinapp/shapes'

import type { ConnectionTest } from '../../shared/ipc.js'
import { scheduleAlertEvaluation } from '../alerts/evaluate.js'
import { env } from '../env.js'
import { createLogger } from '../log.js'
import { isSpaSessionExpired } from '../session/spa-session.js'
import { accumulate, readLedger } from '../store/ledger.js'
import { backfillAccrualBars, projectCurrent } from '../store/project-ledger.js'
import { computeSince, mergeRawRows, readRawUnion, writeRawUnion } from '../store/raw-union.js'
import { clearCapabilityReports, readCache, saveCurrent, writeCache } from '../store/store.js'
import { wrapClearOnAuthError } from '../transport/client.js'

import { classifyFailure } from './failure-classifier.js'
import { buildContext, requireCapability, requirePlugin } from './plugin-context.js'
import { pluginById } from './plugins.js'

// Cache namespace (a ~/butin/<plugin>/ subfolder) for combobox config-field option lists.
const CONFIG_OPTIONS_NS = 'config-options'

// Trailing re-fetch window applied when an incremental capability declares none — fetch at least the last month
// each refresh so a recent row's update (a refund, a status change) is caught even when no newer row exists.
const DEFAULT_INCREMENTAL_WINDOW_DAYS = 30

// Run an incremental capability: derive `ctx.since` from the stored union (newest kept timestamp minus the
// re-fetch window), fetch only recent + new rows, merge them into the keyed union (retaining rows the service
// has dropped), persist it, and `build` over the FULL union so the result spans all history with correct
// totals. The fetch is wrapped like a collect so a 401 clears the session and re-prompts Sign in.
const fetchIncremental = async (
  plugin: ButinPlugin,
  inc: IncrementalCapability,
  pluginId: string,
  capabilityId: string,
  ctx: CollectContext
): Promise<CapabilityResult> => {
  const prior = (await readRawUnion(pluginId, capabilityId))?.rows ?? []
  const windowDays = inc.window?.days ?? DEFAULT_INCREMENTAL_WINDOW_DAYS

  ctx.since = computeSince(prior, inc.timestamp, windowDays, new Date().toISOString())

  const raw = await wrapClearOnAuthError(plugin, ctx.creds, () => inc.fetch(ctx))()
  // Bundle form: `raw` is `{ [listKey]: rows, ...other fields }` — union just the named sub-list.
  const fetchedRows = inc.listKey
    ? (((raw as Record<string, unknown>)[inc.listKey] as Record<string, unknown>[] | undefined) ?? [])
    : (raw as Record<string, unknown>[])
  const rows = mergeRawRows(prior, fetchedRows, inc.id)

  await writeRawUnion(pluginId, capabilityId, { key: inc.id, rows })

  // Bundle form: rebuild the bundle with the full-history union in place of the fetched sub-list before build.
  return inc.build(inc.listKey ? { ...(raw as object), [inc.listKey]: rows } : rows)
}

// Run one capability: build creds + authed client, fetch (incremental union/rebuild when the capability opts in,
// else a full collect()), persist the normalized report. A 401 during the fetch clears the cookie (via
// wrapClearOnAuthError) so the UI re-prompts login. `force` wipes the capability's accumulated data first so the
// run rebuilds from scratch (the per-tab "Refetch all history").
export const runCapability = async (
  pluginId: string,
  capabilityId: string,
  opts?: { force?: boolean }
): Promise<unknown> => {
  const plugin = requirePlugin(pluginId)
  const capability = requireCapability(plugin, capabilityId)

  if (!('collect' in capability)) {
    throw new Error(`capability ${pluginId}/${capabilityId} is not a collect capability (it's an export run)`)
  }

  if (opts?.force) {
    await clearCapabilityReports(pluginId, capabilityId)
  }

  const ctx = buildContext(plugin, capabilityId)
  const runLog = createLogger({ scope: 'run', plugin: pluginId, action: capabilityId })

  runLog.info('fetching…')

  let raw: CapabilityResult

  try {
    raw = capability.incremental
      ? await fetchIncremental(plugin, capability.incremental, pluginId, capabilityId, ctx)
      : ((await wrapClearOnAuthError(plugin, ctx.creds, () => capability.collect(ctx))()) as CapabilityResult)
  } catch (err) {
    // A failed fetch (a request timeout, a network drop, or a thrown parse/GraphQL error) otherwise leaves no
    // trace in the Logs view: the error travels back over IPC as the tab's failure state, and a timeout/network
    // throw never reaches the net layer's status-gated request log. Surface it here next to the "fetching…"
    // line, then rethrow so the IPC envelope behaviour is unchanged.
    runLog.error(`fetch failed: ${(err as Error).message}`)
    throw err
  }

  // Stamp the plugin's currency onto every money value that didn't declare one, so the stored report is
  // self-describing, then enforce the contract before anything touches the store.
  const report = resolveCurrencies(raw, plugin.reportingCurrency)
  const errors = validateCapabilityResult(report)

  if (errors.length > 0) {
    runLog.error(`contract violation: ${errors.join('; ')}`)

    // Either way the malformed report never reaches the store, Overview, or accumulation. Dev throws the raw
    // error so the author sees it; a packaged build throws a data-invalid-tagged error the renderer surfaces
    // as such while the last good cached report stays put.
    if (env.isDev) {
      throw new Error(`contract violation in ${pluginId}/${capabilityId}: ${errors.join('; ')}`)
    }

    const err = new Error('malformed data from this service') as Error & { dataInvalid?: boolean }

    err.dataInvalid = true
    throw err
  }

  const now = new Date().toISOString()
  const { datasets, summaries, manifest } = splitResult(report)

  // Append this fetch into the ledger (the source of truth), then cache the latest projection + manifest.
  await accumulate(pluginId, capabilityId, { capturedAt: now, datasets, summaries })

  const led = await readLedger(pluginId, capabilityId)
  // Keyed datasets render from the accumulated ledger; unkeyed datasets keep this fetch's rows verbatim.
  const current = led ? projectCurrent(led) : new Map<string, { id: string; rows: Record<string, unknown>[] }>()
  const projected = datasets.map((d) => {
    const proj = current.get(d.id)

    return proj ? { ...d, rows: proj.rows } : d
  })
  // Fill an arrears service's not-yet-invoiced months (just-closed + current) from the accrual peaks captured in
  // the ledger, so the spend chart + Overview show the month's spend when it's observed, not when the invoice lands.
  const projectedDatasets = backfillAccrualBars(projected, summaries, manifest, led)

  await saveCurrent(pluginId, capabilityId, { datasets: projectedDatasets, summaries, manifest })
  runLog.info('done, ledger + current cache written')

  // A refresh updated the ledger — (re)evaluate alerts once the batch settles (debounced).
  scheduleAlertEvaluation()

  // The display value is a full CapabilityResult reconstructed from the projected data + the manifest.
  return toDisplayResult(projectedDatasets, summaries, manifest)
}

// Fetch a `combobox` config field's choices through the plugin's authed client — the orgs/projects/accounts
// you actually belong to, so the settings UI can offer a real pick instead of a blind id field. Runs on the
// same authed context a collector gets; a 401 clears the stored session (wrapClearOnAuthError) so the UI re-prompts.
// The fetched list is PERSISTED (like a report) so the picker shows it with no network on relaunch — kept
// until this fetch is run again. Throws when the field isn't a combobox with loadOptions; the caller wraps it.
export const listConfigOptions = async (pluginId: string, fieldKey: string): Promise<ConfigOption[]> => {
  const plugin = requirePlugin(pluginId)
  const field = (plugin.config?.fields ?? []).find((f) => f.key === fieldKey)

  if (!field?.loadOptions) {
    throw new Error(`config field ${pluginId}/${fieldKey} has no loadOptions`)
  }

  const ctx = buildContext(plugin, '__config')
  const options = await wrapClearOnAuthError(plugin, ctx.creds, () => field.loadOptions!(ctx))()

  await writeCache(pluginId, CONFIG_OPTIONS_NS, fieldKey, options)

  return options
}

// The disk-cached options for a field (no network), so the picker renders the last-fetched list — and the
// pinned choice by name — on startup. null when never fetched.
export const getCachedConfigOptions = async (pluginId: string, fieldKey: string): Promise<ConfigOption[] | null> => {
  const envelope = await readCache<ConfigOption[]>(pluginId, CONFIG_OPTIONS_NS, fieldKey)

  return envelope?.data ?? null
}

// Test a provider's connection: run its lightweight probe (one cheap authed request). A throw
// (401/network/etc.) → { ok: false } so the providers page can flag it for reconnect. With a
// `backendKey`, test that secondary backend's OWN login instead (its `probe` against its bound client).
export const testConnection = async (pluginId: string, backendKey?: string): Promise<ConnectionTest> => {
  const checkedAt = new Date().toISOString()
  const plugin = pluginById(pluginId)

  if (!plugin) {
    return { ok: false, error: `unknown plugin: ${pluginId}`, checkedAt }
  }

  const ctx = buildContext(plugin, 'probe')
  const backend = backendKey ? plugin.backends?.[backendKey] : undefined

  if (backendKey && !backend) {
    return { ok: false, error: `unknown backend '${backendKey}' for ${plugin.meta.id}`, checkedAt }
  }

  // The status set that means "this session is dead, re-login fixes it" — the backend's own when testing a
  // secondary login, the plugin's otherwise.
  const clearOn = (backend ? backend.auth.clearOnStatuses : plugin.auth.clearOnStatuses) ?? [401]

  const probe = backend
    ? async () => {
        if (!backend.probe) {
          throw new Error(`${backend.label ?? backendKey} has no connection test`)
        }

        await backend.probe(ctx.clientFor(backendKey!))
      }
    : () => plugin.probe(ctx)

  try {
    // The primary probe auto-clears the stored cookie on an auth-rejection status (re-prompts Sign in); a
    // secondary backend has no such per-field wiring, so it runs direct and the user reconnects its row.
    await (backend ? probe() : wrapClearOnAuthError(plugin, ctx.creds, () => probe())())

    return { ok: true, checkedAt }
  } catch (err) {
    // Distinguish a dead session (an auth-rejection status — re-login fixes it) from a non-auth miss (404
    // missing endpoint, 500, network — the session was accepted, so re-login wouldn't help). The renderer
    // drops back to Sign in only on the former; the latter just surfaces the error.
    const status = (err as { status?: number }).status
    // A dead session is either a clearing status (typically 401) or a status-less spa-bearer expiry — both
    // drop the renderer to Reconnect. A non-auth miss (404/500/network) leaves the session intact.
    const sessionExpired = isSpaSessionExpired(err)
    const authFailed = sessionExpired || (status !== undefined && clearOn.includes(status))

    // Classify the same way a failed capability fetch is — so the probe failure carries the structured
    // cause + actions (e.g. a 404 on a configured plugin → config-invalid → "Edit settings" + its hint).
    const { cause, actions } = classifyFailure({
      status,
      sessionExpired,
      message: (err as Error).message,
      requiresBrowserEngine: (backend?.transport ?? plugin.transport)?.requiresBrowserEngine,
      clearOnStatuses: clearOn,
      hasConfigFields: (plugin.config?.fields?.length ?? 0) > 0
    })

    return { ok: false, error: (err as Error).message, checkedAt, status, authFailed, cause, actions }
  }
}
