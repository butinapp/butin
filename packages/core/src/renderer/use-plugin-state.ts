import type { VerifyResult } from '@butinapp/ui'
import type { ConnState } from '@butinapp/ui/shell'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'

import type { ConnectionTest } from '../shared/ipc.js'

import { connState } from './connection.js'

// Everything known about a service's connection right now, keyed by plugin id — ONE store, one React Query
// key, persisted to localStorage. Each plugin's state has two facets:
//   verdict — the last probe outcome (a Test / Reconnect / successful fetch). Asymmetric persistence: only a
//             DEAD verdict (ok:false) survives a relaunch, so a service we last saw fail stays red on reopen
//             (incl. sessionless plugins, whose absent session wouldn't otherwise signal it). A success is
//             session-ephemeral — it decays to "unverified" (blue) on relaunch and is re-confirmed each launch.
//   testing — a probe is in flight right now. A live, ephemeral state (never persisted) that animates the dot
//             everywhere the service is drawn while it's being tested.
export type PluginState = { verdict?: VerifyResult; testing?: boolean }
export type PluginStateMap = Record<string, PluginState>

const STORAGE_KEY = 'butin-plugin-state'
const KEY = ['plugin-state']

// The persisted shape: the failure verdicts only, `{ <pluginId>: { error? } }`. Plugin state is disposable —
// anything that doesn't match this schema (an old/corrupt blob) is thrown away and the store resets to empty.
export const persistedSchema = z.record(z.string(), z.object({ error: z.string().optional() }))
type PersistedFailures = z.infer<typeof persistedSchema>

// Pure transforms (fixture-tested), split from the localStorage I/O below.
// Only DEAD verdicts persist — a success decays out so green → blue on reopen.
export const toPersisted = (map: PluginStateMap): PersistedFailures => {
  const out: PersistedFailures = {}

  for (const [id, s] of Object.entries(map)) {
    if (s.verdict && !s.verdict.ok) {
      out[id] = s.verdict.error === undefined ? {} : { error: s.verdict.error }
    }
  }

  return out
}

export const fromPersisted = (failures: PersistedFailures): PluginStateMap => {
  const out: PluginStateMap = {}

  for (const [id, f] of Object.entries(failures)) {
    out[id] = { verdict: { ok: false, error: f.error } }
  }

  return out
}

const loadState = (): PluginStateMap => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)

    return raw ? fromPersisted(persistedSchema.parse(JSON.parse(raw))) : {}
  } catch {
    return {} // unreadable / unparseable / schema-mismatched — reset (plugin state is disposable)
  }
}

const saveState = (map: PluginStateMap): void => {
  try {
    const failures = toPersisted(map)

    if (Object.keys(failures).length === 0) {
      localStorage.removeItem(STORAGE_KEY)
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(failures))
    }
  } catch {
    // localStorage unavailable (tests / SSR) — the in-memory store still drives this session
  }
}

// The single per-plugin status hook. Owns the one shared store + its writer + the ONE probe path, and exposes
// the resolvers every status surface reads (sidebar dot, header pill, Management card, Connection settings
// card) so they can never drift: connStateOf for the color, isTesting for the animation, verdictOf for the
// last error. Returns resolvers because the sidebar and Management map over many services in one render.
export const usePluginState = (): {
  connStateOf: (plugin: { id: string; connected: boolean }) => ConnState
  verdictOf: (pluginId: string) => VerifyResult | undefined
  isTesting: (pluginId: string) => boolean
  mark: (pluginId: string, verdict: VerifyResult | undefined) => void
  test: (pluginId: string) => Promise<ConnectionTest>
} => {
  const qc = useQueryClient()
  const { data: store = {} } = useQuery<PluginStateMap>({
    queryKey: KEY,
    queryFn: loadState,
    staleTime: Infinity,
    gcTime: Infinity
  })

  // The one writer: merge a patch into a plugin's entry (null drops it), persist, return the next map.
  const patch = (pluginId: string, next: Partial<PluginState> | null): void => {
    qc.setQueryData<PluginStateMap>(KEY, (prev) => {
      const map = { ...(prev ?? {}) }

      if (next === null) {
        delete map[pluginId]
      } else {
        map[pluginId] = { ...map[pluginId], ...next }
      }

      saveState(map)

      return map
    })
  }

  const connStateOf = (plugin: { id: string; connected: boolean }): ConnState =>
    connState(plugin, store[plugin.id]?.verdict)
  const verdictOf = (pluginId: string): VerifyResult | undefined => store[pluginId]?.verdict
  const isTesting = (pluginId: string): boolean => store[pluginId]?.testing === true

  // Record a probe verdict (a Test / Reconnect / successful fetch); undefined clears it back to unverified.
  const mark = (pluginId: string, verdict: VerifyResult | undefined): void => patch(pluginId, { verdict })

  // The ONE probe path every surface uses, so Management and the service Settings test identically: flag the
  // plugin as testing (pulses its dot wherever it's drawn), run the probe, write the verdict. A pass or an
  // auth-rejection (confirmed dead) sets the verdict; a non-auth miss (404/500/network) stays unverified — the
  // session was still accepted. The probe may clear an expired session (clearOnStatuses), so re-read the
  // plugin list. Returns the raw result for the caller's own toast/branching.
  const test = async (pluginId: string): Promise<ConnectionTest> => {
    patch(pluginId, { testing: true })

    try {
      const r = await window.butin.services.testConnection(pluginId)

      patch(pluginId, { verdict: r.ok || r.authFailed ? { ok: r.ok, error: r.error } : undefined })
      void qc.invalidateQueries({ queryKey: ['plugins'] })

      return r
    } finally {
      patch(pluginId, { testing: false })
    }
  }

  return { connStateOf, verdictOf, isTesting, mark, test }
}
