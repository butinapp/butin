import { fireEvent, render, screen } from '@testing-library/react'
import type { EChartsOption } from 'echarts'
import { beforeEach, expect, test, vi } from 'vitest'

// Capture the option fed to the chart so we can assert the series/axis the controls produce, without
// booting echarts (no canvas in jsdom).
const captured = vi.hoisted(() => ({ option: undefined as EChartsOption | undefined }))

vi.mock('../../components/echart.js', () => ({
  EChart: ({ option }: { option: EChartsOption }) => {
    captured.option = option

    return <div data-testid="chart" />
  }
}))

import { TimeseriesChart } from './timeseries-chart.js'
import type { ChartPoint } from './view-models.js'

const Y = new Date().getFullYear()

const monthlyTwoYears: ChartPoint[] = [
  { key: `${Y - 1}-11`, value: 10 },
  { key: `${Y - 1}-12`, value: 20 },
  { key: `${Y}-01`, value: 5 },
  { key: `${Y}-02`, value: 7 }
]

const daily: ChartPoint[] = [
  { key: `${Y}-01-10`, value: 3 },
  { key: `${Y}-01-11`, value: 4, estimated: true },
  { key: `${Y}-02-01`, value: 2 },
  { key: `${Y}-02-02`, value: 6 }
]

const seriesData = (): { value: number; itemStyle?: { decal?: unknown } }[] =>
  (captured.option?.series as { data: { value: number; itemStyle?: { decal?: unknown } }[] }[])[0]!.data

const xAxisData = (): string[] => (captured.option?.xAxis as { data: string[] }).data

const nowMonth = (() => {
  const d = new Date()

  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
})()

beforeEach(() => {
  captured.option = undefined
})

test('hides the Daily toggle when no daily series is provided', () => {
  render(<TimeseriesChart monthly={monthlyTwoYears} isMoney title="Spend" />)

  expect(screen.queryByText('Daily')).not.toBeInTheDocument()
})

test('defaults the monthly view to the current year only', () => {
  render(<TimeseriesChart monthly={monthlyTwoYears} isMoney title="Spend" />)

  // Two prior-year months are filtered out; only the two current-year months remain.
  expect(xAxisData()).toHaveLength(2)
})

test('shows the year picker only when more than one year has data', () => {
  const { rerender } = render(<TimeseriesChart monthly={monthlyTwoYears} isMoney title="Spend" />)

  expect(screen.getByLabelText('Years')).toBeInTheDocument()

  rerender(<TimeseriesChart monthly={[{ key: `${Y}-01`, value: 5 }]} isMoney title="Spend" />)
  expect(screen.queryByLabelText('Years')).not.toBeInTheDocument()
})

test('a daily series enables the Monthly|Daily toggle and opens in Monthly', () => {
  render(<TimeseriesChart monthly={monthlyTwoYears} daily={daily} isMoney title="Spend" />)

  // Both toggle buttons render; Monthly is the active default so its year picker (a monthly-mode control) shows.
  expect(screen.getByText('Daily')).toBeInTheDocument()
  expect(screen.getByText('Monthly')).toBeInTheDocument()
  expect(screen.getByLabelText('Years')).toBeInTheDocument()
})

test('the Daily toggle switches to the most recent month at day resolution', () => {
  render(<TimeseriesChart monthly={monthlyTwoYears} daily={daily} isMoney title="Spend" />)

  fireEvent.click(screen.getByText('Daily'))

  // Latest captured month (Feb) shows its two days.
  expect(xAxisData()).toEqual(['Feb 1', 'Feb 2'])
  expect(seriesData()).toHaveLength(2)
})

test('a stacked monthly series renders a legend of its categories', () => {
  const stacked: ChartPoint[] = [
    { key: `${Y}-01`, value: 4, category: 'Seats' },
    { key: `${Y}-01`, value: 6, category: 'Usage' }
  ]

  render(<TimeseriesChart monthly={stacked} isMoney title="Spend by category" />)

  // The legend names each category; the chart renders two stacked series.
  expect((captured.option?.legend as { data: string[] }).data).toEqual(['Seats', 'Usage'])
  expect(captured.option?.series).toHaveLength(2)
})

test('projects the open current month from its MTD estimate as a hatched bar', () => {
  // The current month has no settled bucket yet (billed in arrears); the estimate fills it + flags it.
  render(<TimeseriesChart monthly={[{ key: nowMonth, value: 0 }]} estimateCurrentMonth={57} isMoney title="Spend" />)

  const data = seriesData()

  expect(data[0]?.value).toBe(57)
  expect(data[0]?.itemStyle?.decal).toBeDefined()
})

test('leaves a settled current-month bucket untouched, ignoring the estimate', () => {
  render(<TimeseriesChart monthly={[{ key: nowMonth, value: 80 }]} estimateCurrentMonth={57} isMoney title="Spend" />)

  const data = seriesData()

  expect(data[0]?.value).toBe(80)
  expect(data[0]?.itemStyle?.decal).toBeUndefined()
})

test('the month stepper pages within the captured range and surfaces estimated days', () => {
  render(<TimeseriesChart monthly={monthlyTwoYears} daily={daily} isMoney title="Spend" />)

  fireEvent.click(screen.getByText('Daily'))

  // On the most recent month: cannot step forward, can step back.
  expect(screen.getByLabelText('Next month')).toBeDisabled()
  expect(screen.getByLabelText('Previous month')).not.toBeDisabled()

  fireEvent.click(screen.getByLabelText('Previous month'))

  expect(xAxisData()).toEqual(['Jan 10', 'Jan 11'])
  // The Jan 11 gap-filled day carries a decal (hatch); the measured Jan 10 day does not.
  const data = seriesData()

  expect(data[0]?.itemStyle?.decal).toBeUndefined()
  expect(data[1]?.itemStyle?.decal).toBeDefined()
  // At the earliest month, stepping back is disabled.
  expect(screen.getByLabelText('Previous month')).toBeDisabled()
})
