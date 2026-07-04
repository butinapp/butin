import { useLabels } from '@butinapp/ui/i18n'
import { Button } from '@butinapp/ui/primitives'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createLazyRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'

import type { ConnectionTest } from '../../shared/ipc.js'
import { isPluginWideFailure } from '../refresh-policy.js'
import { usePluginState } from '../use-plugin-state.js'

import { SETTINGS_TAB_ID } from './route-helpers.js'

import { AvailableCatalog, ProvidersPage, type BulkProgress, type ProviderBusy, type ProviderView } from '@/chrome'

type RefreshSummary = { refreshed: number; needsReconnect: string[] }

// The Management page: every plugin's connection health + actions (Test / Connect / Disconnect / enable /
// Refresh data). Reads the plugin list itself and translates Open into router navigation.
const ManagementView = () => {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const t = useLabels()
  const { data: plugins = [] } = useQuery({ queryKey: ['plugins'], queryFn: () => window.butin.services.list() })
  const [busy, setBusy] = useState<ProviderBusy>(null)
  const { verdictOf, mark, connStateOf, isTesting, test } = usePluginState()

  // Bulk Test-all / Refresh-all progress + the refresh summary live in the query cache (not local state), so a
  // sweep kicked off here keeps reporting — the toolbar's "N of M" and the dot pulses survive leaving and
  // returning to this page. The async loop runs detached from the component and writes here regardless of what's
  // mounted; gcTime Infinity keeps the value across the unmount.
  const { data: bulkProgress = null } = useQuery<BulkProgress | null>({
    queryKey: ['bulkProgress'],
    queryFn: () => null,
    staleTime: Infinity,
    gcTime: Infinity
  })
  const setBulkProgress = (next: BulkProgress | null): void => void qc.setQueryData(['bulkProgress'], next)

  const { data: refreshSummary = null } = useQuery<RefreshSummary | null>({
    queryKey: ['refreshSummary'],
    queryFn: () => null,
    staleTime: Infinity,
    gcTime: Infinity
  })
  const setRefreshSummary = (next: RefreshSummary | null): void => void qc.setQueryData(['refreshSummary'], next)

  // Two axes: the Installed tab manages the roster (today's cards); Available lists the rest to install.
  const installedPlugins = plugins.filter((p) => p.installed)
  const availablePlugins = plugins.filter((p) => !p.installed)
  // The tab is DERIVED until the user picks one: Installed by default, falling to Available only once the
  // list has actually loaded with nothing installed (a fresh user / empty profile lands on the catalog).
  // Seeding from useState would race the async plugin query — empty at mount — and wrongly stick on Available.
  const [tabChoice, setTabChoice] = useState<'installed' | 'available' | null>(null)
  const tab = tabChoice ?? (plugins.length > 0 && installedPlugins.length === 0 ? 'available' : 'installed')
  const setTab = setTabChoice

  const providers: ProviderView[] = installedPlugins.map((p) => {
    const v = verdictOf(p.id)

    return {
      ...p,
      state: connStateOf(p),
      testError: v && !v.ok ? v.error : undefined,
      testing: isTesting(p.id),
      enabled: p.enabled
    }
  })

  const onTest = async (id: string): Promise<ConnectionTest> => {
    setBusy({ id, action: 'test' })

    try {
      return await test(id)
    } finally {
      setBusy(null)
    }
  }

  const onConnect = async (id: string): Promise<void> => {
    // Sessionless (`external`) plugins have no login to capture — Connect opens the service page's Settings
    // tab, whose inline config form is the ONE place external connections are configured (no separate drawer).
    if (plugins.find((p) => p.id === id)?.sessionless) {
      void navigate({ to: '/service/$serviceId/$tab', params: { serviceId: id, tab: SETTINGS_TAB_ID } })

      return
    }

    setBusy({ id, action: 'connect' })

    try {
      const r = await window.butin.services.magicLogin(id)

      if (r.ok) {
        // A fresh session is confirmed connected — clear any stale failure verdict (red dot + test error) the
        // same way the service page's Reconnect does, so the card flips to connected instead of staying red.
        mark(id, { ok: true })
        // Reconnecting one of the services the last sweep flagged makes its "N need reconnect" count wrong —
        // drop the summary so it can't linger with stale numbers.
        setRefreshSummary(null)
        void qc.invalidateQueries({ queryKey: ['plugins'] })
      } else if (r.canceled) {
        // Backing out of the login window isn't a failure — note it neutrally, don't alarm.
        toast.info(t.sessionCanceled)
      } else {
        toast.error(r.error ?? t.sessionNotCaptured)
      }
    } finally {
      setBusy(null)
    }
  }

  const onDisconnect = async (id: string): Promise<void> => {
    setBusy({ id, action: 'disconnect' })

    try {
      await window.butin.services.disconnect(id)
      mark(id, undefined)
      setRefreshSummary(null)
      void qc.invalidateQueries({ queryKey: ['plugins'] })
    } finally {
      setBusy(null)
    }
  }

  const onToggleEnabled = async (id: string, enabled: boolean): Promise<void> => {
    await window.butin.lifecycle.setEnabled(id, enabled)
    void qc.invalidateQueries({ queryKey: ['plugins'] })
  }

  // Install adds the plugin to the roster, then opens its service page — navigating there is what triggers
  // onboarding mode (the page renders the stepper while installed && !onboardedAt).
  const onInstall = async (id: string): Promise<void> => {
    await window.butin.lifecycle.install(id)
    void qc.invalidateQueries({ queryKey: ['plugins'] })
    void navigate({ to: '/service/$serviceId', params: { serviceId: id } })
  }

  // Runs a plugin's data capabilities, stopping early once one fails plugin-wide (a dead session, bad config, a
  // CF gate, a permission denial all hit every remaining capability identically). Returns the first failure so
  // the caller can surface it; null when nothing failed. Callers clear the query cache BEFORE this so the run
  // fetches fresh; the capabilities then dedupe shared endpoints against each other for the run.
  const refreshOne = async (id: string): Promise<{ error: string } | null> => {
    const plugin = plugins.find((p) => p.id === id)

    let failure: { error: string } | null = null

    for (const c of plugin?.capabilities ?? []) {
      const res = await window.butin.services.runCapability(id, c.id)

      if (!res.ok) {
        failure ??= { error: res.error }

        if (isPluginWideFailure(res.cause)) {
          break
        }
      }
    }

    return failure
  }

  const onRefresh = async (id: string): Promise<void> => {
    setBusy({ id, action: 'refresh' })

    try {
      // Honest single-card refresh: clear this plugin's query cache so its capabilities fetch fresh.
      await window.butin.services.clearQueryCache(id)
      const failure = await refreshOne(id)

      setRefreshSummary(null)
      void qc.invalidateQueries({ queryKey: ['overview'] })
      void qc.invalidateQueries({ queryKey: ['plugins'] })

      // A silent refresh that quietly reverts to "Refresh" reads as a no-op — surface the failure so the user
      // knows it didn't land (and why: a missing org id, a permission denial, a dead session).
      if (failure) {
        toast.error(`${plugins.find((p) => p.id === id)?.name ?? id}: ${failure.error}`)
      }
    } finally {
      setBusy(null)
    }
  }

  // Test-all sweeps the filtered set in small concurrent batches (fast, but not all N at once) with a live
  // "N of M" count on the toolbar button. Each probe goes through the shared `test()`, so every service in
  // flight pulses its dot wherever it's drawn (sidebar, card, header) and its verdict lands as it returns —
  // there's no per-card busy spinner because several run at once. One lightweight probe per service.
  const TEST_ALL_CONCURRENCY = 6

  const onTestAll = async (ids: string[]): Promise<void> => {
    let done = 0

    setBulkProgress({ kind: 'test', done: 0, total: ids.length })

    try {
      for (let i = 0; i < ids.length; i += TEST_ALL_CONCURRENCY) {
        await Promise.all(
          ids.slice(i, i + TEST_ALL_CONCURRENCY).map(async (id) => {
            await test(id)
            done += 1
            setBulkProgress({ kind: 'test', done, total: ids.length })
          })
        )
      }
    } finally {
      setBulkProgress(null)
    }
  }

  // Refresh-all sweeps the filtered set in small concurrent batches — several services in flight at once, each
  // service's own probe + capabilities still sequential within itself — with a live "N of M" count on the toolbar.
  // Like Test All, there's no per-card busy spinner because several run at once; each service pulses its dot via
  // the shared `test()` instead. Batched (not all N at once) to bound concurrent load on the machine and edges.
  const REFRESH_ALL_CONCURRENCY = 6

  const onRefreshAll = async (ids: string[]): Promise<void> => {
    let done = 0
    let refreshed = 0
    const needsReconnect: string[] = []

    setRefreshSummary(null)
    setBulkProgress({ kind: 'refresh', done: 0, total: ids.length })

    // One service, start to finish: clear up front so the probe runs against a clean cache and its read is reused
    // by the capabilities below (a probe hitting the same endpoint as a tab is fetched once, not twice). Then probe
    // via the shared `test()` (pulses the dot, same verdict semantics, re-reads the plugin list) — a dead session
    // lands in needsReconnect (its card already shows Reconnect), not a doomed fetch. No login windows in bulk.
    const refreshService = async (id: string): Promise<void> => {
      await window.butin.services.clearQueryCache(id)
      const probe = await test(id)

      if (!probe.ok) {
        needsReconnect.push(id)
      } else if ((await refreshOne(id)) === null) {
        // refreshOne stops early on a plugin-wide failure (bad config / permission / a session the probe didn't
        // catch), so a doomed service costs one request, not a full fan-out. Only a clean run counts as refreshed.
        refreshed += 1
      }

      done += 1
      setBulkProgress({ kind: 'refresh', done, total: ids.length })
    }

    try {
      for (let i = 0; i < ids.length; i += REFRESH_ALL_CONCURRENCY) {
        await Promise.all(ids.slice(i, i + REFRESH_ALL_CONCURRENCY).map(refreshService))
      }

      void qc.invalidateQueries({ queryKey: ['overview'] })
      void qc.invalidateQueries({ queryKey: ['plugins'] })
      setRefreshSummary({ refreshed, needsReconnect })
    } finally {
      setBulkProgress(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="font-display text-xl font-semibold tracking-tight">{t.navManagement}</h1>
      </div>
      <div className="flex items-center gap-1">
        <Button size="sm" variant={tab === 'installed' ? 'secondary' : 'ghost'} onClick={() => setTab('installed')}>
          {t.tabInstalled} ({installedPlugins.length})
        </Button>
        <Button size="sm" variant={tab === 'available' ? 'secondary' : 'ghost'} onClick={() => setTab('available')}>
          {t.tabAvailable} ({availablePlugins.length})
        </Button>
      </div>

      {tab === 'installed' ? (
        <ProvidersPage
          providers={providers}
          busy={busy}
          onOpen={(id) => void navigate({ to: '/service/$serviceId', params: { serviceId: id } })}
          onTest={onTest}
          onConnect={(id) => void onConnect(id)}
          onDisconnect={(id) => void onDisconnect(id)}
          onRefresh={(id) => void onRefresh(id)}
          onToggleEnabled={(id, enabled) => void onToggleEnabled(id, enabled)}
          onTestAll={(ids) => void onTestAll(ids)}
          onRefreshAll={(ids) => void onRefreshAll(ids)}
          refreshSummary={refreshSummary ?? undefined}
          onDismissSummary={() => setRefreshSummary(null)}
          bulkProgress={bulkProgress}
        />
      ) : (
        <AvailableCatalog plugins={availablePlugins} onInstall={(id) => void onInstall(id)} />
      )}
    </div>
  )
}

export const Route = createLazyRoute('/management')({ component: ManagementView })
