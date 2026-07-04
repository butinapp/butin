import { record, table, type ViewSpec } from '../data/builders.js'
import type { Column } from '../data/dataset.js'
import { round2 } from '../util/money.js'

// Composable building blocks for collect() results. Each returns a `ViewSpec` a plugin mixes into any
// CapabilityResult — the lego layer under the opinionated presets (billingResult/usageResult), for rich
// tabs that outgrow a single preset call. Pure data; fixture-tested in blocks.test.ts.

// The metered overage above a plan's base fee = max(0, total − base), rounded to cents. null when either side
// is unknown, so the Overage cell shows an em-dash rather than a misleading 0. Negative deltas (a base fee not
// yet invoiced this period) clamp to 0, never a negative overage.
export const overageOf = (total: number | null | undefined, base: number | null | undefined): number | null =>
  total != null && base != null ? round2(Math.max(0, total - base)) : null

// A timestamped cost/usage trend → a table dataset + a timeseries view. `y` is 'cost' when any row carries a
// cost (money), else 'value' (count) — so a daily-spend series and a daily-request series both work.
export interface TrendPoint {
  date: string
  cost?: number
  value?: number
}

export const dailySeries = (
  id: string,
  rows: TrendPoint[],
  opts: { title?: string; currency?: string; valueLabel?: string } = {}
): ViewSpec => {
  const isCost = rows.some((r) => r.cost != null)
  const yLabel = opts.valueLabel ?? (isCost ? 'Cost' : 'Usage')

  // Keyed on the day so each date accumulates as its own row — the full daily history outlives a rolling window.
  if (isCost) {
    const t = table<{ date: string; cost: number }>({
      id,
      columns: [
        { key: 'date', label: 'Date', role: 'timestamp' },
        { key: 'cost', label: yLabel, role: 'money', currency: opts.currency }
      ],
      rows: rows.map((r) => ({ date: r.date, cost: r.cost ?? 0 })),
      key: 'date'
    })

    return t.timeseries({ x: 'date', y: 'cost', granularity: 'daily', title: opts.title ?? 'Daily cost' })
  }

  const t = table<{ date: string; value: number }>({
    id,
    columns: [
      { key: 'date', label: 'Date', role: 'timestamp' },
      { key: 'value', label: yLabel, role: 'count' }
    ],
    rows: rows.map((r) => ({ date: r.date, value: r.value ?? 0 })),
    key: 'date'
  })

  return t.timeseries({ x: 'date', y: 'value', granularity: 'daily', title: opts.title ?? 'Daily usage' })
}

// Credits / balance keyvalue panel. Omitted fields are skipped — no em-dash rows for figures a service lacks.
export interface CreditsInput {
  granted?: number
  balance?: number
  used?: number
  netSpend?: number
  currency?: string
}

const CREDIT_FIELDS: { key: keyof CreditsInput; label: string }[] = [
  { key: 'netSpend', label: 'Net spend' },
  { key: 'used', label: 'Credits used' },
  { key: 'balance', label: 'Credit balance' },
  { key: 'granted', label: 'Credit granted' }
]

export const creditsRecord = (input: CreditsInput, opts: { id?: string; title?: string } = {}): ViewSpec => {
  const id = opts.id ?? 'credits'
  const fields: Column[] = []
  const value: Record<string, unknown> = {}

  for (const f of CREDIT_FIELDS) {
    if (input[f.key] != null) {
      fields.push({ key: f.key, label: f.label, role: 'money', currency: input.currency })
      value[f.key] = input[f.key]
    }
  }

  return record.fromColumns({ id, fields, value }).keyvalue({
    title: opts.title ?? 'Credits & spend'
  })
}

// Subscription-detail keyvalue panel — the breakdown behind the Summary headline, shown first on the Billing
// tab. Period start+end collapse into one 'period' cell. Absent fields are skipped so a service that lacks one
// shows no row for it (no em-dash clutter).
export interface SubscriptionInput {
  plan?: string
  status?: string
  seats?: number
  unitPrice?: number // per-seat / per-unit recurring price (USD)
  periodStart?: string // 'YYYY-MM-DD'
  periodEnd?: string // 'YYYY-MM-DD'
  currency?: string
  title?: string
}

export const subscriptionRecord = (input: SubscriptionInput): ViewSpec => {
  const fields: Column[] = []
  const value: Record<string, unknown> = {}

  if (input.plan != null) {
    fields.push({ key: 'plan', label: 'Plan', role: 'label' })
    value.plan = input.plan
  }

  if (input.status != null) {
    fields.push({ key: 'status', label: 'Status', role: 'label' })
    value.status = input.status
  }

  if (input.seats != null) {
    fields.push({ key: 'seats', label: 'Seats', role: 'count' })
    value.seats = input.seats
  }

  if (input.unitPrice != null) {
    fields.push({ key: 'unitPrice', label: 'Unit price', role: 'money', currency: input.currency })
    value.unitPrice = input.unitPrice
  }

  const period = [input.periodStart, input.periodEnd].filter(Boolean).join(' → ')

  if (period) {
    fields.push({ key: 'period', label: 'Period', role: 'text' })
    value.period = period
  }

  return record.fromColumns({ id: 'subscription', fields, value }).keyvalue({
    title: input.title ?? 'Subscription'
  })
}

// Payment-method keyvalue panel.
export interface PaymentMethodInput {
  brand: string
  last4: string
  title?: string
}

export const paymentMethodRecord = (
  input: PaymentMethodInput,
  opts: { id?: string; title?: string } = {}
): ViewSpec => {
  const id = opts.id ?? 'paymentMethod'
  const fields: Column[] = [
    { key: 'brand', label: 'Card', role: 'label' },
    { key: 'last4', label: 'Last 4', role: 'label' }
  ]
  const value: Record<string, unknown> = { brand: input.brand, last4: input.last4 }

  if (input.title) {
    fields.push({ key: 'title', label: 'Title', role: 'label' })
    value.title = input.title
  }

  return record.fromColumns({ id, fields, value }).keyvalue({
    title: opts.title ?? 'Payment method'
  })
}
