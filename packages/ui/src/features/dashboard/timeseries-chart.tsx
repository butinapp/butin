import { MONTH_ABBR } from '@butinapp/sdk/util'
import type { EChartsOption } from 'echarts'
import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react'
import { useMemo, useState } from 'react'

import { Card, CardContent, CardHeader, CardTitle } from '../../components/card.js'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '../../components/dropdown-menu.js'
import { EChart } from '../../components/echart.js'
import { useLabels } from '../../i18n/context.js'
import { useFormat } from '../../i18n/format-context.js'
import { resolveMoneyLocale } from '../../i18n/format.js'
import { grid, useEchartsTheme } from '../../lib/echarts-theme.js'
import { formatMoney, formatMoneyCompact } from '../../lib/format.js'

import { type ChartPoint } from './view-models.js'

const monthLabel = (key: string): string => {
  const [y, m] = key.split('-')

  return `${MONTH_ABBR[Number(m) - 1] ?? m} '${(y ?? '').slice(2)}`
}

// 'YYYY-MM-DD' -> a short day axis label, e.g. 'Jun 3'.
const dayLabel = (key: string): string => {
  const [, m, d] = key.split('-')

  return `${MONTH_ABBR[Number(m) - 1] ?? m} ${Number(d)}`
}

const monthOf = (key: string): string => key.slice(0, 7)

const nowMonthKey = (): string => {
  const d = new Date()

  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

// A muted, hatched bar marks an in-progress / gap-filled value (a synthesized day, or the current month
// projected from its MTD) so it reads distinctly from a settled bar.
const estimatedBar = (color: string) => ({
  color,
  opacity: 0.4,
  decal: {
    symbol: 'line',
    color: 'rgba(255,255,255,0.5)',
    dashArrayX: [1, 4],
    dashArrayY: [2, 2],
    rotation: -Math.PI / 4
  }
})

// Distinct categories of a point set in first-seen order; [''] for a single (categoryless) series.
const categoriesOf = (points: ChartPoint[]): string[] => {
  const seen: string[] = []

  for (const p of points) {
    const c = p.category ?? ''

    if (!seen.includes(c)) {
      seen.push(c)
    }
  }

  return seen.length > 0 ? seen : ['']
}

type ThemeBits = ReturnType<typeof useEchartsTheme>

// Build the bar option for points already filtered to the visible window. One bar series per category
// (stacked, with a legend) or a single series; per-point itemStyle carries the estimate hatch and the
// single-series current-month highlight. Money formatting is gated on `isMoney`.
const buildBarOption = (
  points: ChartPoint[],
  labelFn: (k: string) => string,
  opts: {
    stacked: boolean
    isMoney: boolean
    currency?: string
    locale: string
    theme: ThemeBits
    highlightKey?: string
  }
): EChartsOption => {
  const { stacked, isMoney, currency, locale, theme, highlightKey } = opts
  const { LABEL, AXIS_LINE, TOOLTIP, ACCENT, PALETTE, LEGEND_TEXT } = theme
  const fmtFull = (v: number) => (isMoney ? formatMoney(v, currency, locale) : String(v))
  const fmtCompact = (v: number) => (isMoney ? formatMoneyCompact(v, currency, locale) : String(v))

  const axis = [...new Set(points.map((p) => p.key))].sort()
  const cats = categoriesOf(points)
  const cell = new Map<string, ChartPoint>()

  for (const p of points) {
    cell.set(`${p.category ?? ''}|${p.key}`, p)
  }

  return {
    tooltip: {
      ...TOOLTIP,
      formatter: (params: unknown) => {
        const arr = Array.isArray(params) ? params : [params]
        const first = arr[0] as { axisValueLabel?: string; name?: string } | undefined
        const head = first?.axisValueLabel ?? first?.name ?? ''
        const lines = arr
          .map((p) => {
            const row = p as { value?: number; seriesName?: string; marker?: string }
            const v = typeof row.value === 'number' ? row.value : 0
            const name = stacked ? `${row.marker ?? ''}${row.seriesName} ` : ''

            return `${name}<b>${fmtFull(v)}</b>`
          })
          .join('<br/>')

        return `${head}<br/>${lines}`
      }
    },
    legend: stacked
      ? { data: cats, textStyle: { color: LEGEND_TEXT }, itemWidth: 10, itemHeight: 10, top: 0 }
      : undefined,
    grid: grid(stacked ? 28 : 16),
    xAxis: { type: 'category', data: axis.map(labelFn), axisLabel: LABEL, ...AXIS_LINE },
    yAxis: { type: 'value', axisLabel: { ...LABEL, formatter: (v: number) => fmtCompact(v) }, ...AXIS_LINE },
    series: cats.map((cat, i) => {
      const color = stacked ? (PALETTE[i % PALETTE.length] ?? ACCENT) : ACCENT

      return {
        name: cat || undefined,
        type: 'bar' as const,
        stack: stacked ? 'total' : undefined,
        emphasis: { disabled: true },
        data: axis.map((k) => {
          const p = cell.get(`${cat}|${k}`)
          const itemStyle = p?.estimated
            ? estimatedBar(color)
            : { color: !stacked && highlightKey && k === highlightKey ? 'var(--border)' : color }

          return { value: p?.value ?? 0, itemStyle }
        })
      }
    })
  }
}

// The shared timeseries chart: a Monthly|Daily toggle over bar series, single or stacked. Pure + prop-driven —
// the host normalizes a dataset into `monthly` (always) and an optional per-day `daily` series, each point
// optionally carrying a `category` (→ stacked bars + legend). Monthly mode filters by a multi-year picker
// (default: current year); daily mode shows one calendar month with a ‹ › stepper and renders gap-filled
// (`estimated`) bars muted + hatched. A daily-source chart opens in Monthly mode. The MTD projection +
// current-month highlight apply only to a single (categoryless) series. Both per-service and the Overview feed it.
export const TimeseriesChart = ({
  monthly,
  daily,
  isMoney = false,
  currency,
  title,
  height = 200,
  highlightCurrentMonth = false,
  estimateCurrentMonth
}: {
  monthly: ChartPoint[]
  daily?: ChartPoint[]
  isMoney?: boolean
  currency?: string
  title?: string
  height?: number
  highlightCurrentMonth?: boolean
  // When the current month carries no settled value yet (a service billed in arrears), render its bar at this
  // running MTD figure, muted + hatched, so a partial month reads as an estimate beside the completed months.
  estimateCurrentMonth?: number
}) => {
  const t = useLabels()
  const prefs = useFormat()
  const locale = resolveMoneyLocale(prefs, t.intlLocale)
  const theme = useEchartsTheme()
  const nowMonth = nowMonthKey()

  const stacked = monthly.some((p) => p.category != null) || (daily ?? []).some((p) => p.category != null)
  const hasDaily = (daily?.length ?? 0) > 0
  const [mode, setMode] = useState<'monthly' | 'daily'>('monthly')
  const effectiveMode = hasDaily ? mode : 'monthly'

  const years = useMemo(() => [...new Set(monthly.map((p) => p.key.slice(0, 4)))].sort(), [monthly])
  const [selectedYears, setSelectedYears] = useState<Set<string>>(() => new Set([nowMonth.slice(0, 4)]))
  const showYearPicker = effectiveMode === 'monthly' && years.length > 1

  // Months present in the daily series, sorted — the steppable range. Default to the most recent.
  const dailyMonths = useMemo(() => [...new Set((daily ?? []).map((p) => monthOf(p.key)))].sort(), [daily])
  const [dailyMonth, setDailyMonth] = useState<string>('')
  const activeDailyMonth = dailyMonth && dailyMonths.includes(dailyMonth) ? dailyMonth : (dailyMonths.at(-1) ?? '')
  const monthIndex = dailyMonths.indexOf(activeDailyMonth)

  const monthlyChart = useMemo<EChartsOption>(() => {
    const shown = years.length > 1 ? monthly.filter((p) => selectedYears.has(p.key.slice(0, 4))) : monthly
    const points = shown.map((p) => ({ ...p }))

    // Project the open month from its MTD figure (single series only) when nothing has settled it yet: fill the
    // empty current-month bucket (or append a missing one) with the running total, flagged so it draws as an estimate.
    if (!stacked && estimateCurrentMonth != null && (years.length <= 1 || selectedYears.has(nowMonth.slice(0, 4)))) {
      const cur = points.find((p) => p.key === nowMonth)

      if (cur && cur.value === 0) {
        cur.value = estimateCurrentMonth
        cur.estimated = true
      } else if (!cur) {
        points.push({ key: nowMonth, value: estimateCurrentMonth, estimated: true })
      }
    }

    return buildBarOption(points, monthLabel, {
      stacked,
      isMoney,
      currency,
      locale,
      theme,
      highlightKey: highlightCurrentMonth ? nowMonth : undefined
    })
  }, [
    monthly,
    years,
    selectedYears,
    estimateCurrentMonth,
    stacked,
    isMoney,
    currency,
    locale,
    theme,
    nowMonth,
    highlightCurrentMonth
  ])

  const dailyChart = useMemo<EChartsOption>(() => {
    const days = (daily ?? []).filter((p) => monthOf(p.key) === activeDailyMonth)

    return buildBarOption(days, dayLabel, { stacked, isMoney, currency, locale, theme })
  }, [daily, activeDailyMonth, stacked, isMoney, currency, locale, theme])

  return (
    <Card className="gap-2 py-3">
      <CardHeader className="flex-row items-center justify-between px-4">
        <CardTitle className="text-muted-foreground text-[11px] font-medium">{title}</CardTitle>
        <div className="flex items-center gap-2">
          {effectiveMode === 'daily' && dailyMonths.length > 0 ? (
            <div className="flex items-center gap-1 text-[11px]">
              <button
                type="button"
                disabled={monthIndex <= 0}
                onClick={() => setDailyMonth(dailyMonths[monthIndex - 1] ?? activeDailyMonth)}
                className="text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:hover:text-muted-foreground"
                aria-label="Previous month"
              >
                <ChevronLeft className="size-4" />
              </button>
              <span className="text-foreground min-w-14 text-center tabular-nums">{monthLabel(activeDailyMonth)}</span>
              <button
                type="button"
                disabled={monthIndex < 0 || monthIndex >= dailyMonths.length - 1}
                onClick={() => setDailyMonth(dailyMonths[monthIndex + 1] ?? activeDailyMonth)}
                className="text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:hover:text-muted-foreground"
                aria-label="Next month"
              >
                <ChevronRight className="size-4" />
              </button>
            </div>
          ) : null}

          {showYearPicker ? (
            <YearPicker years={years} selected={selectedYears} onChange={setSelectedYears} t={t} />
          ) : null}

          {hasDaily ? (
            <div className="bg-secondary/50 flex rounded-md p-0.5 text-[11px]">
              {(['monthly', 'daily'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={`rounded px-2 py-0.5 transition-colors ${
                    effectiveMode === m
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {m === 'monthly' ? t.chartMonthly : t.chartDaily}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="px-4">
        <EChart option={effectiveMode === 'daily' ? dailyChart : monthlyChart} height={height} />
      </CardContent>
    </Card>
  )
}

// Multi-select year filter. "All years" clears the filter (every year shows); ticking individual years
// narrows. A year set that excludes everything falls back to showing all (never an empty chart).
const YearPicker = ({
  years,
  selected,
  onChange,
  t
}: {
  years: string[]
  selected: Set<string>
  onChange: (next: Set<string>) => void
  t: { chartYears: string; chartAllYears: string }
}) => {
  const all = years.every((y) => selected.has(y))
  const label = all ? t.chartAllYears : [...selected].sort().join(', ') || t.chartAllYears

  const toggle = (year: string) => {
    const next = new Set(selected)

    if (next.has(year)) {
      next.delete(year)
    } else {
      next.add(year)
    }

    if (next.size === 0) {
      for (const y of years) {
        next.add(y)
      }
    }

    onChange(next)
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t.chartYears}
        className="bg-secondary/50 hover:bg-secondary text-muted-foreground hover:text-foreground flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] transition-colors"
      >
        {label}
        <ChevronDown className="size-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuCheckboxItem checked={all} onCheckedChange={() => onChange(new Set(years))}>
          {t.chartAllYears}
        </DropdownMenuCheckboxItem>
        {years.map((y) => (
          <DropdownMenuCheckboxItem key={y} checked={selected.has(y)} onCheckedChange={() => toggle(y)}>
            {y}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
