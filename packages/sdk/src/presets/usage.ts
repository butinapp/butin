import { capabilityResult, record, table } from '../data/builders.js'
import type { Column } from '../data/dataset.js'
import type { CapabilityResult } from '../data/result.js'
import type { Summary } from '../data/summary.js'
import { round2 } from '../util/money.js'

import { dailySeries, type TrendPoint } from './blocks.js'

// One metered line — tokens/requests/seats/GB. value is a plain count; cost (USD) is optional on-demand spend.
export interface UsageMetricInput {
  label: string
  value: number
  unit?: string
  limit?: number | null
  cost?: number | null
}

export interface UsageInput {
  periodStart?: string
  periodEnd?: string
  metrics: UsageMetricInput[]
  // Optional daily trend → a timeseries view; when a cost summary is emitted it gets this as its spark.
  daily?: TrendPoint[]
  dailyTitle?: string
}

interface MetricRow {
  label: string
  value: number
  unit: string | null
  limit: number | null
  cost: number | null
}

// The usage preset: a per-metric table + an 'other'-section money summary when any metric carries a cost (shown
// per-service on the Overview, never summed into the spend total). A headline record (on-demand spend, period)
// precedes the table only when there's a spend or period to show — a bare metric COUNT would just echo the
// table's own row count, so it's never surfaced.
export const usageResult = (input: UsageInput): CapabilityResult => {
  const totalCost = input.metrics.reduce((sum, m) => sum + (m.cost ?? 0), 0)
  const hasCost = input.metrics.some((m) => m.cost != null)
  const period = [input.periodStart, input.periodEnd].filter(Boolean).join(' → ')

  const headFields: Column[] = []
  const headValue: Record<string, unknown> = {}

  if (hasCost) {
    headFields.push({ key: 'spend', role: 'money', label: 'On-demand spend' })
    headValue.spend = round2(totalCost)
  }

  if (period) {
    headFields.push({ key: 'period', role: 'text', label: 'Period' })
    headValue.period = period
  }

  const usage = headFields.length
    ? record.fromColumns({ id: 'usage', fields: headFields, value: headValue }).stat()
    : undefined

  const metrics = table<MetricRow>({
    id: 'metrics',
    columns: [
      { key: 'label', role: 'label', label: 'Metric' },
      { key: 'value', role: 'count', label: 'Used' },
      { key: 'unit', role: 'label', label: 'Unit' },
      { key: 'limit', role: 'count', label: 'Limit' },
      { key: 'cost', role: 'money', label: 'Cost' }
    ],
    rows: input.metrics.map((m) => ({
      label: m.label,
      value: m.value,
      unit: m.unit ?? null,
      limit: m.limit ?? null,
      cost: m.cost ?? null
    })),
    // The metric label is the stable identity — key it so each metric's value accumulates in the ledger
    // (the per-metric usage history + per-row trend). An unkeyed table carries no history.
    key: 'label'
  })

  // The daily trend renders between the stat and the per-metric table (stat → chart → table).
  const daily = input.daily?.length
    ? dailySeries('daily', input.daily, { title: input.dailyTitle ?? 'Daily cost' })
    : undefined

  const summary: Summary | undefined = hasCost
    ? {
        section: 'other',
        label: 'On-demand spend',
        value: round2(totalCost),
        role: 'money',
        ...(input.daily?.length
          ? { spark: { dataset: 'daily', x: 'date', y: input.daily.some((d) => d.cost != null) ? 'cost' : 'value' } }
          : {})
      }
    : undefined

  return capabilityResult({
    sections: [usage, daily, metrics.table({ title: 'Usage' })],
    summaries: summary ? [summary] : undefined
  })
}
