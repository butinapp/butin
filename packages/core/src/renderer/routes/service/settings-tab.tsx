import type { Ledger } from '@butinapp/shapes'
import type { VerifyResult } from '@butinapp/ui'
import { useLabels } from '@butinapp/ui/i18n'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import { toast } from 'sonner'

import type { ConnectionTest, PluginSummary } from '../../../shared/ipc.js'
import { phaseProgress, useJobProgress } from '../../use-job-progress.js'
import { usePluginConfigOptions } from '../../use-plugin-config-options.js'
import { usePluginState } from '../../use-plugin-state.js'

import type { useRefreshAll } from './use-refresh-all.js'

import { type ExtractAllProgressView, type PluginConfigFormProps, ServiceSettingsPanel } from '@/chrome'

// The body of the trailing Settings tab. Owns all per-service management state + IPC (test / disconnect /
// enable / refresh-all / extract-everything, plus the sessionless config form), and feeds the pure
// ServiceSettingsPanel. Reconnect (Magic Login) is owned by ServiceView and passed in so the disconnected
// banner and this tab share one mutation.
export const SettingsTabContainer = ({
  plugin,
  onReconnect,
  reconnecting,
  refreshAll,
  health,
  onHealthChange
}: {
  plugin: PluginSummary
  onReconnect: () => void
  reconnecting: boolean
  // Shared with the page's top-right "Refresh All" button (lifted to ServiceView) so both controls reflect
  // one in-flight state.
  refreshAll: ReturnType<typeof useRefreshAll>
  // Lifted to ServiceView so the header pill survives tab switches and reflects the last probe.
  health?: VerifyResult
  onHealthChange: (health: VerifyResult | undefined) => void
}) => {
  const t = useLabels()
  const qc = useQueryClient()
  const navigate = useNavigate()
  // The shared probe + its in-flight flag, so this tab's Test reads and animates identically to Management.
  const { test, isTesting } = usePluginState()
  const [busy, setBusy] = useState<'test' | 'disconnect' | 'eraseData' | 'move' | null>(null)
  // Per-secondary-session in-flight state (a backend with its own login), keyed by backend key.
  const [secondaryBusy, setSecondaryBusy] = useState<Record<string, boolean>>({})
  const [extractProgress, setExtractProgress] = useState<ExtractAllProgressView | undefined>(undefined)

  // Other profiles this service can move to — the active one is excluded (you can't move to where you are).
  const profilesQ = useQuery({ queryKey: ['profiles'], queryFn: () => window.butin.profiles.list() })
  const moveTargets = (profilesQ.data ?? []).filter((p) => !p.active).map((p) => ({ id: p.id, name: p.name }))

  // The service's data folder (for the Reveal action).
  const folderQ = useQuery({
    queryKey: ['serviceFolder', plugin.id],
    queryFn: () => window.butin.files.folderGet(plugin.id, 'service')
  })

  // The detail payload (mechanics + per-capability inventory + rollups), read from cached data only. Folder
  // footprint is a SEPARATE query (an async filesystem walk) so the page paints before its tiles resolve.
  const detailQ = useQuery({
    queryKey: ['serviceDetail', plugin.id],
    queryFn: () => window.butin.services.getServiceDetail(plugin.id)
  })
  const folderStatsQ = useQuery({
    queryKey: ['folderStats', plugin.id],
    queryFn: () => window.butin.services.getFolderStats(plugin.id)
  })

  // Developer mode gates the raw-ledger debug panel. Each capability's ledger is fetched lazily the first
  // time its row is expanded (the panel calls onLoadLedger only when nothing is cached for that id).
  const settingsQ = useQuery({ queryKey: ['settings'], queryFn: () => window.butin.settings.get() })
  const [ledgers, setLedgers] = useState<Record<string, Ledger | null>>({})
  const ledgerLoading = useRef<Set<string>>(new Set())

  const onLoadLedger = (capId: string): void => {
    if (capId in ledgers || ledgerLoading.current.has(capId)) {
      return
    }

    ledgerLoading.current.add(capId)
    void window.butin.reports.ledger(plugin.id, capId).then((l) => setLedgers((prev) => ({ ...prev, [capId]: l })))
  }

  useJobProgress(plugin.id, null, (p) => setExtractProgress(phaseProgress(p)))

  const extract = useMutation({
    mutationFn: () => window.butin.jobs.runExtractAll(plugin.id),
    onMutate: () => setExtractProgress(undefined),
    onSuccess: (res) => {
      setExtractProgress(undefined)

      if (res.ok) {
        // Save-everything writes files into the service folder → refresh the Files / On-disk tiles.
        void qc.invalidateQueries({ queryKey: ['folderStats', plugin.id] })
        toast.success(t.extractAllDone(res.data.tabCount, res.data.fileCount), {
          action: { label: t.openFolder, onClick: () => void window.butin.files.revealFolder('extracts', plugin.id) }
        })

        if (res.data.warnings.length > 0) {
          toast.error(`${res.data.warnings.length} ${t.docFailed}`)
        }
      } else {
        toast.error(res.error ?? t.fetchFailed)
      }
    },
    onError: () => setExtractProgress(undefined)
  })

  const onTest = async (): Promise<ConnectionTest> => {
    setBusy('test')

    try {
      // The shared probe writes the verdict (with the auth-vs-inconclusive nuance) + re-reads the plugin list
      // + pulses the dot everywhere; here we only surface the failure as a toast. The result feeds the Test
      // button's outcome flash + failure reason.
      const r = await test(plugin.id)

      if (!r.ok) {
        toast.error(r.error ?? t.fetchFailed)
      }

      return r
    } finally {
      setBusy(null)
    }
  }

  const onDisconnect = async (): Promise<void> => {
    setBusy('disconnect')

    try {
      await window.butin.services.disconnect(plugin.id)
      onHealthChange(undefined)
      // Drop any lingering Refresh-All checklist — a fetch progress (and its errors) for a session you just
      // disconnected is stale, and would otherwise sit on the page next to the reconnect banner.
      refreshAll.dismiss()
      void qc.invalidateQueries({ queryKey: ['plugins'] })
    } finally {
      setBusy(null)
    }
  }

  const onToggleEnabled = async (enabled: boolean): Promise<void> => {
    await window.butin.lifecycle.setEnabled(plugin.id, enabled)
    void qc.invalidateQueries({ queryKey: ['plugins'] })
  }

  // A backend with its own login (e.g. an admin host that's a separate session). Reconnect opens that
  // backend's Magic Login; both re-read `plugins` so its connected dot updates and drop the query cache so the
  // next refresh uses the new session.
  const withSecondaryBusy = async (key: string, run: () => Promise<unknown>): Promise<void> => {
    setSecondaryBusy((s) => ({ ...s, [key]: true }))

    try {
      await run()
      void window.butin.services.clearQueryCache(plugin.id)
      void qc.invalidateQueries({ queryKey: ['plugins'] })
    } finally {
      setSecondaryBusy((s) => ({ ...s, [key]: false }))
    }
  }

  const onSecondaryReconnect = (key: string): void =>
    void withSecondaryBusy(key, () => window.butin.services.magicLogin(plugin.id, key))
  const onSecondaryDisconnect = (key: string): void =>
    void withSecondaryBusy(key, () => window.butin.services.disconnect(plugin.id, key))
  const onSecondaryTest = async (key: string): Promise<ConnectionTest> => {
    let result: ConnectionTest = { ok: false, checkedAt: new Date().toISOString() }

    await withSecondaryBusy(key, async () => {
      const r = await window.butin.services.testConnection(plugin.id, key)
      const label = plugin.secondarySessions?.find((s) => s.key === key)?.label ?? key

      result = r

      if (r.ok) {
        toast.success(`${label}: ${t.testPassed}`)
      } else {
        toast.error(`${label}: ${r.error ?? t.fetchFailed}`)
      }
    })

    return result
  }

  // Erase cached tab data (reports + manifests); keeps the stored session + downloaded files.
  const onEraseData = async (): Promise<void> => {
    setBusy('eraseData')

    try {
      await window.butin.services.clearReports(plugin.id)
      void qc.invalidateQueries({ queryKey: ['report', plugin.id] })
      void qc.invalidateQueries({ queryKey: ['reportTimes', plugin.id] })
      void qc.invalidateQueries({ queryKey: ['serviceDetail', plugin.id] })
      void qc.invalidateQueries({ queryKey: ['folderStats', plugin.id] })
      void qc.invalidateQueries({ queryKey: ['overview'] })
      toast.success(t.dataErased)
    } finally {
      setBusy(null)
    }
  }

  // Remove the service from the roster entirely: core wipes its session/config/cached data, then we land on
  // Management (the empty service page would read as bare). Confirm is owned by the panel's armed button.
  const onUninstall = async (eraseFolder: boolean): Promise<void> => {
    await window.butin.lifecycle.uninstall(plugin.id, eraseFolder)
    void qc.invalidateQueries({ queryKey: ['plugins'] })
    void qc.invalidateQueries({ queryKey: ['overview'] })
    void navigate({ to: '/management' })
  }

  // Hand this service's stored state (stored session + config + cached data) to another profile, then leave — the
  // plugin is empty in this profile, so the Settings tab would look bare. Land on Management instead.
  const onMoveToProfile = async (targetProfileId: string): Promise<void> => {
    setBusy('move')

    try {
      const r = await window.butin.profiles.movePlugin(plugin.id, targetProfileId)

      if (r.ok) {
        const name = moveTargets.find((p) => p.id === targetProfileId)?.name ?? targetProfileId

        toast.success(t.moveDone(name))
        void qc.invalidateQueries({ queryKey: ['plugins'] })
        void qc.invalidateQueries({ queryKey: ['overview'] })
        void navigate({ to: '/management' })
      } else {
        toast.error(r.error)
      }
    } finally {
      setBusy(null)
    }
  }

  // Sessionless config form — folds in PluginConfigSheet's persist + probe wiring.
  const saveConfig = async (values: Record<string, string>): Promise<void> => {
    await window.butin.services.setConfig(plugin.id, values)
    // Editing the config invalidates the last probe — clear it so the header/dot don't show a stale red/green
    // against the just-saved values (the next Test or a successful fetch re-establishes it).
    onHealthChange(undefined)
    void qc.invalidateQueries({ queryKey: ['plugins'] })
    void qc.invalidateQueries({ queryKey: ['overview'] })
    toast.success(t.settingsSaved)
  }

  const testConfig = async (values: Record<string, string>): Promise<VerifyResult> => {
    await window.butin.services.setConfig(plugin.id, values)
    void qc.invalidateQueries({ queryKey: ['plugins'] })

    const r = await window.butin.services.testConnection(plugin.id)

    // Feed the SAME probe-aware verify store the session-plugin Test uses, so the header pill + sidebar dot +
    // this card's header all reflect the result — not just the form's inline line.
    onHealthChange({ ok: r.ok, error: r.error })

    return { ok: r.ok, error: r.error }
  }

  // Combobox config fields fetch their choices through the authed client + seed from the disk cache.
  const cfgOptions = usePluginConfigOptions(plugin)

  // Any plugin with declared config fields gets the form — not just sessionless ones. A session plugin can
  // still need settings (e.g. Groq's org id, which has no auto-detect endpoint): the panel renders the form
  // BELOW the Magic Login trio. `onTest` is wired for sessionless plugins (the form IS their connection);
  // session plugins test via the trio, so the panel drops the form's own Test button to avoid a duplicate.
  const configForm: PluginConfigFormProps | undefined =
    plugin.configFields.length > 0
      ? {
          fields: plugin.configFields,
          values: plugin.config,
          submitLabel: t.saveSettings,
          testLabel: t.test,
          onSubmit: (v) => void saveConfig(v),
          onTest: testConfig,
          ...cfgOptions
        }
      : undefined

  // The data inventory: prefer the detail payload's per-capability rows (records / history / spark); before
  // it loads, fall back to the bare capability list (zeros) so the table shape is stable. Labels localized.
  const inventory = (
    detailQ.data?.capabilities ??
    plugin.capabilities.map((c) => ({ id: c.id, label: c.label, recordCount: 0, snapshotCount: 0 }))
  ).map((c) => ({ ...c, label: t.s(c.label) }))

  // Refresh a single capability from its inventory row, then refresh the stats that depend on it.
  const onRefreshCapability = (capId: string): void => {
    void window.butin.services.runCapability(plugin.id, capId).then(() => {
      void qc.invalidateQueries({ queryKey: ['serviceDetail', plugin.id] })
      void qc.invalidateQueries({ queryKey: ['report', plugin.id] })
      void qc.invalidateQueries({ queryKey: ['reportTimes', plugin.id] })
      void qc.invalidateQueries({ queryKey: ['overview'] })
      // Drop the cached ledger so a re-expand (dev mode) refetches the just-appended history.
      ledgerLoading.current.delete(capId)
      setLedgers((prev) => {
        const { [capId]: _evicted, ...rest } = prev

        return rest
      })
    })
  }

  return (
    <ServiceSettingsPanel
      sessionless={plugin.sessionless}
      connected={plugin.connected}
      testing={isTesting(plugin.id)}
      enabled={plugin.enabled !== false}
      description={plugin.description}
      dashboardUrl={plugin.dashboardUrl}
      dashboardOpensInApp={!plugin.sessionless}
      inventory={inventory}
      recordCount={detailQ.data?.recordCount}
      lastSyncedAt={detailQ.data?.lastRunAt}
      folderStats={{
        pending: folderStatsQ.isLoading,
        fileCount: folderStatsQ.data?.fileCount,
        totalBytes: folderStatsQ.data?.totalBytes,
        documentCount: folderStatsQ.data?.documentCount
      }}
      mechanics={detailQ.data?.mechanics}
      onRefreshCapability={onRefreshCapability}
      onViewCapability={(capId) =>
        void navigate({ to: '/service/$serviceId/$tab', params: { serviceId: plugin.id, tab: capId } })
      }
      folderPath={folderQ.data}
      health={health}
      busy={{
        reconnect: reconnecting,
        test: busy === 'test',
        disconnect: busy === 'disconnect',
        refreshAll: refreshAll.isPending,
        eraseData: busy === 'eraseData',
        move: busy === 'move'
      }}
      extracting={extract.isPending}
      extractProgress={extractProgress}
      onReconnect={onReconnect}
      onTest={onTest}
      onDisconnect={() => void onDisconnect()}
      serviceName={plugin.name}
      secondarySessions={plugin.secondarySessions}
      secondaryBusy={secondaryBusy}
      onSecondaryReconnect={onSecondaryReconnect}
      onSecondaryTest={onSecondaryTest}
      onSecondaryDisconnect={onSecondaryDisconnect}
      onToggleEnabled={(v) => void onToggleEnabled(v)}
      onRefreshAll={() => refreshAll.mutate()}
      onExtract={() => extract.mutate()}
      onRevealFolder={() => void window.butin.files.revealFolder('service', plugin.id)}
      onEraseData={() => void onEraseData()}
      onOpenDashboard={() => {
        if (!plugin.dashboardUrl) {
          return
        }

        // A session plugin opens its dashboard INSIDE the captured session (browse mode); a sessionless
        // (external) plugin has no Butin session, so its dashboard just opens in the OS browser as before.
        if (plugin.sessionless) {
          void window.butin.shell.openExternal(plugin.dashboardUrl)
        } else {
          void window.butin.services.browse(plugin.id)
        }
      }}
      configForm={configForm}
      moveTargets={moveTargets}
      onMoveToProfile={(id) => void onMoveToProfile(id)}
      onUninstall={(eraseFolder) => void onUninstall(eraseFolder)}
      devMode={settingsQ.data?.devMode}
      ledgers={ledgers}
      onLoadLedger={onLoadLedger}
    />
  )
}
