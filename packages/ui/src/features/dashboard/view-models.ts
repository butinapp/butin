import {
  type BadgeTone,
  type CapabilityResult,
  type Column,
  type RecordDataset,
  type StatField,
  type StatTone,
  type TableDataset
} from '@butinapp/sdk/data'
import type { DailyPoint } from '@butinapp/shapes'

import { monthlyBuckets } from '../../lib/monthly-buckets.js'

import { formatByRole } from './format-role.js'

// The default sentiment a status value carries, so a role:'status' column auto-tones with no per-plugin map.
// Keys are lowercase; matched case-insensitively. A plugin's `badges` map overrides an entry here, and any
// value absent from both falls back to neutral. This is presentation (which words read as good/bad), so it
// lives in the renderer, not the contract.
const STATUS_LEXICON: Record<string, BadgeTone> = {
  // settled / healthy
  paid: 'success',
  success: 'success',
  succeeded: 'success',
  finalized: 'success',
  collected: 'success',
  processed: 'success',
  posted: 'success',
  complete: 'success',
  completed: 'success',
  active: 'success',
  current: 'success',
  // awaiting payment / attention
  open: 'warning',
  pending: 'warning',
  processing: 'warning',
  issued: 'warning',
  unpaid: 'warning',
  inactive: 'warning',
  // forecast / future (not overdue)
  upcoming: 'info',
  scheduled: 'info',
  // problem
  failed: 'danger',
  declined: 'danger',
  uncollectible: 'danger',
  expired: 'danger',
  revoked: 'danger',
  past_due: 'danger',
  delinquent: 'danger',
  suspended: 'danger',
  disabled: 'danger',
  // no judgment (informational)
  draft: 'neutral',
  void: 'neutral',
  voided: 'neutral',
  refunded: 'neutral',
  closed: 'neutral',
  archived: 'neutral',
  canceled: 'neutral',
  cancelled: 'neutral'
}

// Resolve a role:'status' value to its sentiment tone: a column `badges` override wins, else the renderer's
// built-in lexicon, else 'neutral'. Case-insensitive; a null/empty value is neutral. Pure (unit-tested off-DOM).
export const resolveBadgeTone = (value: unknown, badges?: Record<string, BadgeTone>): BadgeTone => {
  if (value == null || value === '') {
    return 'neutral'
  }

  const want = String(value).toLowerCase()

  if (badges) {
    for (const [key, tone] of Object.entries(badges)) {
      if (key.toLowerCase() === want) {
        return tone
      }
    }
  }

  return STATUS_LEXICON[want] ?? 'neutral'
}

// The distinct hues a role:'category' value cycles through — colors with NO sentiment, so different
// categories (member roles, seat tiers) stay visually separable. Badge carries these variants on top of the
// sentiment tones.
export const CATEGORICAL_HUES = ['indigo', 'violet', 'purple', 'fuchsia', 'pink', 'cyan', 'teal', 'rose'] as const
export type CategoricalHue = (typeof CATEGORICAL_HUES)[number]

// Assign a category value a stable distinct hue by hashing it, so the same value is the same color within a
// table and across services (owner is always one hue, admin another) with zero plugin input. A null/empty
// value gets the first hue.
export const categoricalTone = (value: unknown): CategoricalHue => {
  const text = value == null ? '' : String(value).toLowerCase()

  let hash = 0

  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0
  }

  return CATEGORICAL_HUES[Math.abs(hash) % CATEGORICAL_HUES.length]
}

export type LabelledValue = {
  label: string
  value: string
}

export type TableCell = {
  text: string
  href?: string
}

export type TableModel = {
  columns: Array<{ key: string; label: string }>
  rows: TableCell[][]
}

// Pick the columns to show: the named keys (in that order, skipping any that don't exist) or all of them.
const pick = (cols: Column[], keys?: string[]): Column[] =>
  keys ? keys.map((k) => cols.find((c) => c.key === k)).filter((c): c is Column => c != null) : cols

// Record dataset -> formatted label/value rows. Feeds both the stat-tile and key/value renderers (they
// differ only in layout). `fields` narrows/orders which fields show.
export const recordRows = (ds: RecordDataset, fields?: string[], locale?: string): LabelledValue[] =>
  pick(ds.fields, fields).map((col) => ({
    label: col.label ?? col.key,
    value: formatByRole(ds.value[col.key], col.role, col.currency, locale)
  }))

// Table dataset -> header labels + per-cell formatted text. A url-role cell with a value also carries an
// `href` so the renderer can make it a link. `columns` narrows/orders which columns show.
export const tableModel = (ds: TableDataset, columns?: string[], locale?: string): TableModel => {
  const cols = pick(ds.columns, columns)

  return {
    columns: cols.map((c) => ({ key: c.key, label: c.label ?? c.key })),
    rows: ds.rows.map((row) =>
      cols.map((c): TableCell => {
        const raw = row[c.key]

        if (c.role === 'url' && typeof raw === 'string' && raw !== '') {
          return { text: raw, href: raw }
        }

        return { text: formatByRole(raw, c.role, c.currency, locale) }
      })
    )
  }
}

// The default sort for a table that carries a date: the first timestamp-role column, descending (newest
// first) — so an invoices/statements list opens chronologically instead of in fetch order. undefined when no
// column is a timestamp (the table then keeps its natural row order). Only a fallback: a persisted user sort
// always wins.
export const defaultTableSort = (columns: Column[]): { key: string; dir: 'desc' } | undefined => {
  const ts = columns.find((c) => c.role === 'timestamp' && !c.hidden)

  return ts ? { key: ts.key, dir: 'desc' } : undefined
}

// A row's stable identity from a table's `key` — the SAME join the ledger uses to track a row across captures,
// so the renderer can look up a row's derived daily series by its ledger row id. undefined when any key part is
// missing/empty (an unkeyed row never accumulates).
export const datasetRowId = (row: Record<string, unknown>, key: string | string[] | undefined): string | undefined => {
  const parts = key === undefined ? [] : Array.isArray(key) ? key : [key]

  if (parts.length === 0) {
    return undefined
  }

  const out: string[] = []

  for (const k of parts) {
    const v = row[k]

    if (v === null || v === undefined || v === '') {
      return undefined
    }

    out.push(String(v))
  }

  return out.join('')
}

// The first keyed table dataset carrying a cumulative column (an MTD-per-row counter), with that column's key.
// The host fetches its per-row daily series; the table view differences it into a trend sparkline. undefined
// when no dataset has one — most capabilities, so the renderer skips the extra fetch + column entirely.
export const findCumulativeColumn = (
  result: CapabilityResult
): { datasetId: string; columnKey: string } | undefined => {
  for (const ds of result.datasets) {
    if (ds.shape !== 'table' || ds.key === undefined) {
      continue
    }

    const col = ds.columns.find((c) => c.accrual === 'cumulative')

    if (col) {
      return { datasetId: ds.id, columnKey: col.key }
    }
  }

  return undefined
}

// A stat card resolved for rendering: the headline value plus the optional rich layers (denominator +
// progress, unit suffix, caption, tone) the stat-view field declared. `progress` is a 0..1 fraction.
export type StatCardModel = {
  key: string
  label: string
  value: string
  unit?: string
  denominator?: string
  progress?: number
  percentLabel?: string
  caption?: string
  tone?: StatTone
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n))

// Resolve a record dataset + a stat view's `fields` into render-ready cards. A bare string field shows the
// value as-is; a StatField adds a denominator/progress bar (`max`), a unit suffix, a caption, or a tone. The
// column's role/currency drives formatting of both the value and the denominator, so they always match.
export const statCards = (
  ds: RecordDataset,
  fields: (string | StatField)[] | undefined,
  locale?: string
): StatCardModel[] => {
  const specs: StatField[] = fields
    ? fields.map((f) => (typeof f === 'string' ? { key: f } : f))
    : ds.fields.map((c) => ({ key: c.key }))

  return specs.flatMap((spec) => {
    const col = ds.fields.find((c) => c.key === spec.key)

    if (!col) {
      return []
    }

    const raw = ds.value[spec.key]
    const card: StatCardModel = {
      key: spec.key,
      label: col.label ?? col.key,
      value: formatByRole(raw, col.role, col.currency, locale),
      unit: spec.unit,
      caption: spec.caption,
      tone: spec.tone
    }

    if (spec.max != null && spec.max > 0 && typeof raw === 'number' && Number.isFinite(raw)) {
      card.denominator = formatByRole(spec.max, col.role, col.currency, locale)
      card.progress = clamp01(raw / spec.max)
      card.percentLabel = `${Math.round((raw / spec.max) * 100)}%`
    }

    return [card]
  })
}

export type SeriesData = {
  labels: string[]
  values: number[]
}

export type StackedSeries = {
  labels: string[] // distinct x values, sorted (the shared axis)
  series: { name: string; values: number[] }[] // one per distinct category, aligned to labels
}

// A point in a trend series: `key` is 'YYYY-MM' (monthly) or 'YYYY-MM-DD' (daily); `category` (when present)
// makes the chart a stacked breakdown; `estimated` draws the bar muted + hatched.
export type ChartPoint = { key: string; value: number; category?: string; estimated?: boolean }

// Bucket long-format trend points into monthly points, summing per (month, category). Months sort ascending;
// categories keep first-seen order so a stacked chart's series order is stable. The monthly-aggregation
// counterpart to stackedSeries — feeds the Monthly view of a daily-sourced chart.
export const monthlyAggregate = (points: ChartPoint[]): ChartPoint[] => {
  const months: string[] = []
  const cats: string[] = []
  const sum = new Map<string, number>()

  for (const p of points) {
    const month = p.key.slice(0, 7)
    const cat = p.category ?? ''

    if (!months.includes(month)) {
      months.push(month)
    }

    if (!cats.includes(cat)) {
      cats.push(cat)
    }

    const k = `${cat}|${month}`

    sum.set(k, (sum.get(k) ?? 0) + p.value)
  }

  months.sort()

  const out: ChartPoint[] = []

  for (const month of months) {
    for (const cat of cats) {
      const k = `${cat}|${month}`

      if (sum.has(k)) {
        out.push(cat ? { key: month, value: sum.get(k)!, category: cat } : { key: month, value: sum.get(k)! })
      }
    }
  }

  return out
}

const MONTHS_FULL = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
]

// 'YYYY-MM' -> 'June 2026'.
const monthFullLabel = (month: string): string => {
  const [y, m] = month.split('-')

  return `${MONTHS_FULL[Number(m) - 1] ?? m} ${y ?? ''}`.trim()
}

export type DailyMonthGroup = {
  month: string // 'YYYY-MM'
  label: string // 'June 2026'
  subtotal: number
  points: DailyPoint[]
}

// Group a per-day series into month sections: months newest-first, days ascending within each, plus the
// month's value subtotal. Feeds the expanded per-row daily breakdown so a long flat list reads by period.
export const groupDailyByMonth = (series: DailyPoint[]): DailyMonthGroup[] => {
  const byMonth = new Map<string, DailyPoint[]>()

  for (const p of series) {
    const month = p.date.slice(0, 7)
    const arr = byMonth.get(month) ?? []

    arr.push(p)
    byMonth.set(month, arr)
  }

  return [...byMonth.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([month, points]) => ({
      month,
      label: monthFullLabel(month),
      subtotal: points.reduce((s, p) => s + p.value, 0),
      points: [...points].sort((a, b) => a.date.localeCompare(b.date))
    }))
}

// The newest month's daily points (ascending), empty when there's no data. The Trend sparkline draws this
// alone so it reads as the current period's day-over-day shape rather than a jagged multi-month line that
// dips at each monthly reset.
export const latestMonthDaily = (series: DailyPoint[]): DailyPoint[] => groupDailyByMonth(series)[0]?.points ?? []

// Pivot long-format rows into stacked series: distinct x values (sorted) form the axis; each distinct
// `stackBy` category becomes a series whose value at each x is the sum of that (x, category) cell. Categories
// keep first-seen order, so a plugin controls stack order by row order.
export const stackedSeries = (ds: TableDataset, x: string, y: string, stackBy: string): StackedSeries => {
  const labels: string[] = []
  const cats: string[] = []
  const cell = new Map<string, number>()

  for (const row of ds.rows) {
    const xv = String(row[x] ?? '')
    const cat = String(row[stackBy] ?? '')
    const v = Number(row[y]) || 0

    if (!labels.includes(xv)) {
      labels.push(xv)
    }

    if (!cats.includes(cat)) {
      cats.push(cat)
    }

    const k = `${cat} ${xv}`

    cell.set(k, (cell.get(k) ?? 0) + v)
  }

  labels.sort()

  return {
    labels,
    series: cats.map((name) => ({ name, values: labels.map((xv) => cell.get(`${name} ${xv}`) ?? 0) }))
  }
}

const MONTH_KEY = /^\d{4}-\d{2}$/

const nowMonthKey = (): string => {
  const d = new Date()

  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

// Table dataset -> one numeric series for the chart. When every x value is a YYYY-MM period key, gaps are
// filled to a continuous month axis (reusing monthlyBuckets, extended to nowMonth); otherwise rows pass
// through in order. `nowMonth` is injectable to keep the month branch pure/testable.
export const seriesData = (ds: TableDataset, x: string, y: string, nowMonth = nowMonthKey()): SeriesData => {
  const pairs = ds.rows.map((r) => ({ date: String(r[x] ?? ''), amount: Number(r[y]) || 0 }))
  const isMonth = pairs.length > 0 && pairs.every((p) => MONTH_KEY.test(p.date))

  if (isMonth) {
    const buckets = monthlyBuckets(pairs, nowMonth)

    return { labels: buckets.map((b) => b.month), values: buckets.map((b) => b.amount) }
  }

  return { labels: pairs.map((p) => p.date), values: pairs.map((p) => p.amount) }
}
