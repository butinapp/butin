import { type MonthPoint, type Section, type Summary } from '@butinapp/sdk/data'
import { convert, round2, type FxRates } from '@butinapp/sdk/util'
import { combineDailySpend, type DailyPoint, type OverviewPlugin } from '@butinapp/shapes'
import { groupBy, sortBy, sumBy } from 'lodash-es'

// The pure INPUT view-models live in @butinapp/sdk (shared with the export bundle + the embed viewer);
// re-exported here so @butinapp/ui consumers can import them from this module. The DERIVATION below lives here.
export type { MonthPoint, OverviewPlugin }

export type MonthStats = {
  mtd: number
  lastFullMonth: number
  annualizedRunRate: number
}

export type Mover = {
  pluginId: string
  pluginName: string
  color?: string
  icon?: string
  delta: number
  pct: number
}

export type ByServiceRow = {
  pluginId: string
  pluginName: string
  color?: string
  icon?: string
  mtd: number
  lastMo: number
  // The full month before `lastMo` — the basis `momPct` is measured against (the current partial month is
  // excluded from the comparison, so MoM is last-full-month vs the one before it).
  prevMo: number
  momPct: number
  share: number
  spark: number[]
  // Amount per month key (from the plugin's own series), for the detailed table's per-month columns.
  byMonth: Record<string, number>
  total: number
}

const amountAt = (series: MonthPoint[] | undefined, month: string): number =>
  series?.find((p) => p.month === month)?.amount ?? 0

// The spend-section summary a service reports — the live current-period figure its own page headlines.
const spendOf = (p: OverviewPlugin): Summary | undefined => (p.summaries ?? []).find((s) => s.section === 'spend')

// A plugin's current-month spend in the base currency. Prefer the current LOCAL month's bar from the service's
// own per-month series (the figure its chart shows for this month) — built from clean per-month data (invoices,
// cost-explorer months), so it rolls when the user's local month rolls, not when the provider resets its billing
// period. A service whose provider period reset early (UTC month rollover) still reads the user's current month
// here instead of the tiny post-reset open-period figure. With no bar for this month (an arrears service invoices
// in arrears, so its current month isn't in the series yet) it falls back to the live spend-summary value — its
// open-period spend, matching its own page. 0 when there's neither, or the native currency has no rate.
export const currentMtd = (p: OverviewPlugin, nowMonth: string, baseCurrency = 'USD', rates: FxRates = {}): number => {
  const bar = monthlyInBase(p, baseCurrency, rates).find((pt) => pt.month === nowMonth)

  if (bar) {
    return bar.amount
  }

  // No bar for this month (an arrears service invoices in arrears): the peak accrued reading Butin captured this
  // month — restores the just-closed month's figure when the provider's live open-period value has already reset
  // for the next period. Falls through to the live spend-summary value only when nothing was captured this month.
  if (p.currentMonthAccrual != null && p.currentMonthAccrual > 0) {
    return convert(p.currentMonthAccrual, p.currency ?? baseCurrency, baseCurrency, rates) ?? 0
  }

  const s = spendOf(p)

  return s ? (convert(s.value, s.currency ?? p.currency ?? baseCurrency, baseCurrency, rates) ?? 0) : 0
}

// A plugin's monthly amounts converted into the base currency. Sorted by month because the stored series
// arrives in keyed-table insertion order, and consumers read it by position (prevMo, the spark). An
// unconvertible currency (no rate) yields an empty series so it never distorts a base-currency aggregate.
const monthlyInBase = (p: OverviewPlugin, baseCurrency: string, rates: FxRates): MonthPoint[] => {
  const ccy = p.currency ?? baseCurrency

  return (p.monthly ?? [])
    .flatMap((pt) => {
      const amount = convert(pt.amount, ccy, baseCurrency, rates)

      return amount === null ? [] : [{ month: pt.month, amount }]
    })
    .sort((a, b) => a.month.localeCompare(b.month))
}

// A plugin's per-day spend converted into the base currency (same missing-rate exclusion as monthlyInBase).
const dailyInBase = (p: OverviewPlugin, baseCurrency: string, rates: FxRates): DailyPoint[] => {
  const ccy = p.currency ?? baseCurrency

  return (p.daily ?? []).flatMap((pt) => {
    const value = convert(pt.value, ccy, baseCurrency, rates)

    return value === null ? [] : [{ ...pt, value }]
  })
}

// Union every plugin's months into one sorted, summed series — converting each to the base currency first.
export const combinedMonthly = (plugins: OverviewPlugin[], baseCurrency = 'USD', rates: FxRates = {}): MonthPoint[] => {
  const byMonth = groupBy(
    plugins.flatMap((p) => monthlyInBase(p, baseCurrency, rates)),
    (point) => point.month
  )

  return sortBy(Object.entries(byMonth), ([month]) => month).map(([month, points]) => ({
    month,
    amount: round2(sumBy(points, (pt) => pt.amount))
  }))
}

// Sum every spend plugin's per-day series into one combined daily series (a day is estimated if any
// contributing service estimated it), converting each to the base currency. Empty when no plugin has
// captured snapshots yet.
export const combinedDaily = (plugins: OverviewPlugin[], baseCurrency = 'USD', rates: FxRates = {}): DailyPoint[] =>
  combineDailySpend(plugins.map((p) => dailyInBase(p, baseCurrency, rates)))

// Headline numbers. `nowMonth` is the current (partial) month — excluded from the "completed months" the
// run-rate averages. mtd = nowMonth's total; lastFullMonth = the last completed month before nowMonth.
export const monthStats = (
  plugins: OverviewPlugin[],
  nowMonth: string,
  baseCurrency = 'USD',
  rates: FxRates = {}
): MonthStats => {
  const combined = combinedMonthly(plugins, baseCurrency, rates)
  const completed = combined.filter((p) => p.month < nowMonth)
  const lastFullMonth = completed.at(-1)?.amount ?? 0
  const recent = completed.slice(-3)
  const avg = recent.length > 0 ? sumBy(recent, (p) => p.amount) / recent.length : 0
  const mtd = sumBy(plugins, (p) => currentMtd(p, nowMonth, baseCurrency, rates))

  return {
    mtd: round2(mtd),
    lastFullMonth,
    annualizedRunRate: avg * 12
  }
}

// Per-plugin change between two months, split into increases (delta > 0) and drops (delta < 0), each
// sorted by magnitude. pct is relative to the `from` month (0 → 100% when growing from nothing).
export const movers = (
  plugins: OverviewPlugin[],
  from: string,
  to: string,
  baseCurrency = 'USD',
  rates: FxRates = {}
): { increases: Mover[]; drops: Mover[] } => {
  const all: Mover[] = plugins.map((p) => {
    const series = monthlyInBase(p, baseCurrency, rates)
    const a = amountAt(series, from)
    const b = amountAt(series, to)
    const delta = round2(b - a)

    return {
      pluginId: p.pluginId,
      pluginName: p.pluginName,
      color: p.color,
      icon: p.icon,
      delta,
      pct: a === 0 ? (b > 0 ? 100 : 0) : Math.round(((b - a) / a) * 100)
    }
  })

  return {
    increases: all.filter((m) => m.delta > 0).sort((x, y) => y.delta - x.delta),
    drops: all.filter((m) => m.delta < 0).sort((x, y) => x.delta - y.delta)
  }
}

// One table row per plugin: current-month MTD, last completed month, MoM %, share of last-month total,
// the full spark series, and the all-window total.
export const byServiceRows = (
  plugins: OverviewPlugin[],
  nowMonth: string,
  baseCurrency = 'USD',
  rates: FxRates = {}
): ByServiceRow[] => {
  const lastMonth = combinedMonthly(plugins, baseCurrency, rates)
    .filter((p) => p.month < nowMonth)
    .at(-1)?.month
  const series = new Map(plugins.map((p) => [p.pluginId, monthlyInBase(p, baseCurrency, rates)]))
  const lastTotal = sumBy(plugins, (p) => (lastMonth ? amountAt(series.get(p.pluginId), lastMonth) : 0))

  return plugins.map((p) => {
    const months = series.get(p.pluginId) ?? []
    const mtd = currentMtd(p, nowMonth, baseCurrency, rates)
    const lastMo = lastMonth ? amountAt(months, lastMonth) : 0
    const prevMo = months.filter((pt) => lastMonth && pt.month < lastMonth).at(-1)?.amount ?? 0
    const momPct = prevMo === 0 ? (lastMo > 0 ? 100 : 0) : Math.round(((lastMo - prevMo) / prevMo) * 100)

    return {
      pluginId: p.pluginId,
      pluginName: p.pluginName,
      color: p.color,
      icon: p.icon,
      mtd,
      lastMo,
      prevMo,
      momPct,
      share: lastTotal === 0 ? 0 : Math.round((lastMo / lastTotal) * 100),
      spark: months.map((pt) => pt.amount),
      byMonth: Object.fromEntries(months.map((pt) => [pt.month, pt.amount])),
      total: round2(sumBy(months, (pt) => pt.amount))
    }
  })
}

// The detailed table's window "Total": a row summed over only the months currently displayed (the current
// month read from its live `mtd`, every other month from the series), as opposed to `total` (all-time). A
// displayed month the service has no data for contributes 0.
export const windowTotal = (row: ByServiceRow, months: string[], nowMonth: string): number =>
  round2(sumBy(months, (m) => (m === nowMonth ? row.mtd : (row.byMonth[m] ?? 0))))

export type SpendBreakdownRow = {
  currency: string
  mtd: number
  convertible: boolean
}

export type SpendBreakdown = {
  rows: SpendBreakdownRow[]
  unconverted: number
}

// The current-month spend grouped by each service's NATIVE currency (exact, no conversion), plus a count of
// currencies with no rate. The Overview shows this breakdown — and an `≈` on the converted headline — only
// when more than one currency is present or some can't be converted; a single-base-currency setup hides it.
export const spendBreakdown = (
  plugins: OverviewPlugin[],
  nowMonth: string,
  baseCurrency = 'USD',
  rates: FxRates = {}
): SpendBreakdown => {
  // Native (un-converted) current-month spend per service: the live spend-summary value, else the series bar
  // — so the per-currency breakdown agrees with the headline for arrears services.
  const byCcy = groupBy(plugins, (p) => p.currency ?? baseCurrency)

  const rows = Object.entries(byCcy).map(([currency, group]) => ({
    currency,
    mtd: round2(sumBy(group, (p) => spendOf(p)?.value ?? amountAt(p.monthly, nowMonth))),
    convertible: convert(1, currency, baseCurrency, rates) !== null
  }))

  return { rows, unconverted: rows.filter((r) => !r.convertible).length }
}

// The older completed months to show as their own columns in the detailed spend table — newest-first,
// capped at `max`. Excludes the current partial month (its own MTD column) and the last completed month
// (its own "Last mo" column), so these are the months *before* last-mo (e.g. Apr, Mar, Feb, Jan, Dec).
export const monthColumns = (plugins: OverviewPlugin[], nowMonth: string, max = 5): string[] => {
  const completed = combinedMonthly(plugins)
    .map((p) => p.month)
    .filter((m) => m < nowMonth)

  return completed.slice(0, -1).reverse().slice(0, max)
}

// A service's headline summary: an explicit headline:true wins, else spend > balance > other.
export const pickHeadline = (p: OverviewPlugin): Summary | undefined => {
  const summaries = p.summaries ?? []
  const order: Section[] = ['spend', 'balance', 'other']

  return summaries.find((s) => s.headline) ?? order.flatMap((sec) => summaries.filter((s) => s.section === sec))[0]
}

export type Partitioned = {
  spend: OverviewPlugin[]
  balances: OverviewPlugin[]
  others: OverviewPlugin[]
}

// A service lands in Spending / Balances for each monetary headline it reports — a bank with a spend AND a
// balance shows in both. Others is the non-monetary catch-all: a service shows there only when it reports
// NEITHER spend nor balance (a usage/count-only service, or one with no summary). A billing service that also
// reports a usage-cost 'other' metric stays in Spending — its usage lives on its own page, not a second tile.
const has = (p: OverviewPlugin, section: Section): boolean => (p.summaries ?? []).some((s) => s.section === section)

export const partition = (plugins: OverviewPlugin[]): Partitioned => ({
  spend: plugins.filter((p) => has(p, 'spend')),
  balances: plugins.filter((p) => has(p, 'balance')),
  others: plugins.filter((p) => !has(p, 'spend') && !has(p, 'balance'))
})
