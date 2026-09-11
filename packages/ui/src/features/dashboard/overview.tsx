import { MONTH_ABBR, convert, type FxRates } from '@butinapp/sdk/util'
import { ArrowDownRight, ArrowUpRight, ChevronDown } from 'lucide-react'
import { useMemo, useState } from 'react'

import { Button } from '../../components/button.js'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/card.js'
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '../../components/dropdown-menu.js'
import { ServiceIcon } from '../../components/service-icon.js'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/tooltip.js'
import { useLabels } from '../../i18n/context.js'
import { useFormat } from '../../i18n/format-context.js'
import { formatDateTime, resolveMoneyLocale } from '../../i18n/format.js'
import { formatMoney, formatMoneyCompact } from '../../lib/format.js'
import { StatCard } from '../charts.js'

import {
  byServiceRows,
  combinedDaily,
  combinedMonthly,
  monthColumns,
  monthStats,
  movers,
  partition,
  spendBreakdown,
  windowTotal,
  type ByServiceRow,
  type Mover,
  type OverviewPlugin
} from './overview-model.js'
import { TimeseriesChart } from './timeseries-chart.js'

// The currency context the spend band renders in: which currency the converted headline is shown in, the rate
// table that gets foreign services there, and the locale money formats in (base currency home-plain, foreign
// prefixed). Defaults make a single-currency (USD) setup a no-op.
type Fx = { baseCurrency: string; rates: FxRates; locale: string }

const monthLabel = (key: string): string => {
  const [y, m] = key.split('-')

  return `${MONTH_ABBR[Number(m) - 1] ?? m} '${(y ?? '').slice(2)}`
}

const nowMonthKey = (): string => {
  const d = new Date()

  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

const pctClass = (n: number): string =>
  n > 0 ? 'text-red-500 dark:text-red-400' : n < 0 ? 'text-emerald-500 dark:text-emerald-400' : 'text-muted-foreground'

// The graceful fallback when no spend converts into the base currency (no rate fetched yet, or offline): each
// spend service's headline in its OWN currency, so the band stays useful instead of collapsing to "No data yet".
const UnconvertedSpend = ({
  plugins,
  baseCurrency,
  locale,
  onOpen
}: {
  plugins: OverviewPlugin[]
  baseCurrency: string
  locale: string
  onOpen?: (pluginId: string) => void
}) => {
  const t = useLabels()
  const rows = plugins.flatMap((p) => {
    const spend = (p.summaries ?? []).find((s) => s.section === 'spend')

    return spend ? [{ p, spend }] : []
  })

  return (
    <div className="space-y-2">
      <p className="text-muted-foreground text-sm">{t.spendUnconverted(baseCurrency)}</p>
      <Card className="gap-0 py-0">
        <CardContent className="p-0">
          <ul>
            {rows.map(({ p, spend }) => (
              <li
                key={p.pluginId}
                className={`flex items-center justify-between border-b px-4 py-2.5 text-sm last:border-0 ${onOpen ? 'hover:bg-secondary/40 cursor-pointer' : ''}`}
                onClick={onOpen ? () => onOpen(p.pluginId) : undefined}
              >
                <span className="flex items-center gap-2">
                  <ServiceIcon id={p.pluginId} icon={p.icon} name={p.pluginName} color={p.color} size={16} />
                  {p.pluginName}
                </span>
                <span className="font-mono tabular-nums">
                  {formatMoney(spend.value, spend.currency ?? p.currency ?? baseCurrency, locale)}
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}

// The Spending band: rollup stat cards, a combined monthly-spend bar chart, "what changed" movers, and a
// by-service table. Fed only the plugins reporting a spend section (see `partition`) — so non-monetary
// services never land in the spend math. Reads each plugin's monthly series; one with none contributes nothing.
const SpendingSection = ({
  plugins,
  fx,
  onOpen
}: {
  plugins: OverviewPlugin[]
  fx: Fx
  onOpen?: (pluginId: string) => void
}) => {
  const t = useLabels()
  const nowMonth = nowMonthKey()
  const { baseCurrency, rates, locale } = fx

  const [view, setView] = useState<'compact' | 'detailed'>('compact')
  // How many trailing months the detailed table shows as columns (This mo + Last mo + the older columns).
  const [monthsToShow, setMonthsToShow] = useState(6)

  const combined = useMemo(() => combinedMonthly(plugins, baseCurrency, rates), [plugins, baseCurrency, rates])
  const daily = useMemo(() => combinedDaily(plugins, baseCurrency, rates), [plugins, baseCurrency, rates])
  const stats = useMemo(
    () => monthStats(plugins, nowMonth, baseCurrency, rates),
    [plugins, nowMonth, baseCurrency, rates]
  )
  const rows = useMemo(
    () => byServiceRows(plugins, nowMonth, baseCurrency, rates).sort((a, b) => b.lastMo - a.lastMo),
    [plugins, nowMonth, baseCurrency, rates]
  )
  // The older-month columns: the chosen window minus the dedicated This-mo + Last-mo columns.
  const cols = useMemo(
    () => monthColumns(plugins, nowMonth, Math.max(0, monthsToShow - 2)),
    [plugins, nowMonth, monthsToShow]
  )
  const breakdown = useMemo(
    () => spendBreakdown(plugins, nowMonth, baseCurrency, rates),
    [plugins, nowMonth, baseCurrency, rates]
  )

  const completed = combined.filter((p) => p.month < nowMonth)
  const from = completed.at(-2)?.month ?? completed.at(-1)?.month ?? nowMonth
  const to = completed.at(-1)?.month ?? nowMonth
  const move = useMemo(() => movers(plugins, from, to, baseCurrency, rates), [plugins, from, to, baseCurrency, rates])
  const hints = columnHints(nowMonth, to, from)

  // Nothing rolls up into the base currency (no rate yet / offline) yet there ARE spend services: list their
  // native amounts rather than blanking the whole band. With a rate present this never triggers.
  if (combined.length === 0) {
    return <UnconvertedSpend plugins={plugins} baseCurrency={baseCurrency} locale={locale} onOpen={onOpen} />
  }

  // Mixed currencies (or one with no rate) → the headline total is an approximation; flag it with `≈` and
  // surface the exact per-currency subtotals so the converted number is never the whole story.
  const approx = breakdown.rows.length > 1 || breakdown.unconverted > 0
  const money = (n: number): string => `${approx ? '≈ ' : ''}${formatMoney(n, baseCurrency, locale)}`

  return (
    <div className="space-y-5">
      <div data-testid="overview-stats" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Last full month" value={money(stats.lastFullMonth)} />
        <StatCard label="This month (MTD)" value={money(stats.mtd)} />
        <StatCard
          label="Annualized run-rate"
          value={`${approx ? '≈ ' : ''}${formatMoneyCompact(stats.annualizedRunRate, baseCurrency, locale)}`}
          sub="last 3 mo avg × 12"
        />
      </div>

      {approx ? <CurrencyBreakdownRow breakdown={breakdown} baseCurrency={baseCurrency} /> : null}

      <TimeseriesChart
        monthly={combined.map((p) => ({ key: p.month, value: p.amount }))}
        daily={daily.map((p) => ({ key: p.date, value: p.value, estimated: p.estimated }))}
        isMoney
        currency={baseCurrency}
        title="Total monthly spend"
        height={220}
        highlightCurrentMonth
      />

      {move.increases.length > 0 || move.drops.length > 0 ? (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <MoverList
            title="Biggest increases"
            movers={move.increases.slice(0, 4)}
            currency={baseCurrency}
            locale={locale}
            onOpen={onOpen}
          />
          <MoverList
            title="Biggest drops"
            movers={move.drops.slice(0, 4)}
            currency={baseCurrency}
            locale={locale}
            onOpen={onOpen}
          />
        </div>
      ) : null}

      <Card className="gap-2 py-0">
        {cols.length > 0 ? (
          <CardHeader className="flex-row items-center justify-between px-4 pt-3">
            <CardTitle className="text-muted-foreground text-[11px] font-medium">By service</CardTitle>
            <div className="flex items-center gap-2">
              {view === 'detailed' ? <MonthsPicker value={monthsToShow} onChange={setMonthsToShow} /> : null}
              <ViewToggle view={view} onChange={setView} />
            </div>
          </CardHeader>
        ) : null}
        <CardContent className="overflow-x-auto p-0">
          {view === 'detailed' && cols.length > 0 ? (
            <DetailedSpendTable
              rows={rows}
              cols={cols}
              months={[nowMonth, ...(to !== nowMonth ? [to] : []), ...cols]}
              nowMonth={nowMonth}
              currency={baseCurrency}
              locale={locale}
              hints={hints}
              onOpen={onOpen}
            />
          ) : (
            <CompactSpendTable rows={rows} currency={baseCurrency} locale={locale} hints={hints} onOpen={onOpen} />
          )}
        </CardContent>
      </Card>
    </div>
  )
}

// The exact per-currency subtotals behind an approximated headline: one chip per native currency, plus a
// note when some currency has no rate (so its spend isn't in the converted total). Links to currency settings.
const CurrencyBreakdownRow = ({
  breakdown,
  baseCurrency
}: {
  breakdown: ReturnType<typeof spendBreakdown>
  baseCurrency: string
}) => (
  <div className="flex flex-wrap items-center gap-1.5 text-xs">
    {breakdown.rows.map((r) => (
      <span
        key={r.currency}
        className={`rounded-md px-2 py-1 font-mono tabular-nums ${r.convertible ? 'bg-secondary/50' : 'bg-amber-500/10 text-amber-600 dark:text-amber-400'}`}
        title={r.convertible ? undefined : `No ${r.currency}→${baseCurrency} rate — not in the total`}
      >
        {formatMoney(r.mtd, r.currency)}
      </span>
    ))}
    {breakdown.unconverted > 0 ? (
      <span className="text-muted-foreground">{breakdown.unconverted} not converted — add a rate in Settings</span>
    ) : null}
  </div>
)

const ViewToggle = ({
  view,
  onChange
}: {
  view: 'compact' | 'detailed'
  onChange: (v: 'compact' | 'detailed') => void
}) => (
  <div className="bg-secondary/50 flex rounded-md p-0.5 text-[11px]">
    {(['compact', 'detailed'] as const).map((v) => (
      <button
        key={v}
        onClick={() => onChange(v)}
        className={`rounded px-2 py-0.5 capitalize transition-colors ${
          view === v ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
        }`}
      >
        {v}
      </button>
    ))}
  </div>
)

// Header tooltips naming the actual month each column covers. `now` is the current partial month, `last` the
// last completed month, `prev` the one before it (the MoM operands).
type ColumnHints = { thisMo: string; lastMo: string; prevMo: string; mom: string }

const columnHints = (now: string, last: string, prev: string): ColumnHints => ({
  thisMo: `Spend so far this month (${monthLabel(now)}), still accruing`,
  lastMo: `Total for the last completed month (${monthLabel(last)})`,
  prevMo: `Total for the month before last (${monthLabel(prev)})`,
  mom: `Change from ${monthLabel(prev)} (Prev mo) to ${monthLabel(last)} (Last mo) — the current partial month is excluded`
})

// A column header whose label reveals its hint on hover/focus.
const HeaderTip = ({ label, hint }: { label: string; hint: string }) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <span className="cursor-default">{label}</span>
    </TooltipTrigger>
    <TooltipContent>{hint}</TooltipContent>
  </Tooltip>
)

const MONTH_OPTIONS = [6, 12, 24]

// How many trailing months the detailed table shows as columns.
const MonthsPicker = ({ value, onChange }: { value: number; onChange: (n: number) => void }) => (
  <DropdownMenu>
    <DropdownMenuTrigger className="bg-secondary/50 hover:bg-secondary text-muted-foreground hover:text-foreground flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] transition-colors">
      {value} mo
      <ChevronDown className="size-3" />
    </DropdownMenuTrigger>
    <DropdownMenuContent>
      {MONTH_OPTIONS.map((n) => (
        <DropdownMenuItem key={n} onSelect={() => onChange(n)}>
          {n} months
        </DropdownMenuItem>
      ))}
    </DropdownMenuContent>
  </DropdownMenu>
)

// A minimal inline trend line — no ECharts instance per row. Colored by net direction (spend up = red,
// matching the MoM coloring). Renders nothing for a flat/single-point series.
const Sparkline = ({ data }: { data: number[] }) => {
  if (data.length < 2) {
    return null
  }

  const w = 64
  const h = 18
  const max = Math.max(...data)
  const min = Math.min(...data)
  const range = max - min || 1
  const points = data
    .map((v, i) => `${((i / (data.length - 1)) * w).toFixed(1)},${(h - ((v - min) / range) * h).toFixed(1)}`)
    .join(' ')

  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className={pctClass(data.at(-1)! - data[0]!)}
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}

const CompactSpendTable = ({
  rows,
  currency,
  locale,
  hints,
  onOpen
}: {
  rows: ByServiceRow[]
  currency: string
  locale: string
  hints: ColumnHints
  onOpen?: (pluginId: string) => void
}) => (
  <table className="w-full text-sm">
    <thead className="text-muted-foreground border-b text-left text-[11px] uppercase">
      <tr>
        <th className="px-4 py-2 font-medium">Service</th>
        <th className="px-4 py-2 text-right font-medium">
          <HeaderTip label="This mo" hint={hints.thisMo} />
        </th>
        <th className="px-4 py-2 text-right font-medium">
          <HeaderTip label="Last mo" hint={hints.lastMo} />
        </th>
        <th className="px-4 py-2 text-right font-medium">
          <HeaderTip label="Prev mo" hint={hints.prevMo} />
        </th>
        <th className="px-4 py-2 text-right font-medium">
          <HeaderTip label="MoM" hint={hints.mom} />
        </th>
        <th className="px-4 py-2 text-right font-medium">Share</th>
        <th className="px-4 py-2 text-right font-medium">All time</th>
      </tr>
    </thead>
    <tbody>
      {rows.map((r) => (
        <tr
          key={r.pluginId}
          className={`border-b last:border-0 ${onOpen ? 'hover:bg-secondary/40 cursor-pointer' : ''}`}
          onClick={onOpen ? () => onOpen(r.pluginId) : undefined}
        >
          <td className="px-4 py-2">
            <div className="flex items-center gap-2">
              <ServiceIcon id={r.pluginId} icon={r.icon} name={r.pluginName} color={r.color} size={16} />
              {r.pluginName}
            </div>
          </td>
          <td className="px-4 py-2 text-right font-mono tabular-nums">
            {r.mtd ? formatMoney(r.mtd, currency, locale) : '—'}
          </td>
          <td className="px-4 py-2 text-right font-mono tabular-nums">{formatMoney(r.lastMo, currency, locale)}</td>
          <td className="text-muted-foreground px-4 py-2 text-right font-mono tabular-nums">
            {formatMoney(r.prevMo, currency, locale)}
          </td>
          <td className={`px-4 py-2 text-right font-mono tabular-nums ${pctClass(r.momPct)}`}>
            {r.momPct > 0 ? '+' : ''}
            {r.momPct}%
          </td>
          <td className="text-muted-foreground px-4 py-2 text-right font-mono tabular-nums">{r.share}%</td>
          <td className="px-4 py-2 text-right font-mono tabular-nums">{formatMoney(r.total, currency, locale)}</td>
        </tr>
      ))}
    </tbody>
  </table>
)

// The wide view: the compact summary columns plus a trend sparkline and one column per older completed month,
// then the displayed-window Total and the all-time column. `months` is every month the row displays (This mo +
// Last mo + the older `cols`), driving the window Total. The card's overflow-x-auto scrolls it on narrow widths.
const DetailedSpendTable = ({
  rows,
  cols,
  months,
  nowMonth,
  currency,
  locale,
  hints,
  onOpen
}: {
  rows: ByServiceRow[]
  cols: string[]
  months: string[]
  nowMonth: string
  currency: string
  locale: string
  hints: ColumnHints
  onOpen?: (pluginId: string) => void
}) => (
  <table className="w-full text-sm whitespace-nowrap">
    <thead className="text-muted-foreground border-b text-left text-[11px] uppercase">
      <tr>
        <th className="px-4 py-2 font-medium">Service</th>
        <th className="px-4 py-2 text-right font-medium">
          <HeaderTip label="This mo" hint={hints.thisMo} />
        </th>
        <th className="px-4 py-2 text-right font-medium">
          <HeaderTip label="Last mo" hint={hints.lastMo} />
        </th>
        <th className="px-4 py-2 text-right font-medium">
          <HeaderTip label="MoM" hint={hints.mom} />
        </th>
        <th className="px-4 py-2 text-right font-medium">Share</th>
        <th className="px-4 py-2 text-center font-medium">Trend</th>
        {cols.map((m) => (
          <th key={m} className="px-4 py-2 text-right font-medium">
            {monthLabel(m)}
          </th>
        ))}
        <th className="px-4 py-2 text-right font-medium">Total</th>
        <th className="text-muted-foreground px-4 py-2 text-right font-medium">All time</th>
      </tr>
    </thead>
    <tbody>
      {rows.map((r) => (
        <tr
          key={r.pluginId}
          className={`border-b last:border-0 ${onOpen ? 'hover:bg-secondary/40 cursor-pointer' : ''}`}
          onClick={onOpen ? () => onOpen(r.pluginId) : undefined}
        >
          <td className="px-4 py-2">
            <div className="flex items-center gap-2">
              <ServiceIcon id={r.pluginId} icon={r.icon} name={r.pluginName} color={r.color} size={16} />
              {r.pluginName}
            </div>
          </td>
          <td className="px-4 py-2 text-right font-mono tabular-nums">
            {r.mtd ? formatMoney(r.mtd, currency, locale) : '—'}
          </td>
          <td className="px-4 py-2 text-right font-mono tabular-nums">{formatMoney(r.lastMo, currency, locale)}</td>
          <td className={`px-4 py-2 text-right font-mono tabular-nums ${pctClass(r.momPct)}`}>
            {r.momPct > 0 ? '+' : ''}
            {r.momPct}%
          </td>
          <td className="text-muted-foreground px-4 py-2 text-right font-mono tabular-nums">{r.share}%</td>
          <td className="px-4 py-2">
            <div className="flex justify-center">
              <Sparkline data={r.spark} />
            </div>
          </td>
          {cols.map((m) => (
            // A month within the service's history (even at $0) shows its value; only months before the
            // service's first data are blank ('—').
            <td key={m} className="px-4 py-2 text-right font-mono tabular-nums">
              {m in r.byMonth ? formatMoney(r.byMonth[m]!, currency, locale) : '—'}
            </td>
          ))}
          <td className="px-4 py-2 text-right font-mono tabular-nums">
            {formatMoney(windowTotal(r, months, nowMonth), currency, locale)}
          </td>
          <td className="text-muted-foreground px-4 py-2 text-right font-mono tabular-nums">
            {formatMoney(r.total, currency, locale)}
          </td>
        </tr>
      ))}
    </tbody>
  </table>
)

const MoverList = ({
  title,
  movers: items,
  currency,
  locale,
  onOpen
}: {
  title: string
  movers: Mover[]
  currency: string
  locale: string
  onOpen?: (pluginId: string) => void
}) => (
  <Card className="gap-2 py-3">
    <CardHeader className="px-4">
      <CardTitle className="text-muted-foreground text-[11px] font-medium">{title}</CardTitle>
    </CardHeader>
    <CardContent className="flex flex-wrap gap-2 px-4">
      {items.length === 0 ? (
        <span className="text-muted-foreground text-xs">—</span>
      ) : (
        items.map((m) => {
          const up = m.delta > 0

          return (
            <button
              key={m.pluginId}
              onClick={onOpen ? () => onOpen(m.pluginId) : undefined}
              className="bg-secondary/50 hover:bg-secondary flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors"
            >
              <ServiceIcon id={m.pluginId} icon={m.icon} name={m.pluginName} color={m.color} size={14} />
              <span>{m.pluginName}</span>
              <span
                className={`flex items-center font-mono tabular-nums ${up ? 'text-red-500 dark:text-red-400' : 'text-emerald-500 dark:text-emerald-400'}`}
              >
                {up ? <ArrowUpRight className="size-3" /> : <ArrowDownRight className="size-3" />}
                {formatMoneyCompact(Math.abs(m.delta), currency, locale)}
              </span>
            </button>
          )
        })
      )}
    </CardContent>
  </Card>
)

// The Balances band: money you HOLD, never folded into spend. A net-worth rollup + one row per balance
// plugin. Renders only when populated, so it's invisible until a balance-section plugin (e.g. a bank) lands.
const BalancesSection = ({
  plugins,
  fx,
  onOpen
}: {
  plugins: OverviewPlugin[]
  fx: Fx
  onOpen?: (pluginId: string) => void
}) => {
  const t = useLabels()
  const { baseCurrency, rates, locale } = fx
  // Net worth is summed in the base currency; a balance whose currency has no rate is left out of the total
  // (its native amount still shows on its own row). `≈` flags the conversion when any row needed one.
  let approx = false
  const netWorth = plugins.reduce((sum, p) => {
    const ccy = p.currency ?? baseCurrency
    const converted = convert(p.balance ?? 0, ccy, baseCurrency, rates)

    if (ccy !== baseCurrency) {
      approx = true
    }

    return sum + (converted ?? 0)
  }, 0)
  const rows = [...plugins].sort((a, b) => (b.balance ?? 0) - (a.balance ?? 0))

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label={t.netWorth} value={`${approx ? '≈ ' : ''}${formatMoney(netWorth, baseCurrency, locale)}`} />
      </div>
      <Card className="gap-0 py-0">
        <CardContent className="p-0">
          <ul>
            {rows.map((r) => (
              <li
                key={r.pluginId}
                className={`flex items-center justify-between border-b px-4 py-2.5 text-sm last:border-0 ${onOpen ? 'hover:bg-secondary/40 cursor-pointer' : ''}`}
                onClick={onOpen ? () => onOpen(r.pluginId) : undefined}
              >
                <span className="flex items-center gap-2">
                  <ServiceIcon id={r.pluginId} icon={r.icon} name={r.pluginName} color={r.color} size={16} />
                  {r.pluginName}
                </span>
                <span className="font-mono tabular-nums">
                  {formatMoney(r.balance ?? 0, r.currency ?? baseCurrency, locale)}
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}

// The Others band: services whose headline is a per-service 'other' metric (usage/count) — never summed.
// A light launcher tile each: identity, a derived item count, last-fetched, and a connection-state dot.
const OthersSection = ({ plugins, onOpen }: { plugins: OverviewPlugin[]; onOpen?: (pluginId: string) => void }) => {
  const t = useLabels()
  const prefs = useFormat()

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {plugins.map((p) => (
        <Card
          key={p.pluginId}
          className={`gap-1 py-3 ${onOpen ? 'hover:bg-secondary/40 cursor-pointer transition-colors' : ''}`}
          onClick={onOpen ? () => onOpen(p.pluginId) : undefined}
        >
          <CardContent className="space-y-1 px-4">
            <div className="flex items-center gap-2">
              <ServiceIcon id={p.pluginId} icon={p.icon} name={p.pluginName} color={p.color} size={16} />
              <span className="truncate font-medium">{p.pluginName}</span>
              <span
                className={`ml-auto size-2 shrink-0 rounded-full ${p.state === 'connected' ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`}
              />
            </div>
            {p.itemCount != null ? <p className="font-mono text-sm tabular-nums">{t.itemCount(p.itemCount)}</p> : null}
            {p.lastRunAt ? (
              <p className="text-muted-foreground text-xs">
                {t.lastFetched(formatDateTime(p.lastRunAt, prefs, t.intlLocale))}
              </p>
            ) : null}
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

const SectionHeader = ({ title }: { title: string }) => (
  <h2 className="text-muted-foreground text-[11px] font-semibold tracking-wide uppercase">{title}</h2>
)

// The cross-service home: partitions plugins by summary section into Spending / Balances / Others bands (a
// service appears in each band it reports), rendering only the populated ones. Headers appear only when >1
// band shows, so a spend-only user sees the spend dashboard with no extra chrome. Pure + prop-driven.
export const Overview = ({
  plugins,
  baseCurrency = 'USD',
  rates = {},
  onOpen,
  onManage
}: {
  plugins: OverviewPlugin[]
  baseCurrency?: string
  rates?: FxRates
  onOpen?: (pluginId: string) => void
  // Opens Management from the empty state. Absent in an offline embed, which has nothing to install.
  onManage?: () => void
}) => {
  const t = useLabels()
  const prefs = useFormat()
  const fx: Fx = { baseCurrency, rates, locale: resolveMoneyLocale({ ...prefs, baseCurrency }, t.intlLocale) }
  const { spend, balances, others } = partition(plugins)
  const populated = [spend.length > 0, balances.length > 0, others.length > 0].filter(Boolean).length

  if (populated === 0) {
    return (
      <div className="space-y-3">
        <p className="text-muted-foreground text-sm">{t.noDataYet}</p>
        {onManage ? (
          <>
            <p className="text-muted-foreground text-sm">{t.noDataYetHint}</p>
            <Button size="sm" variant="outline" onClick={onManage}>
              {t.noDataYetAction}
            </Button>
          </>
        ) : null}
      </div>
    )
  }

  const showHeaders = populated > 1

  return (
    <div className="space-y-8">
      {spend.length > 0 ? (
        <section className="space-y-3">
          {showHeaders ? <SectionHeader title={t.overviewSpending} /> : null}
          <SpendingSection plugins={spend} fx={fx} onOpen={onOpen} />
        </section>
      ) : null}

      {balances.length > 0 ? (
        <section className="space-y-3">
          {showHeaders ? <SectionHeader title={t.overviewBalances} /> : null}
          <BalancesSection plugins={balances} fx={fx} onOpen={onOpen} />
        </section>
      ) : null}

      {others.length > 0 ? (
        <section className="space-y-3">
          {showHeaders ? <SectionHeader title={t.overviewOthers} /> : null}
          <OthersSection plugins={others} onOpen={onOpen} />
        </section>
      ) : null}
    </div>
  )
}
