import type { TroubleshootingAction, TroubleshootingCause } from '@butinapp/sdk'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import type { PluginSummary } from '../../../shared/ipc.js'
import { isPluginWideFailure } from '../../refresh-policy.js'
import { usePluginState } from '../../use-plugin-state.js'

import { type RefreshProgressItem, type RefreshStepStatus } from '@/chrome'

// One row of live Refresh-All progress: a data capability + how its fetch is going. Drives the per-capability
// checklist so a failure shows exactly which part broke.
type RefreshStep = { id: string; status: RefreshStepStatus; error?: string }

// A probe-level failure where the SESSION is intact (404/500/network/permission) — the org/team in Settings is
// wrong, or the service is down. Surfaced as an ErrorPanel with cause-appropriate actions, not a toast. A dead
// session is NOT a RefreshFailure: it's carried by the header's Reconnect morph + the red connection dot.
type RefreshFailure = { cause: TroubleshootingCause; actions: TroubleshootingAction[]; details?: string }

// The 'summary' capability aggregates across the others, so it reads best against the freshest cache — order
// it last in the refresh-all batch (both the checklist and the run loop) so the per-tab data lands first and
// the summary fills in once everything else is home.
const refreshOrder = <T extends { id: string }>(caps: readonly T[]): T[] => [
  ...caps.filter((c) => c.id !== 'summary'),
  ...caps.filter((c) => c.id === 'summary')
]

// Refresh every data tab at once via runCapability. Drives the page's top-right "Refresh All" + the Settings
// tab's "Refresh all tabs" (one shared mutation); each data tab's own Refresh stays manual + single-tab.
// Sequential so the plugin's own short-TTL fetch cache (e.g. Vercel) can dedupe overlap.
export const useRefreshAll = (plugin: PluginSummary) => {
  const qc = useQueryClient()
  const { mark } = usePluginState()
  const [progress, setProgress] = useState<RefreshStep[]>([])
  const [failure, setFailure] = useState<RefreshFailure | null>(null)

  const patch = (id: string, next: Partial<RefreshStep>): void =>
    setProgress((prev) => prev.map((s) => (s.id === id ? { ...s, ...next } : s)))

  const mutation = useMutation({
    // Seed the checklist with every capability as pending the instant the gesture starts — BEFORE the cache
    // clear + probe — so the progress box appears immediately instead of after the (multi-second) probe. Clear
    // any prior failure panel too: this run is the retry.
    onMutate: () => {
      setFailure(null)
      setProgress(refreshOrder(plugin.capabilities).map((c) => ({ id: c.id, status: 'pending' })))
    },
    mutationFn: async () => {
      // Clear the query cache up front so the whole gesture is an honest refresh: the liveness probe below
      // runs against a clean cache, and its read is REUSED by the capabilities (a probe that hits the same
      // endpoint as a tab is fetched once for the batch, not twice). Capabilities also dedupe shared
      // endpoints against each other for the rest of the run.
      await window.butin.services.clearQueryCache(plugin.id)

      // Lightweight probe first: a dead session should surface "Reconnect", not a storm of doomed fetches.
      // `sessionDead` is only true for an auth-rejection (clearOnStatuses) — a 404/500/network probe miss
      // leaves the session intact, so it must NOT bounce the user back to Sign in.
      const probe = await window.butin.services.testConnection(plugin.id)

      // A DEAD session (auth rejection) stops the batch here — surface Reconnect rather than storming the rest
      // with fetches that will all 401. A NON-AUTH probe miss (404/500/parse/network) leaves the session intact,
      // so it must NOT sink the whole service: one capability whose endpoint is broken shouldn't blank the
      // others (or mislabel a reachable service "couldn't reach"). Fall through and let each capability stand on
      // its own success/failure — the per-capability checklist shows which broke.
      if (!probe.ok && probe.authFailed === true) {
        return {
          anyOk: false,
          probeFailed: true,
          sessionDead: true,
          cause: probe.cause as TroubleshootingCause | undefined,
          actions: probe.actions as TroubleshootingAction[] | undefined,
          error: probe.error
        }
      }

      const dataCaps = refreshOrder(plugin.capabilities)

      let anyOk = false

      for (const c of dataCaps) {
        patch(c.id, { status: 'running' })

        const r = await window.butin.services.runCapability(plugin.id, c.id)

        if (r.ok) {
          anyOk = true
          patch(c.id, { status: 'done' })
          continue
        }

        patch(c.id, { status: 'error', error: r.error })

        // A plugin-wide failure (dead session, bad config, a CF gate, a permission denial) hits every remaining
        // capability identically — stop rather than fire the doomed remainder against the same broken cause.
        if (isPluginWideFailure(r.cause)) {
          break
        }

        // A failure that cleared the stored session (401 via clearOnStatuses) means the session died mid-run —
        // stop so we don't spam the rest. A non-fatal single-tab error (500/parse) keeps going.
        const live = await window.butin.services.list()

        if (!live.find((p) => p.id === plugin.id)?.connected) {
          break
        }
      }

      return {
        anyOk,
        probeFailed: false,
        sessionDead: false,
        cause: undefined as TroubleshootingCause | undefined,
        actions: undefined as TroubleshootingAction[] | undefined,
        error: undefined as string | undefined
      }
    },
    onSuccess: (result) => {
      if (result.probeFailed) {
        if (result.sessionDead) {
          // Dead session ⇒ red dot ⇒ the header morphs to Reconnect (headerAction keys on the verdict). No
          // failure panel — that would be a second, redundant reconnect affordance.
          mark(plugin.id, { ok: false, error: result.error })
        } else {
          // A non-auth probe miss (404/500/network): the session was accepted, so keep the connection as-is and
          // surface the cause in an inline ErrorPanel with its own actions (Edit settings / Open dashboard /
          // Retry) — far more actionable than a transient toast that drops the org/team-is-wrong hint on dismiss.
          setFailure({
            cause: result.cause ?? 'unknown',
            actions: result.actions ?? ['retry'],
            details: result.error
          })
        }
      } else if (result.anyOk) {
        mark(plugin.id, { ok: true }) // a successful fetch confirms the session works

        // The first successful refresh — via ANY path (onboarding's button, the page Refresh-All, the
        // Settings tab) — completes onboarding. Stamping it here, not only in the onboarding flow, keeps a
        // normally-refreshed service from nagging "Finish setup". A partial success (some caps errored) still
        // counts: data came home, so the first-run flow is done.
        if (plugin.onboardedAt == null) {
          void window.butin.lifecycle.markOnboarded(plugin.id)
        }
      }

      // A 401 may have cleared the stored session mid-loop — re-read so the header/sidebar reflect the dead session
      // (and pick up the onboardedAt stamp above so the onboarding flow / Finish-setup banner clears).
      void qc.invalidateQueries({ queryKey: ['plugins'] })
      void qc.invalidateQueries({ queryKey: ['report', plugin.id] })
      void qc.invalidateQueries({ queryKey: ['reportTimes', plugin.id] })
      void qc.invalidateQueries({ queryKey: ['serviceDetail', plugin.id] })
      void qc.invalidateQueries({ queryKey: ['folderStats', plugin.id] })
      void qc.invalidateQueries({ queryKey: ['overview'] })
    }
  })

  const dismiss = (): void => {
    setProgress([])
    setFailure(null)
  }

  return Object.assign(mutation, { progress, failure, dismiss })
}

// Map raw Refresh-All progress to the renderer's checklist items, resolving each capability's (possibly
// plugin-domain) label through the active locale.
export const toProgressItems = (
  progress: { id: string; status: RefreshStepStatus; error?: string }[],
  plugin: PluginSummary,
  s: (text: string) => string
): RefreshProgressItem[] =>
  progress.map((p) => ({
    id: p.id,
    label: s(plugin.capabilities.find((c) => c.id === p.id)?.label ?? p.id),
    status: p.status,
    error: p.error
  }))
