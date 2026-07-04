import type { TroubleshootingAction, TroubleshootingCause } from '@butinapp/sdk'
import type { VerifyResult } from '@butinapp/ui'
import { useLabels } from '@butinapp/ui/i18n'
import { Button } from '@butinapp/ui/primitives'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2, LogIn, RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import type { PluginSummary } from '../../../shared/ipc.js'
import type { OnboardingStepId } from '../../../shared/onboarding-steps.js'
import type { ConnState } from '../../connection.js'
import { usePluginConfigOptions } from '../../use-plugin-config-options.js'

import { useFailureUi } from './use-failure-ui.js'
import { toProgressItems, type useRefreshAll } from './use-refresh-all.js'

import { ErrorPanel, OnboardingStepper, type OnboardingStepView, PluginConfigForm, RefreshProgress } from '@/chrome'

// First-run onboarding: a guided stepper (Sign in → Settings → First fetch) shown while a plugin is
// installed but not yet onboarded. Each step's body is owned here; the pure OnboardingStepper just draws
// status + the active body. Completion (first successful refresh) stamps onboardedAt and the parent flips to
// the normal tabbed view.
export const OnboardingFlow = ({
  plugin,
  state,
  steps,
  connect,
  refreshAll,
  onSkip
}: {
  plugin: PluginSummary
  // The honest connection state. Sign-in counts as done once a session is STORED (green connected OR blue
  // unverified) — re-capturing a still-stored session each launch just to turn the dot green is exactly the
  // friction to avoid; First fetch is what verifies it. Only a missing / confirmed-dead session (red) re-opens
  // Sign in.
  state: ConnState
  steps: OnboardingStepId[]
  connect: { mutate: () => void; isPending: boolean }
  refreshAll: ReturnType<typeof useRefreshAll>
  onSkip: () => void
}) => {
  const t = useLabels()
  const qc = useQueryClient()
  const fail = useFailureUi(plugin)
  // Same combobox option loading as the Settings tab, so the org picker fills (and auto-detects) here too.
  const cfgOptions = usePluginConfigOptions(plugin)
  // Settings is the only step whose completion isn't a live signal — the user clicks Continue. (Reset on
  // service switch is handled by keying ServiceView on plugin.id, so this never leaks across plugins.)
  const [settingsDone, setSettingsDone] = useState(false)
  const [refreshError, setRefreshError] = useState<{
    cause: TroubleshootingCause
    actions: TroubleshootingAction[]
  } | null>(null)

  const meta: Record<OnboardingStepId, { title: string; blurb: string }> = {
    'sign-in': { title: t.onboardingSignInTitle, blurb: t.onboardingSignInBlurb },
    settings: { title: t.onboardingSettingsTitle, blurb: t.onboardingSettingsBlurb },
    'first-refresh': { title: t.onboardingRefreshTitle, blurb: t.onboardingRefreshBlurb }
  }

  // Completion is derived from REAL state, never a free cursor: sign-in is done once a session is stored (green
  // OR blue) — only a missing/expired one (red) re-opens it, so a relaunch with a live stored session goes
  // straight to First fetch instead of forcing a re-login; settings once the user continues; first-refresh
  // completes by unmounting the flow.
  const isDone = (id: OnboardingStepId): boolean =>
    id === 'sign-in' ? state !== 'disconnected' : id === 'settings' ? settingsDone : false

  // Where the flow would resume on its own: the first step that isn't done.
  const naturalActiveId = steps.find((id) => !isDone(id)) ?? steps[steps.length - 1]
  const naturalIdx = steps.indexOf(naturalActiveId)

  // The user can step BACK to re-run an earlier (already-done) step — re-run Sign in from Settings, edit
  // Settings from First fetch. `override` holds that choice while it points at a reachable step (anything up
  // to where the flow would naturally resume); progressing past it drops back to the natural step.
  const [override, setOverride] = useState<OnboardingStepId | null>(null)
  const overrideValid = override != null && steps.indexOf(override) <= naturalIdx
  const activeId = overrideValid ? override! : naturalActiveId

  // After a re-triggered Sign in finishes (the Magic Login window closes), release the override so the flow
  // resumes where it left off instead of sitting on the completed Sign in step.
  const wasConnecting = useRef(false)

  useEffect(() => {
    if (wasConnecting.current && !connect.isPending && override === 'sign-in') {
      setOverride(null)
    }

    wasConnecting.current = connect.isPending
  }, [connect.isPending, override])

  const stepViews: OnboardingStepView[] = steps.map((id) => ({
    id,
    title: meta[id].title,
    blurb: meta[id].blurb,
    status: id === activeId ? 'active' : isDone(id) ? 'done' : 'pending',
    // Reachable = anything up to and including where the flow would resume; the active step itself isn't a
    // jump target. Selecting the natural step clears the override (a way back to "where I was").
    selectable: steps.indexOf(id) <= naturalIdx && id !== activeId
  }))

  const onStepSelect = (id: string): void => setOverride(id === naturalActiveId ? null : (id as OnboardingStepId))

  const saveConfig = async (values: Record<string, string>): Promise<VerifyResult> => {
    await window.butin.services.setConfig(plugin.id, values)
    void qc.invalidateQueries({ queryKey: ['plugins'] })

    // Probe with the just-saved config BEFORE advancing — a bad value is caught (and shown inline on the form)
    // here, instead of slipping through to First fetch, failing there, and bouncing the user back to edit.
    const probe = await window.butin.services.testConnection(plugin.id)

    if (!probe.ok) {
      return probe
    }

    setSettingsDone(true)
    // Continuing past Settings releases any back-navigation so the flow advances to First fetch — and wipes
    // the previous First-fetch attempt (its error + per-capability checklist), since the new config makes
    // that stale result no longer the truth.
    setOverride(null)
    setRefreshError(null)
    refreshAll.dismiss()

    return probe
  }

  const runFirstRefresh = async (): Promise<void> => {
    setRefreshError(null)

    const res = await refreshAll.mutateAsync()

    // On success, refreshAll stamps onboardedAt + invalidates the plugins query → the parent drops this flow.
    // We only surface misses here. A failed probe carries its classified cause + actions (a 404 on a
    // configured plugin ⇒ config-invalid ⇒ "Edit settings" + the plugin's hint; a dead session ⇒ reconnect);
    // a fetch that failed past a passing probe is a generic retry. Neither silently bounces back to Sign in.
    if (res.probeFailed) {
      setRefreshError({
        cause: res.cause ?? (res.sessionDead ? 'session-expired' : 'unknown'),
        actions: res.actions ?? (res.sessionDead ? ['reconnect', 'retry'] : ['retry'])
      })
    } else if (!res.anyOk) {
      setRefreshError({ cause: 'unknown', actions: ['retry'] })
    }
  }

  const activeBody =
    activeId === 'sign-in' ? (
      <Button size="sm" disabled={connect.isPending} onClick={() => connect.mutate()}>
        {connect.isPending ? <Loader2 className="animate-spin" /> : <LogIn />}
        {connect.isPending ? t.capturingSession : t.connect}
      </Button>
    ) : activeId === 'settings' ? (
      <PluginConfigForm
        fields={plugin.configFields}
        values={plugin.config}
        submitLabel={t.onboardingContinue}
        // Continue accepts the (often auto-detected) config and advances — it must not be gated on the
        // value having changed, only on required fields being filled. Returning the probe lets the form hold
        // on Settings and show the error inline when the saved config can't connect.
        requireDirty={false}
        onSubmit={saveConfig}
        {...cfgOptions}
      />
    ) : (
      <div className="space-y-2">
        <Button size="sm" disabled={refreshAll.isPending || !plugin.connected} onClick={() => void runFirstRefresh()}>
          {refreshAll.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          {t.onboardingRefreshTitle}
        </Button>
        {refreshAll.progress.length > 0 ? (
          <RefreshProgress items={toProgressItems(refreshAll.progress, plugin, t.s)} />
        ) : null}
        {refreshError ? (
          <ErrorPanel
            cause={refreshError.cause}
            message={fail.message(refreshError.cause)}
            actions={refreshError.actions}
            onAction={(a) => fail.dispatch(refreshError.cause, a, () => void runFirstRefresh())}
          />
        ) : null}
      </div>
    )

  return (
    <OnboardingStepper
      steps={stepViews}
      activeBody={activeBody}
      activeBusy={connect.isPending || refreshAll.isPending}
      onStepSelect={onStepSelect}
      onSkip={onSkip}
    />
  )
}
