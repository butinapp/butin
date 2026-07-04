import { I18nProvider, useLabels } from '@butinapp/ui/i18n'
import { Button, ServiceIcon } from '@butinapp/ui/primitives'
import { ConnDot, connLabel, type ServiceTab, ServiceTabs } from '@butinapp/ui/shell'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, KeyRound, Loader2, Lock, LogIn, RefreshCw, Settings } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import type { PluginSummary } from '../../../shared/ipc.js'
import { buildOnboardingSteps } from '../../../shared/onboarding-steps.js'
import { useLocaleSetting } from '../../components/locale-provider.js'
import type { ConnState } from '../../connection.js'
import { usePluginState } from '../../use-plugin-state.js'
import { headerAction, SETTINGS_TAB_ID } from '../route-helpers.js'

import { CapabilityPanel } from './capability-panel.js'
import { OnboardingFlow } from './onboarding-flow.js'
import { SettingsTabContainer } from './settings-tab.js'
import { useFailureUi } from './use-failure-ui.js'
import { toProgressItems, useRefreshAll } from './use-refresh-all.js'

import { ErrorPanel, RefreshProgress } from '@/chrome'

// `state` is the honest, probe-aware connection state (see connState): green connected, blue unverified
// (session stored but unchecked this session — the default on relaunch), red disconnected/expired.
const ServiceHeading = ({ plugin, state, testing }: { plugin: PluginSummary; state: ConnState; testing: boolean }) => {
  const t = useLabels()

  return (
    <div className="flex items-center gap-3">
      <ServiceIcon id={plugin.id} icon={plugin.icon} name={plugin.name} color={plugin.color} size={28} />
      <div>
        <div className="flex items-center gap-2">
          <h1 className="font-display text-xl font-semibold tracking-tight">{plugin.name}</h1>
          <span className="text-muted-foreground inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px]">
            <ConnDot state={state} testing={testing} className="size-1.5" />
            {connLabel(t, state)}
          </span>
        </div>
      </div>
    </div>
  )
}

// The per-service page: one tab per capability, lazy-loaded on activation. Connection is handled INLINE
// here (Magic Login) — no jump to Data status. Cached reports always render (read from disk); the
// connection only governs whether a FRESH fetch can run, so a disconnected plugin still shows its last
// data and offers a reconnect banner instead of hiding everything.
export const ServiceView = ({
  plugin,
  activeTab,
  onSelectTab
}: {
  plugin: PluginSummary
  activeTab: string
  onSelectTab: (tab: string) => void
}) => {
  const t = useLabels()
  const { locale } = useLocaleSetting()
  const qc = useQueryClient()
  const tabId = activeTab || (plugin.capabilities[0]?.id ?? '')

  // Session-ephemeral probe result, shared (via the verify store) with the sidebar dot + the Settings card
  // so every connection indicator reads ONE source and never contradicts. On relaunch it's empty, so a
  // stored-but-unchecked session reads "unverified" instead of falsely "connected".
  const { verdictOf, mark, connStateOf, isTesting } = usePluginState()
  const health = verdictOf(plugin.id)
  const state = connStateOf(plugin)
  const testing = isTesting(plugin.id)
  const connected = plugin.connected
  const disabled = plugin.enabled === false

  // First-run onboarding: shown while the plugin is installed but not yet onboarded (no successful refresh
  // recorded). Skip leaves it installed-but-unonboarded — a Finish-setup banner persists and reopening resumes.
  const needsOnboarding = Boolean(plugin.installed) && plugin.onboardedAt == null
  const [onboardingSkipped, setOnboardingSkipped] = useState(false)
  const showOnboarding = needsOnboarding && !onboardingSkipped
  const onboardingSteps = buildOnboardingSteps({
    sessionless: plugin.sessionless,
    hasConfigFields: plugin.configFields.length > 0
  })

  // One Refresh-All mutation, shared by the page's top-right button and the Settings tab's control.
  const refreshAll = useRefreshAll(plugin)

  // Resolves a probe failure that left the session intact (404/500/…) into the shared ErrorPanel: the
  // cause's plain-language message + a dispatcher for each action (Retry re-runs the refresh).
  const failureUi = useFailureUi(plugin)

  // The header's single primary CTA: Refresh All while live, Reconnect (or Connect → Settings) when dead.
  const primaryAction = headerAction(state, plugin.sessionless)

  // Magic Login, shared by the disconnected banner and the Settings tab's Reconnect. A fresh session ⇒
  // confirmed connected.
  const connect = useMutation({
    mutationFn: () => window.butin.services.magicLogin(plugin.id),
    onSuccess: (r) => {
      if (r.ok) {
        mark(plugin.id, { ok: true })
        void qc.invalidateQueries({ queryKey: ['plugins'] })
      } else if (r.canceled) {
        toast.info(t.sessionCanceled)
      } else {
        toast.error(r.error ?? t.sessionNotCaptured)
      }
    }
  })

  // On first open of a service that isn't confirmed working AND has no cached data, land on the Settings tab
  // instead of a data tab. A data tab would auto-fire a fetch (below) that can't succeed on an unverified /
  // expired session — that "random refresh" is exactly what we want to avoid. The user verifies / reconnects
  // on Settings, then navigates to the data themselves. Decided once per service (the user can freely open
  // data tabs afterward); skipped while the overview is still loading so we don't redirect on a false empty.
  const tilesQ = useQuery({ queryKey: ['overview'], queryFn: () => window.butin.reports.overview() })
  const hasData = Boolean(tilesQ.data?.find((tile) => tile.pluginId === plugin.id)?.lastRunAt)
  const decidedRef = useRef<string | null>(null)

  useEffect(() => {
    // Onboarding owns the page while it's showing — don't redirect tabs underneath it.
    if (showOnboarding || decidedRef.current === plugin.id || tilesQ.isLoading) {
      return
    }

    decidedRef.current = plugin.id

    if (state !== 'connected' && !hasData && tabId !== SETTINGS_TAB_ID) {
      onSelectTab(SETTINGS_TAB_ID)
    }
  }, [plugin.id, tilesQ.isLoading, state, hasData, tabId, onSelectTab, showOnboarding])

  const dataTabs: ServiceTab[] = plugin.capabilities.map((c) => ({
    capability: c,
    body: (
      <CapabilityPanel
        plugin={plugin}
        capability={c}
        active={c.id === tabId}
        connected={connected}
        autoFetch={state === 'connected'}
      />
    )
  }))

  // The gear-marked Settings tab — same shape for every service, holds all management. Kept inline with the
  // data tabs (not floated to the right edge) so it's a short hop from them, not a trek across the window.
  const settingsTab: ServiceTab = {
    capability: { id: SETTINGS_TAB_ID, label: t.settingsTitle },
    icon: <Settings />,
    body: (
      <SettingsTabContainer
        plugin={plugin}
        onReconnect={() => connect.mutate()}
        reconnecting={connect.isPending}
        refreshAll={refreshAll}
        health={health}
        onHealthChange={(v) => mark(plugin.id, v)}
      />
    )
  }

  return (
    <I18nProvider locale={locale} messages={plugin.messages}>
      {/* The whole service page is one capped, centered column — header, banners, tab strip, and content all
          share the same width, so nothing (the title, Refresh All, the tab underline, the per-tab refresh)
          overhangs the data on a wide window. */}
      <div className="mx-auto w-full max-w-[110rem] space-y-4">
        <div className="flex items-start justify-between gap-3">
          <ServiceHeading plugin={plugin} state={state} testing={testing} />
          {/* Page-level primary action. While the session is live (or merely unverified) it's "Refresh All" —
            re-runs every data tab, mirrored by the Settings tab's control (one shared mutation). When the
            session is dead it morphs into Reconnect (or, for a sessionless plugin, Connect → its config form),
            so a failed refresh leaves a live next step in the same spot instead of a disabled dead end. Hidden
            entirely while the service is disabled or still onboarding (no data tabs exist to refresh yet). */}
          {!disabled && !showOnboarding ? (
            primaryAction === 'reconnect' ? (
              <Button size="sm" variant="outline" disabled={connect.isPending} onClick={() => connect.mutate()}>
                {connect.isPending ? <Loader2 className="animate-spin" /> : <LogIn />}
                {connect.isPending ? t.capturingSession : t.reconnect}
              </Button>
            ) : primaryAction === 'connect' ? (
              <Button size="sm" variant="outline" onClick={() => onSelectTab(SETTINGS_TAB_ID)}>
                <KeyRound /> {t.connect}
              </Button>
            ) : (
              <Button size="sm" disabled={refreshAll.isPending} onClick={() => refreshAll.mutate()}>
                {refreshAll.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                {t.refreshAll}
              </Button>
            )
          ) : null}
        </div>

        {showOnboarding ? (
          <OnboardingFlow
            plugin={plugin}
            state={state}
            steps={onboardingSteps}
            connect={connect}
            refreshAll={refreshAll}
            onSkip={() => setOnboardingSkipped(true)}
          />
        ) : (
          <>
            {disabled ? (
              <div className="text-muted-foreground flex items-center gap-2 rounded-md border p-2.5 text-xs">
                <Lock className="size-4 shrink-0" />
                <span>{t.serviceDisabledBanner}</span>
              </div>
            ) : state === 'disconnected' ? (
              // Why the service is disconnected — shown iff the honest state (the red dot) says so, so the banner
              // never contradicts the header pill. The action lives in the header's morphed primary button
              // (Reconnect / Connect), so this stays purely explanatory — one reconnect affordance, not two. Copy
              // is data-aware: a service with cached reports is showing its last data (not fetching a first one).
              <div className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs text-amber-600 dark:text-amber-300">
                <AlertTriangle className="size-4 shrink-0" />
                <span className="flex-1">
                  {plugin.lastRunAt ? t.disconnectedWithData(plugin.name) : t.connectPrompt(plugin.name)}
                </span>
              </div>
            ) : null}

            {/* Skipped onboarding but never finished — a quiet nudge back into the stepper. */}
            {needsOnboarding && onboardingSkipped ? (
              <div className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs text-amber-600 dark:text-amber-300">
                <AlertTriangle className="size-4 shrink-0" />
                <span className="flex-1">{t.finishSetup}</span>
                <Button size="xs" variant="outline" onClick={() => setOnboardingSkipped(false)}>
                  {t.finishSetup}
                </Button>
              </div>
            ) : null}

            {/* Live Refresh-All progress: visible while running, and lingers afterward if anything failed so
                the user can see which capability broke — with a dismiss button (only once it's no longer
                running) so the errored panel doesn't stay forever. */}
            {refreshAll.progress.length > 0 &&
            (refreshAll.isPending || refreshAll.progress.some((s) => s.status === 'error')) ? (
              <RefreshProgress
                items={toProgressItems(refreshAll.progress, plugin, t.s)}
                onDismiss={refreshAll.isPending ? undefined : refreshAll.dismiss}
              />
            ) : null}

            {/* A refresh that failed with the session still intact (404/500/permission): the cause + its
                actions inline, so "the org in Settings is wrong" is fixable on the spot. A dead session takes
                the header's Reconnect path instead and never lands here. */}
            {refreshAll.failure ? (
              <ErrorPanel
                cause={refreshAll.failure.cause}
                message={failureUi.message(refreshAll.failure.cause)}
                actions={refreshAll.failure.actions}
                details={refreshAll.failure.details}
                onAction={(a) => failureUi.dispatch(refreshAll.failure!.cause, a, () => refreshAll.mutate())}
              />
            ) : null}

            <ServiceTabs
              tabs={disabled ? [settingsTab] : [...dataTabs, settingsTab]}
              active={tabId}
              onSelect={onSelectTab}
            />
          </>
        )}
      </div>
    </I18nProvider>
  )
}
