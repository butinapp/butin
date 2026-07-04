import type { TroubleshootingAction, TroubleshootingCause } from '@butinapp/sdk'
import type { CapabilityView, DailyPoint } from '@butinapp/shapes'
import {
  DashboardRenderer,
  type FileDownloadStatus,
  findCumulativeColumn,
  type TableFilesBridge
} from '@butinapp/ui/dashboard'
import { useLabels } from '@butinapp/ui/i18n'
import { Skeleton } from '@butinapp/ui/primitives'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import type { LocatedFile, PluginSummary } from '../../../shared/ipc.js'
import { useDocFolder, useJobProgress } from '../../use-job-progress.js'
import { usePluginState } from '../../use-plugin-state.js'
import { useTablePrefs } from '../../use-table-prefs.js'

import { useFailureUi } from './use-failure-ui.js'

import { ErrorPanel, ServicePageShell } from '@/chrome'

// Stable empty default for the daily-spend query, so an absent series doesn't hand the chart a fresh array each render.
const EMPTY_DAILY: DailyPoint[] = []

// A CapabilityResult is any object carrying a `datasets` array — enough to route to the generic renderer.
// Non-conforming results (the `custom` capabilities) fall back to raw JSON.
const isCapabilityResult = (data: unknown): data is { datasets: unknown[] } =>
  typeof data === 'object' && data != null && Array.isArray((data as { datasets?: unknown }).datasets)

// Whether a report has a table view with a `files` descriptor → its rows are downloadable files, so the
// panel wires the download bridge (selection + Download all/selected + per-row View/Open + size).
const hasDownloadableTable = (data: unknown): boolean => {
  const views = (data as { views?: unknown }).views

  return (
    Array.isArray(views) &&
    views.some(
      (v) => v != null && (v as { type?: string }).type === 'table' && Boolean((v as { files?: unknown }).files)
    )
  )
}

// The component hands us a formatted blob; we save it via the native dialog.
const saveExport = (blob: { text: string }, filename: string): void => {
  void window.butin.files.saveFile(filename, blob.text).then((r) => {
    if (r.ok && !r.data.canceled) {
      toast.success(filename)
    } else if (!r.ok) {
      toast.error(r.error)
    }
  })
}

export const CapabilityPanel = ({
  plugin,
  capability,
  active,
  connected,
  autoFetch
}: {
  plugin: PluginSummary
  capability: CapabilityView
  active: boolean
  connected: boolean
  // Only fetch-on-open when the session is CONFIRMED working this session. An unverified / expired session
  // (amber) still shows its cached report and a manual Refresh — it never auto-fires a fetch that 403s.
  autoFetch: boolean
}) => {
  const pluginId = plugin.id
  const qc = useQueryClient()
  const t = useLabels()
  const { mark } = usePluginState()
  const fail = useFailureUi(plugin)

  const reportQ = useQuery({
    queryKey: ['report', pluginId, capability.id],
    queryFn: () => window.butin.reports.get(pluginId, capability.id)
  })

  // Per-day spend derived from the capability's ledger, feeding the spend chart's Daily mode. Only a capability
  // reporting a spend section carries a spend series; others get [] from main, so skip the IPC for them.
  const summaries = (reportQ.data?.data as { summaries?: { section?: string }[] } | undefined)?.summaries
  const isSpendCapability = Boolean(summaries?.some((s) => s.section === 'spend'))

  const dailyQ = useQuery({
    queryKey: ['dailySpend', pluginId, capability.id],
    queryFn: () => window.butin.reports.dailySpend(pluginId, capability.id),
    enabled: isSpendCapability
  })
  const daily = dailyQ.data ?? EMPTY_DAILY

  const run = useMutation({
    // The options object stays extensible; the `| void` lets callers `mutate()` for a normal run (react-query
    // only allows omitting the variable when its type includes `void`) and `mutate({ force: true })` to force.
    mutationFn: async (opts: { force?: boolean } | void) => {
      await window.butin.services.clearQueryCache(pluginId)

      return window.butin.services.runCapability(pluginId, capability.id, opts?.force)
    },
    onSuccess: (result) => {
      if (result.ok) {
        mark(pluginId, { ok: true }) // a successful fetch confirms the session works
        void reportQ.refetch()
        void qc.invalidateQueries({ queryKey: ['dailySpend', pluginId, capability.id] })
        void qc.invalidateQueries({ queryKey: ['rowDailySpend', pluginId, capability.id] })
        void qc.invalidateQueries({ queryKey: ['reportTimes', pluginId] })
        void qc.invalidateQueries({ queryKey: ['overview'] })

        // A single successful fetch — even an auto-fetch on tab open — completes first-run onboarding, the
        // same as Refresh-All. Data came home, so the "Finish setup" nag should clear.
        if (plugin.onboardedAt == null) {
          void window.butin.lifecycle
            .markOnboarded(pluginId)
            .then(() => qc.invalidateQueries({ queryKey: ['plugins'] }))
        }
      } else {
        // The fetch may have hit a 401 that cleared the stored session — re-read so `connected` reflects it.
        void qc.invalidateQueries({ queryKey: ['plugins'] })
        toast.error(result.error ?? t.fetchFailed)
      }
    }
  })

  // Lazy: fetch once when this tab becomes active, nothing is cached yet, AND the session is confirmed
  // working (autoFetch). An unverified / expired session still shows its cached report (read from disk) and
  // a manual Refresh — it never auto-fires a fetch, so opening an amber service can't trigger a failing GET.
  const autoRan = useRef(false)

  useEffect(() => {
    if (active && autoFetch && !reportQ.isLoading && !reportQ.data && !autoRan.current) {
      autoRan.current = true
      run.mutate()
    }
  }, [active, autoFetch, reportQ.isLoading, reportQ.data, run])

  const prefs = useTablePrefs(`${pluginId}.${capability.id}`)

  const stored = reportQ.data
  const ran = run.data
  const failedRefresh = ran && !ran.ok
  const fresh = ran?.ok ? { data: ran.data.report, lastRunAt: ran.data.lastRunAt } : null
  const cached = stored ? { data: stored.data, lastRunAt: stored.lastRunAt } : null
  // The view payload: prefer this tab's just-run result, else the cached report read off disk.
  const view = fresh ?? cached

  // A downloadable table (e.g. invoices): the report has a table view with a `files` descriptor, so its rows
  // become selectable files driven by the shared download engine (main derives the items from the stored
  // report — URL GET or the capability's fetchFile hook). The hooks always run; inert unless downloadable.
  const downloadable = isCapabilityResult(view?.data) && hasDownloadableTable(view.data)
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set())
  const [fileStatuses, setFileStatuses] = useState<Record<string, FileDownloadStatus>>({})
  // Files that landed during the in-flight batch, overlaid on the located query so each row's Open action + size
  // appear the instant it finishes — the located query itself only refetches once the whole batch resolves.
  const [locatedLive, setLocatedLive] = useState<Record<string, LocatedFile>>({})
  const fileFolderQ = useDocFolder(pluginId)

  const locatedFilesQ = useQuery({
    queryKey: ['locateFiles', pluginId, capability.id],
    queryFn: () => window.butin.jobs.locateFiles(pluginId, capability.id),
    enabled: downloadable
  })

  // A keyed table with a cumulative column (e.g. members' MTD spend) → fetch each row's derived daily series
  // from the capability's ledger and feed it to the renderer's per-row Trend sparkline. Skipped (no column,
  // disabled query) for every result without one.
  const cumulative = isCapabilityResult(view?.data) ? findCumulativeColumn(view.data as never) : undefined

  const rowDailyQ = useQuery({
    queryKey: ['rowDailySpend', pluginId, capability.id, cumulative?.datasetId, cumulative?.columnKey],
    queryFn: () =>
      window.butin.reports.rowDailySpend(pluginId, capability.id, cumulative!.datasetId, cumulative!.columnKey),
    enabled: Boolean(cumulative)
  })
  const rowDaily = cumulative && rowDailyQ.data ? { [cumulative.datasetId]: rowDailyQ.data } : undefined

  useJobProgress(pluginId, capability.id, (p) => {
    if (p.docId && p.state) {
      setFileStatuses((prev) => ({ ...prev, [p.docId as string]: p.state as FileDownloadStatus }))
    }

    if (p.docId && p.state === 'done' && p.path) {
      setLocatedLive((prev) => ({
        ...prev,
        [p.docId as string]: { path: p.path as string, sizeBytes: p.sizeBytes ?? 0 }
      }))
    }
  })

  const downloadFiles = useMutation({
    mutationFn: (selection: string[] | 'all') => window.butin.jobs.runJob(pluginId, capability.id, { selection }),
    onMutate: () => {
      setFileStatuses({})
      setLocatedLive({})
    },
    onSuccess: (res) => {
      if (res.ok && res.data.kind === 'files') {
        toast.success(t.downloadDone(res.data.done, res.data.skipped))
        setSelectedFiles(new Set())
        void locatedFilesQ.refetch()

        if (res.data.errors.length > 0) {
          toast.error(`${res.data.errors.length} ${t.docFailed}`)
        }
      } else if (!res.ok) {
        toast.error(res.error ?? t.fetchFailed)
      }
    }
  })

  const pickFileFolder = useMutation({
    mutationFn: () => window.butin.files.folderPick(pluginId),
    onSuccess: (dir) => {
      if (dir) {
        void qc.invalidateQueries({ queryKey: ['docFolder', pluginId] })
        void locatedFilesQ.refetch()
      }
    }
  })

  const downloads: TableFilesBridge | undefined = downloadable
    ? {
        located: { ...(locatedFilesQ.data ?? {}), ...locatedLive },
        statuses: fileStatuses,
        selection: selectedFiles,
        onSelectionChange: setSelectedFiles,
        onDownload: (selection) => downloadFiles.mutate(selection),
        onOpen: (path) => void window.butin.files.openDocument(path),
        busy: downloadFiles.isPending,
        folderPath: fileFolderQ.data,
        onPickFolder: () => pickFileFolder.mutate(),
        onRevealFolder: () => void window.butin.files.revealFolder('documents', pluginId)
      }
    : undefined

  return (
    <ServicePageShell
      lastRunAt={view?.lastRunAt}
      running={run.isPending}
      onRefresh={() => run.mutate()}
      onRefetchAll={capability.incremental ? () => run.mutate({ force: true }) : undefined}
      refreshDisabled={!connected}
      warn={Boolean(failedRefresh && stored)}
    >
      {/* Every state (skeleton, fetching, error, empty, rendered result) fills the page's one capped, centered
          width, so the first load of a tab doesn't jump from a full-width skeleton to a narrower centered table
          on a wide monitor. */}
      {view ? (
        isCapabilityResult(view.data) ? (
          <DashboardRenderer
            result={view.data as never}
            daily={daily}
            rowDaily={rowDaily}
            tableState={prefs.initialState as never}
            onTableStateChange={prefs.onStateChange}
            onExport={saveExport}
            downloads={downloads}
            // Pin a constant width so switching tabs (each its own result) never resizes the page.
            width="wide"
          />
        ) : (
          <pre className="bg-muted/50 max-h-[60vh] overflow-auto rounded-md p-3 font-mono text-xs leading-relaxed">
            {JSON.stringify(view.data, null, 2)}
          </pre>
        )
      ) : run.isPending ? (
        // The fetch (including the first-time offscreen session mint, which can take a few seconds with
        // no other signal) is in flight — say so explicitly so the page never looks frozen.
        <div className="text-muted-foreground flex items-center gap-2 p-3 text-sm">
          <Loader2 className="size-4 animate-spin" />
          <span>{t.fetching}</span>
        </div>
      ) : ran && !ran.ok && !stored ? (
        <ErrorPanel
          cause={(ran.cause ?? 'unknown') as TroubleshootingCause}
          message={fail.message((ran.cause ?? 'unknown') as TroubleshootingCause)}
          actions={(ran.actions as TroubleshootingAction[] | undefined) ?? ['retry']}
          details={ran.error}
          onAction={(a) => fail.dispatch((ran.cause ?? 'unknown') as TroubleshootingCause, a, () => run.mutate())}
        />
      ) : !connected ? (
        <p className="text-muted-foreground p-3 text-sm">{t.connectPrompt(t.s(capability.label))}</p>
      ) : reportQ.isLoading ? (
        // Genuinely reading the cached report off disk — the only time a skeleton means "loading".
        <Skeleton className="h-40" />
      ) : (
        // Connected, idle, nothing cached and nothing in flight: say "no data" instead of a pulsing
        // skeleton that reads as a perpetual query. Refresh stays available in the shell header.
        <p className="text-muted-foreground p-3 text-sm">{t.noDataYet}</p>
      )}
    </ServicePageShell>
  )
}
