import {
  resolveTableFiles,
  type CapabilityResult,
  type Column,
  type RecordDataset,
  type SemanticRole,
  type StatField,
  type TableDataset,
  type TableFiles,
  type View
} from '@butinapp/sdk/data'
import { startCase } from '@butinapp/sdk/util'
import type { DailyPoint } from '@butinapp/shapes'
import { ChevronDown, ChevronRight, Download, ExternalLink, FolderCog, FolderOpen, Loader2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { Badge } from '../../components/badge.js'
import { Button } from '../../components/button.js'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/card.js'
import type { DataTableColumn, DataTableState } from '../../components/data-table-model.js'
import { DataTable } from '../../components/data-table.js'
import { Progress } from '../../components/progress.js'
import { Sparkline } from '../../components/sparkline.js'
import { TruncatedCell } from '../../components/truncated-cell.js'
import { useLabels } from '../../i18n/context.js'
import { useFormat } from '../../i18n/format-context.js'
import { resolveNumberLocale } from '../../i18n/format.js'
import { cn } from '../../lib/utils.js'
import { StatCard } from '../charts.js'
import { formatSize } from '../documents/doc-models.js'
import { OpenFileButton, ViewFileLink } from '../documents/open-file-button.js'

import { formatByRole } from './format-role.js'
import { planViews } from './plan-views.js'
import { TimeseriesChart } from './timeseries-chart.js'
import {
  datasetRowId,
  categoricalTone,
  defaultTableSort,
  groupDailyByMonth,
  latestMonthDaily,
  monthlyAggregate,
  recordRows,
  resolveBadgeTone,
  seriesData,
  stackedSeries,
  statCards,
  type StatCardModel,
  type ChartPoint
} from './view-models.js'

// A table with at least this many columns is treated as "wide" and the dashboard widens its container so the
// data breathes instead of wrapping. Content-derived layout, not a per-plugin setting.
const WIDE_TABLE_COLS = 6

// Per-file download state streamed from the host.
export type FileDownloadStatus = 'queued' | 'downloading' | 'done' | 'skipped' | 'error'

// The host-provided bridge that turns a `files`-tagged table into a downloadable file list: which rows are
// on disk (path + size), live download statuses, the selection, and the download/open/folder actions. The
// host (core's renderer) owns all IPC; @butinapp/ui stays pure. Absent → the table renders plain (url = link).
export type TableFilesBridge = {
  located: Record<string, { path: string; sizeBytes: number }>
  statuses: Record<string, FileDownloadStatus>
  selection: Set<string>
  onSelectionChange: (next: Set<string>) => void
  onDownload: (selection: string[] | 'all') => void
  onOpen: (path: string) => void
  busy: boolean
  folderPath?: string
  onPickFolder?: () => void
  onRevealFolder?: () => void
}

const Panel = ({ title, children }: { title?: string; children: ReactNode }) => (
  <Card className="gap-2 py-3">
    {title ? (
      <CardHeader className="px-4">
        <CardTitle className="text-muted-foreground text-[11px] font-medium">{title}</CardTitle>
      </CardHeader>
    ) : null}
    <CardContent className="px-4">{children}</CardContent>
  </Card>
)

// Value tint for a stat whose field declared a tone (e.g. a negative spend delta reads as a win → green).
const TONE_CLASS: Record<NonNullable<StatCardModel['tone']>, string> = {
  positive: 'text-emerald-500',
  negative: 'text-rose-500',
  muted: 'text-muted-foreground'
}

const StatView = ({ ds, fields, locale }: { ds: RecordDataset; fields?: (string | StatField)[]; locale: string }) => {
  const t = useLabels()

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {statCards(ds, fields, locale).map((c) => (
        <StatCard
          key={c.key}
          label={t.s(c.label)}
          valueClass={c.tone ? TONE_CLASS[c.tone] : undefined}
          value={
            <span>
              {c.value}
              {c.unit ? <span className="text-muted-foreground text-xs font-normal"> {c.unit}</span> : null}
              {c.denominator ? (
                <span className="text-muted-foreground text-sm font-normal"> / {c.denominator}</span>
              ) : null}
            </span>
          }
          sub={
            c.progress != null || c.caption ? (
              <div className="flex flex-col gap-1">
                {c.progress != null ? (
                  <div className="mt-1 flex items-center gap-2">
                    <Progress value={c.progress} />
                    {c.percentLabel ? (
                      <span className="text-muted-foreground shrink-0 text-[10px] tabular-nums">{c.percentLabel}</span>
                    ) : null}
                  </div>
                ) : null}
                {c.caption ? <span>{c.caption}</span> : null}
              </div>
            ) : undefined
          }
        />
      ))}
    </div>
  )
}

const KeyValueView = ({
  ds,
  title,
  fields,
  locale
}: {
  ds: RecordDataset
  title?: string
  fields?: string[]
  locale: string
}) => {
  const t = useLabels()

  return (
    <Panel title={title}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        {recordRows(ds, fields, locale).map((r) => (
          <div key={r.label} className="contents">
            <dt className="text-muted-foreground">{t.s(r.label)}</dt>
            <dd className="text-right tabular-nums">{r.value}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  )
}

type TableRow = Record<string, unknown>

// Render one cell body by its column's semantic role: a url → external-link icon, a status → sentiment badge,
// a category → distinct-hue badge, a truncatable free-text → a peek/copy cell, everything else → formatByRole.
// Shared by the main table and a nested row-detail table so both format identically.
const renderRoleCell = (c: Column, raw: unknown, locale: string): ReactNode => {
  if (c.role === 'url' && typeof raw === 'string' && raw !== '') {
    return (
      <a
        href={raw}
        target="_blank"
        rel="noreferrer"
        className="text-muted-foreground hover:text-foreground inline-flex"
      >
        <ExternalLink className="size-3.5" />
      </a>
    )
  }

  if (c.role === 'status' && raw != null && raw !== '') {
    // Sentiment tone inferred from the value (a `badges` override wins); the label is title-cased so a machine
    // enum ('past_due', 'paid') reads cleanly without each plugin pre-formatting it.
    return <Badge variant={resolveBadgeTone(raw, c.badges)}>{startCase(String(raw))}</Badge>
  }

  if (c.role === 'category' && raw != null && raw !== '') {
    // A distinct, stable hue per value (no sentiment) — same value, same color everywhere.
    return <Badge variant={categoricalTone(raw)}>{startCase(String(raw))}</Badge>
  }

  if (c.truncate && raw != null && raw !== '') {
    return <TruncatedCell text={String(raw)} />
  }

  return formatByRole(raw, c.role, c.currency, locale)
}

// A parent row's expanded detail: a compact table of the child dataset's rows (already filtered to this
// parent), drawn with the child's own column roles.
const DetailTable = ({ ds, rows, locale }: { ds: TableDataset; rows: TableRow[]; locale: string }) => {
  const t = useLabels()
  const cols = ds.columns.filter((c) => !c.hidden)
  const alignRight = (c: Column) => c.role === 'money' || c.role === 'count' || c.role === 'percent'

  return (
    <div className="px-2 py-1.5">
      <table className="w-full text-xs">
        <thead className="text-muted-foreground text-[10px] tracking-wide uppercase">
          <tr className="text-left">
            {cols.map((c) => (
              <th key={c.key} className={cn('py-1 pr-4 font-medium', alignRight(c) && 'text-right')}>
                {t.s(c.label ?? c.key)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-border/40 border-t">
              {cols.map((c) => (
                <td key={c.key} className={cn('py-1 pr-4 tabular-nums', alignRight(c) && 'text-right')}>
                  {renderRoleCell(c, row[c.key], locale)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const TableView = ({
  ds,
  title,
  columns,
  groupBy,
  locale,
  tableState,
  onTableStateChange,
  onExport,
  files,
  downloads,
  rowDaily,
  detailDataset,
  detailOn
}: {
  ds: TableDataset
  title?: string
  columns?: string[]
  groupBy?: string
  locale: string
  tableState?: DataTableState
  onTableStateChange?: (next: DataTableState) => void
  onExport?: (blob: { text: string; mime: string }, filename: string) => void
  // When both are set, the table's rows are downloadable files (selection + Download all/selected + a Size
  // column + a per-row View/Open action). Either absent → a plain table (a url column is just a link).
  files?: TableFiles
  downloads?: TableFilesBridge
  // Per-row derived daily series, keyed by the row's ledger id (the table key's value). Present only for a
  // table with a cumulative column → the view adds a trailing Trend sparkline column. Absent → no Trend column.
  rowDaily?: Record<string, DailyPoint[]>
  // A row-detail binding: each row expands into the child dataset's rows joined on `detailOn`. Takes precedence
  // over the cumulative daily drilldown. Absent → no static row detail.
  detailDataset?: TableDataset
  detailOn?: string
}) => {
  const t = useLabels()
  const getRowId = (row: TableRow): string => String(ds.rows.indexOf(row))
  // A table with a date column opens newest-first; a saved sort pref (loaded into tableState) always wins.
  const initialState: DataTableState | undefined = tableState?.sort
    ? tableState
    : { ...tableState, sort: defaultTableSort(ds.columns) }
  const downloadable = Boolean(files && downloads)
  const resolved = downloadable ? resolveTableFiles(files!) : undefined
  // Columns with hidden:true are machinery fields (accumulation keys, download filenames, fetchFile payloads)
  // that must not appear in the table body — filter them out before anything else.
  const picked = (
    columns ? columns.map((k) => ds.columns.find((c) => c.key === k)).filter((c) => c != null) : ds.columns
  ).filter((c) => !c.hidden)
  // The groupBy column renders as the section header, not a body column. For a downloadable table the url
  // column also leaves the body — it folds into the trailing View/Open action — so every download panel ends
  // in `… Size · action`.
  const hidden = new Set<string>([
    ...(groupBy ? [groupBy] : []),
    ...(downloadable && resolved?.urlKey ? [resolved.urlKey] : [])
  ])
  const body = picked.filter((c) => !hidden.has(c.key))

  const cols: DataTableColumn<TableRow>[] = body.map((c) => ({
    key: c.key,
    label: t.s(c.label ?? c.key),
    align: c.role === 'money' || c.role === 'count' || c.role === 'percent' ? 'right' : 'left',
    // Short fixed-width roles stay on one line; free text (label/text/url) wraps + absorbs the slack.
    noWrap: ['timestamp', 'money', 'count', 'percent', 'status', 'identifier'].includes(c.role),
    // A truncated column is the greedy one — it fills the leftover row width and ellipsizes there.
    grow: c.truncate,
    // Floor the amount columns so the greedy column can't squeeze them below a comfortable width. Dates don't
    // need a floor — the 'Order date' header already sizes the column wider than a 'YYYY-MM-DD' value.
    minWidth: c.role === 'money' ? 'min-w-24' : undefined,
    sortValue: (row) => {
      const raw = row[c.key]

      return typeof raw === 'number' ? raw : raw == null ? undefined : String(raw)
    },
    exportValue: (row) => {
      const raw = row[c.key]

      return typeof raw === 'number' ? raw : raw == null ? undefined : String(raw)
    },
    cell: (row) => renderRoleCell(c, row[c.key], locale)
  }))

  // A cumulative column (an MTD-per-row counter) with a per-row daily series → a trailing Trend column: each
  // row's current-month day-over-day series as a sparkline. Fewer than two days this month (or no series)
  // renders an em dash. The column is informational, so it never sorts/exports.
  const trendCol = rowDaily ? ds.columns.find((c) => c.accrual === 'cumulative') : undefined

  if (trendCol) {
    cols.push({
      key: '__trend',
      label: t.s('Trend'),
      align: 'right',
      sortable: false,
      hideable: false,
      cell: (row) => {
        const id = datasetRowId(row, ds.key)
        const month = latestMonthDaily(id ? (rowDaily![id] ?? []) : [])

        return month.length >= 2 ? (
          <Sparkline values={month.map((p) => p.value)} className="text-foreground/70" />
        ) : (
          <span className="text-muted-foreground">—</span>
        )
      }
    })
  }

  // Downloadable tables end in two fixed columns: Size (on-disk size) second-to-last, then the trailing
  // action last. The action is additive + state-aware: View (when the row has a urlKey URL — opens it
  // externally) and Open (once on disk) can both show; a spinner while fetching; '—' when there's neither.
  if (downloadable) {
    const urlKey = resolved!.urlKey
    const rowUrl = (row: TableRow): string | undefined => {
      const raw = urlKey ? row[urlKey] : undefined

      return typeof raw === 'string' && raw !== '' ? raw : undefined
    }

    cols.push({
      key: '__size',
      label: t.s('Size'),
      align: 'right',
      sortable: false,
      hideable: false,
      minWidth: 'min-w-20',
      cell: (row) => {
        const loc = downloads!.located[getRowId(row)]

        return loc ? formatSize(loc.sizeBytes) : '—'
      }
    })

    cols.push({
      key: '__files',
      label: '',
      align: 'right',
      sortable: false,
      hideable: false,
      exportValue: (row) => {
        const loc = downloads!.located[getRowId(row)]

        return loc ? loc.path : rowUrl(row)
      },
      cell: (row) => {
        const id = getRowId(row)
        const loc = downloads!.located[id]
        const url = rowUrl(row)
        const actions: ReactNode[] = []

        if (url) {
          actions.push(<ViewFileLink key="view" url={url} />)
        }

        if (loc) {
          actions.push(<OpenFileButton key="open" onClick={() => downloads!.onOpen(loc.path)} />)
        } else if (downloads!.statuses[id] === 'downloading') {
          actions.push(<Loader2 key="spin" className="text-muted-foreground size-3.5 animate-spin" />)
        }

        return actions.length > 0 ? (
          <div className="flex items-center justify-end gap-1">{actions}</div>
        ) : (
          <span className="text-muted-foreground">—</span>
        )
      }
    })
  }

  const selectedIds = downloadable ? [...downloads!.selection] : []
  const actionBar =
    downloadable && downloads ? (
      <>
        {downloads.folderPath ? (
          <div className="text-muted-foreground mr-auto flex min-w-0 items-center gap-1.5 text-xs">
            <span className="shrink-0">{t.documentsFolderLabel}</span>
            <span className="truncate font-mono">{downloads.folderPath}</span>
            {downloads.onPickFolder ? (
              <button onClick={downloads.onPickFolder} className="hover:text-foreground inline-flex items-center gap-1">
                <FolderCog className="size-3.5" /> {t.documentsChangeFolder}
              </button>
            ) : null}
          </div>
        ) : null}
        {downloads.onRevealFolder ? (
          <Button size="xs" variant="ghost" onClick={downloads.onRevealFolder}>
            <FolderOpen /> {t.openFolder}
          </Button>
        ) : null}
        <Button size="xs" variant="outline" disabled={downloads.busy} onClick={() => downloads.onDownload('all')}>
          {downloads.busy ? <Loader2 className="animate-spin" /> : <Download />} {t.downloadAll}
        </Button>
        <Button
          size="xs"
          disabled={downloads.busy || selectedIds.length === 0}
          onClick={() => downloads.onDownload(selectedIds)}
        >
          {downloads.busy ? <Loader2 className="animate-spin" /> : <Download />}{' '}
          {t.downloadSelected(selectedIds.length)}
        </Button>
      </>
    ) : undefined

  // Collapsible sections keyed by the groupBy column; for a downloadable grouped table each section gets a
  // "Download N selected" action (only when rows in it are checked), mirroring the per-group download.
  const grouped =
    groupBy != null
      ? {
          by: (row: TableRow) => String(row[groupBy] ?? 'Other'),
          groupAction:
            downloadable && downloads
              ? (_key: string, _ids: string[], selectedIds: string[]) =>
                  selectedIds.length > 0 ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={downloads.busy}
                      onClick={() => downloads.onDownload(selectedIds)}
                    >
                      {t.downloadSelected(selectedIds.length)}
                    </Button>
                  ) : null
              : undefined
        }
      : undefined

  // Row expansion. An explicit row-detail binding (a static child table) wins; otherwise a cumulative column
  // with a per-row daily series expands each row to its real per-day usage (the same derived series the Trend
  // column draws) so the day-by-day breakdown is readable even when the sparkline can't draw yet.
  const expandable =
    detailDataset && detailOn
      ? (row: TableRow) => {
          const parentVal = row[detailOn]
          const childRows = (detailDataset.rows as TableRow[]).filter((r) => r[detailOn] === parentVal)

          return childRows.length > 0 ? <DetailTable ds={detailDataset} rows={childRows} locale={locale} /> : null
        }
      : trendCol
        ? (row: TableRow) => {
            const id = datasetRowId(row, ds.key)
            const series = id ? rowDaily![id] : undefined

            return series && series.length > 0 ? (
              <DailyDetail series={series} role={trendCol.role} currency={trendCol.currency} locale={locale} />
            ) : null
          }
        : undefined

  return (
    <Panel title={title}>
      <DataTable
        columns={cols}
        rows={ds.rows as TableRow[]}
        getRowId={getRowId}
        selection={downloadable ? downloads!.selection : undefined}
        onSelectionChange={downloadable ? downloads!.onSelectionChange : undefined}
        grouped={grouped}
        expandable={expandable}
        actionBar={actionBar}
        paginated
        toolbar={{ search: true, columns: true }}
        // The search floats into the panel's title row; without a title there's no row to float into, so it
        // sits inline instead of drifting into the empty space above the card.
        searchFloating={Boolean(title)}
        initialState={initialState}
        onStateChange={onTableStateChange}
        onExport={onExport}
        exportName={ds.id}
      />
    </Panel>
  )
}

const MONTHS3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Short axis label for an x key: a 'YYYY-MM' month → "Feb '26", a 'YYYY-MM-DD' day → "Feb 3", else the key.
const axisLabel = (key: string): string => {
  const month = /^(\d{4})-(\d{2})$/.exec(key)

  if (month) {
    return `${MONTHS3[Number(month[2]) - 1] ?? month[2]} '${month[1]!.slice(2)}`
  }

  const day = /^\d{4}-(\d{2})-(\d{2})$/.exec(key)

  return day ? `${MONTHS3[Number(day[1]) - 1] ?? day[1]} ${Number(day[2])}` : key
}

// The expanded per-row detail for a cumulative column: a compact trend of the current month's daily series
// (drawn only when there are at least two days to trend) plus month sections — newest month first, days
// ascending within each, with the month's subtotal. Only the current month opens by default; previous months
// stay collapsed behind their header and expand individually, so a long history reads by period. Each value is
// formatted by the column's role and estimated days are flagged.
const DailyDetail = ({
  series,
  role,
  currency,
  locale
}: {
  series: DailyPoint[]
  role: SemanticRole
  currency?: string
  locale: string
}) => {
  const t = useLabels()
  const groups = groupDailyByMonth(series)
  // Newest month open, the rest collapsed.
  const [open, setOpen] = useState<Set<string>>(() => new Set(groups[0] ? [groups[0].month] : []))
  const toggle = (month: string): void =>
    setOpen((prev) => {
      const next = new Set(prev)

      if (next.has(month)) {
        next.delete(month)
      } else {
        next.add(month)
      }

      return next
    })
  const trend = groups[0]?.points ?? []

  return (
    <div className="space-y-3">
      <div className="text-muted-foreground flex items-center gap-2 text-[10px] font-medium tracking-wide uppercase">
        {t.perDayHeading}
        {trend.length >= 2 ? <Sparkline values={trend.map((p) => p.value)} className="text-foreground/70" /> : null}
      </div>
      {groups.map((g) => {
        const isOpen = open.has(g.month)

        return (
          <div key={g.month} className="space-y-1">
            <button
              onClick={() => toggle(g.month)}
              aria-expanded={isOpen}
              className="hover:text-foreground flex w-full items-center justify-between border-b pb-0.5 text-[11px]"
            >
              <span className="text-foreground inline-flex items-center gap-1 font-medium">
                {isOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                {g.label}
              </span>
              <span className="text-muted-foreground tabular-nums">
                {formatByRole(g.subtotal, role, currency, locale)}
              </span>
            </button>
            {isOpen ? (
              <ul className="grid grid-cols-2 gap-x-6 gap-y-0.5 text-xs sm:grid-cols-3 lg:grid-cols-4">
                {g.points.map((p) => (
                  <li key={p.date} className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">{axisLabel(p.date)}</span>
                    <span className="tabular-nums">
                      {formatByRole(p.value, role, currency, locale)}
                      {p.estimated ? <span className="text-muted-foreground/70"> {t.estimatedTag}</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

type TableProps = {
  state?: DataTableState
  onStateChange?: (next: DataTableState) => void
  onExport?: (blob: { text: string; mime: string }, filename: string) => void
}

const renderView = (
  view: View,
  dataset: RecordDataset | TableDataset,
  locale: string,
  tx: (text: string) => string,
  tableProps?: TableProps,
  daily?: DailyPoint[],
  downloads?: TableFilesBridge,
  rowDaily?: Record<string, Record<string, DailyPoint[]>>,
  currentMonthEstimate?: number,
  byId?: Map<string, RecordDataset | TableDataset>
): ReactNode => {
  const title = view.title ? tx(view.title) : undefined

  if (view.type === 'stat' && dataset.shape === 'record') {
    return <StatView ds={dataset} fields={view.fields} locale={locale} />
  }

  if (view.type === 'keyvalue' && dataset.shape === 'record') {
    return <KeyValueView ds={dataset} title={title} locale={locale} />
  }

  if (view.type === 'table' && dataset.shape === 'table') {
    // Resolve a row-detail binding to its child TABLE dataset; a dangling or non-table ref just drops the
    // expansion (the validator already flags it) rather than blanking the table.
    const child = view.detail ? byId?.get(view.detail.dataset) : undefined
    const detailDataset = child?.shape === 'table' ? child : undefined

    return (
      <TableView
        ds={dataset}
        title={title}
        columns={view.columns}
        groupBy={view.groupBy}
        locale={locale}
        tableState={tableProps?.state}
        onTableStateChange={tableProps?.onStateChange}
        onExport={tableProps?.onExport}
        files={view.files}
        downloads={view.files ? downloads : undefined}
        rowDaily={rowDaily?.[dataset.id]}
        detailDataset={detailDataset}
        detailOn={detailDataset ? view.detail?.on : undefined}
      />
    )
  }

  if (view.type === 'timeseries' && dataset.shape === 'table') {
    // Every timeseries draws on the rich TimeseriesChart (single or stacked). The host normalizes the dataset
    // into `monthly` (always) + an optional per-day `daily` series by source granularity: a daily-source view
    // opens in Monthly mode (its days aggregated) and drills into days; a monthly-source single series uses the
    // host-derived `daily` for its drill-down and gap-fills its month axis; a stacked monthly series pivots to
    // long-format monthly points with no daily drill.
    const yCol = dataset.columns.find((c) => c.key === view.y)
    const isMoney = yCol?.role === 'money'
    const { x, y, stackBy } = view

    const points: { monthly: ChartPoint[]; daily?: ChartPoint[] } =
      view.granularity === 'daily'
        ? (() => {
            const raw: ChartPoint[] = (dataset.rows as Record<string, unknown>[]).map((r) => ({
              key: String(r[x] ?? ''),
              value: Number(r[y]) || 0,
              ...(stackBy ? { category: String(r[stackBy] ?? '') } : {})
            }))

            return { monthly: monthlyAggregate(raw), daily: raw }
          })()
        : stackBy
          ? (() => {
              const { labels, series } = stackedSeries(dataset, x, y, stackBy)
              const monthly = series.flatMap((s) =>
                labels.map((key, i) => ({ key, value: s.values[i] ?? 0, category: s.name }))
              )

              return { monthly }
            })()
          : (() => {
              const s = seriesData(dataset, x, y)
              const monthly = s.labels.map((key, i) => ({ key, value: s.values[i] ?? 0 }))

              return { monthly, daily: daily?.map((p) => ({ key: p.date, value: p.value, estimated: p.estimated })) }
            })()

    return (
      <TimeseriesChart
        monthly={points.monthly}
        daily={points.daily}
        isMoney={isMoney}
        currency={yCol?.currency}
        title={title}
        height={stackBy ? 200 : 170}
        estimateCurrentMonth={!stackBy && view.granularity === 'monthly' ? currentMonthEstimate : undefined}
      />
    )
  }

  return null
}

// The generic, descriptor-driven dashboard. Resolves each declarative view to its dataset (planViews,
// which also synthesizes defaults + skips dangling refs) and renders the matching generic view. Plugins
// emit a CapabilityResult — no per-kind React. Locale/labels come from context (English by default).
// Table prefs (persistence) + export are host concerns, threaded through to every table view.
export const DashboardRenderer = ({
  result,
  daily,
  rowDaily,
  tableState,
  onTableStateChange,
  onExport,
  downloads,
  width = 'auto'
}: {
  result: CapabilityResult
  daily?: DailyPoint[]
  // Per-row derived daily series for tables with a cumulative column, keyed datasetId → rowId → series. The
  // host fetches it (from the capability's ledger); the matching table gets a Trend sparkline column. Absent
  // → no Trend column anywhere.
  rowDaily?: Record<string, Record<string, DailyPoint[]>>
  tableState?: DataTableState
  onTableStateChange?: (next: DataTableState) => void
  onExport?: (blob: { text: string; mime: string }, filename: string) => void
  // When a table view carries a `files` descriptor, this bridge makes it downloadable. Absent → plain tables.
  downloads?: TableFilesBridge
  // Container width. `auto` derives the tier from content (the densest table's column count) — right for a
  // standalone embed. A host showing several results side by side (the service page's tabs) pins `wide` so
  // the width stays constant across them and switching never resizes the page.
  width?: 'auto' | 'wide' | 'narrow'
}) => {
  const t = useLabels()
  const prefs = useFormat()
  const numberLocale = resolveNumberLocale(prefs.currencyStyle, t.intlLocale)
  const plans = planViews(result)
  // Every dataset by id, so a table view's row-detail binding can resolve its child dataset.
  const byId = new Map(result.datasets.map((d) => [d.id, d] as const))

  // A running (not yet settled) MTD figure projects the open month onto the monthly chart as an estimate. Only
  // a live basis qualifies — an invoiced/last-invoice figure is already a completed bar in the series.
  const mtd = result.summaries?.find((s) => s.section === 'spend')
  const currentMonthEstimate = mtd && (mtd.basis === 'accrued' || mtd.basis === 'upcoming') ? mtd.value : undefined

  // Width tier: a roomy container lets a dense (many-column) table breathe; the narrow cap keeps a result of
  // only small panels (record/keyvalue/stat) or slim tables from sprawling across a wide monitor. When the
  // host pins the tier (`wide`/`narrow`) that wins; otherwise it's derived from the densest table's columns.
  const maxTableCols = Math.max(0, ...plans.map((p) => (p.dataset.shape === 'table' ? p.dataset.columns.length : 0)))
  const wide = width === 'auto' ? maxTableCols >= WIDE_TABLE_COLS : width === 'wide'

  // Centered, width-capped so the content doesn't stretch edge-to-edge on a wide monitor. A 2-column grid
  // lets narrow `keyvalue` panels (account, payment method) sit side by side; stat rows, charts, and tables
  // span the full width. Single column below md. Each cell is `min-w-0` so a wide table's intrinsic content
  // width can't blow the track past the capped container — without it the grid item's default
  // `min-width: auto` lets a freshly-mounted table flash full-width for a frame before snapping to the cap.
  return (
    <div className={cn('mx-auto grid w-full grid-cols-1 gap-3 md:grid-cols-2', wide ? 'max-w-[110rem]' : 'max-w-6xl')}>
      {plans.map((p, i) => (
        <div key={i} className={cn('min-w-0', p.view.type === 'keyvalue' ? 'md:col-span-1' : 'md:col-span-2')}>
          {renderView(
            p.view,
            p.dataset,
            numberLocale,
            t.s,
            { state: tableState, onStateChange: onTableStateChange, onExport },
            daily,
            downloads,
            rowDaily,
            currentMonthEstimate,
            byId
          )}
        </div>
      ))}
    </div>
  )
}
