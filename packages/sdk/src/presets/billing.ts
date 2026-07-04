import {
  capabilityResult,
  type FileTableSpec,
  record,
  type StatFieldSpec,
  table,
  type ViewSpec
} from '../data/builders.js'
import type { BadgeTone, Column, SemanticRole } from '../data/dataset.js'
import type { CapabilityResult } from '../data/result.js'
import type { MonthPoint } from '../data/series.js'
import { resolveTableFiles, type TableFiles } from '../data/view.js'
import { round2 } from '../util/money.js'

import { type CreditsInput, creditsRecord, type PaymentMethodInput, paymentMethodRecord } from './blocks.js'
import { isAccrualBasis, type MtdBasis } from './mtd-basis.js'

// One already-normalized USD invoice — the canonical invoice shape the billing preset + plugins map their raw
// payload into (via money.ts), one definition so the two can't drift.
export interface BillingInvoiceInput {
  // Stable provider id, when the service exposes one — the accumulation key so an invoice survives the rolling
  // window. Absent → the billing preset derives one from date+amount.
  id?: string
  // Period the spend was INCURRED (not the issue date), 'YYYY-MM-DD' UTC — drives the monthly rollup. Omitted
  // for undated invoices.
  date?: string
  status: string
  // Grand total in USD dollars, normalized from the provider's native unit.
  amount: number
  hostedUrl?: string | null
  pdfUrl?: string | null
}

export interface BillingInput {
  currentMtd: number | null // USD MTD spend; null when the provider exposes no running figure
  baseFee?: number | null // fixed plan floor this period (USD); renders a 'Base' cell when defined
  meteredMtd?: number | null // variable spend above the base this period (USD) = overage; renders an 'Overage' cell
  mtdBasis?: MtdBasis // what currentMtd measures; defaults to 'invoiced'
  plan?: string
  currency?: string
  invoices: BillingInvoiceInput[]
  statusTones?: Record<string, BadgeTone> // override/extend the default invoice-status badge tones
  credits?: CreditsInput // optional credits/balance keyvalue panel
  paymentMethod?: PaymentMethodInput // optional payment-method keyvalue panel
  invoiceDownload?: TableFiles | true // true → the default fileTable wiring; or an explicit override
}

// The fileTable spec for the default `invoiceDownload: true`: the host GETs each row's pdfUrl and saves it
// named from the row's `name` column. A plugin can pass an explicit TableFiles descriptor to override.
const DEFAULT_INVOICE_FILES: FileTableSpec<InvoiceRow> = {
  title: 'Invoices',
  name: 'name',
  source: { url: 'pdfUrl' },
  ext: 'pdf',
  category: 'Invoices'
}

// Bucket invoice amounts by calendar month (ascending) → the monthly-spend series both the Summary chart
// and the cross-service Overview spark read. Rounded once per month to avoid IEEE-754 drift (0.1+0.2≠0.3).
// Undated invoices can't bucket onto the monthly axis, so they're skipped.
export const monthlySpend = (invoices: BillingInvoiceInput[]): MonthPoint[] => {
  const byMonth = new Map<string, number>()

  for (const inv of invoices) {
    if (!inv.date) {
      continue
    }

    const month = inv.date.slice(0, 7)

    byMonth.set(month, (byMonth.get(month) ?? 0) + inv.amount)
  }

  return [...byMonth.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, amount]) => ({ month, amount: round2(amount) }))
}

// The change from the previous period, in the same money unit (positive = spending more). The baseline depends
// on what currentMtd measures: an invoiced/last-invoice figure IS the latest month in the series, so it's
// compared against the prior month; a live figure (accrued/upcoming/flat) is compared against the last full
// month (the latest series entry). undefined when there's no currentMtd or no baseline month to compare against.
const monthOverMonthDelta = (months: MonthPoint[], currentMtd: number | null, basis?: MtdBasis): number | undefined => {
  if (currentMtd == null) {
    return undefined
  }

  const baseline = isAccrualBasis(basis) ? months.at(-1) : months.at(-2)

  return baseline ? round2(currentMtd - baseline.amount) : undefined
}

// An extra headline stat folded into the Summary `account` record, after currentMtd (and plan, if given).
// `value` is whatever the role expects (a number for money/count, a string for label/identifier/timestamp…).
// The rich-stat fields (max/unit/caption/tone) ride onto the stat view so the card can show a progress bar
// (value/max), a unit suffix, a caption/breakdown line, or a tinted value.
export interface BillingStat {
  key: string
  label: string
  role: SemanticRole
  value: unknown
  currency?: string
  badges?: Record<string, BadgeTone> // for role:'status' stats — value → tone (e.g. delinquent → danger)
  max?: number // denominator → renders 'value / max' + a progress bar
  unit?: string // muted suffix after the value (e.g. '/mo')
  caption?: string // a subtext/breakdown line under the value
  tone?: 'positive' | 'negative' | 'muted' // value tint
}

export interface BillingSummaryInput {
  currentMtd: number | null // USD (or the input.currency) MTD spend; null → no headline value + no summary
  currentMtdLabel?: string // the currentMtd field + summary label (default 'This month')
  currentMtdCaption?: string // caption under the headline (e.g. 'invoiced · CAD' to disambiguate the currency)
  baseFee?: number | null // fixed plan floor this period (USD); renders a 'Base' cell when defined
  meteredMtd?: number | null // variable spend above the base this period (USD) = overage; renders an 'Overage' cell
  mtdBasis?: MtdBasis // what currentMtd measures; defaults to 'invoiced'
  currency?: string
  plan?: string // when defined, adds a Plan stat (null → em-dash)
  invoices: BillingInvoiceInput[] // source for the monthly-spend chart (the spark target)
  stats?: BillingStat[] // extra headline stats (invoice count, prepaid balance, account #, …)
  monthlyTitle?: string // the monthly chart title (default 'Monthly spend')
  // Show the "Δ vs last month" stat (default true). Set false when currentMtd and the invoice series measure
  // different things (e.g. a live open-period figure against overlapping multi-month invoices) so the delta
  // would compare incomparable bases.
  showDelta?: boolean
}

// The invoices table row. `id` + `name` ride hidden: `id` keys the dataset so invoices accumulate past the
// rolling window; `name` names each downloaded file. Both are filtered from display + export.
type InvoiceRow = {
  id: string
  date: string | null
  amount: number
  status: string
  pdfUrl: string | null
  name: string
}

const monthlyTable = (months: MonthPoint[], currency?: string) =>
  table<MonthPoint>({
    id: 'monthly',
    columns: [
      { key: 'month', label: 'Month', role: 'timestamp' },
      { key: 'amount', label: 'Spend', role: 'money', currency }
    ],
    rows: months,
    key: 'month'
  })

// The Summary preset: a headline `account` stat (currentMtd + optional plan + caller
// stats) + the monthly-spend chart (the Overview spark) + the spend.mtd summary. Deliberately carries NO
// invoices table — that's the thinner detail ('invoicing') tab. So a billing plugin's Summary collect() is
// `return billingSummaryResult({...})`, and its detail tab builds the invoices table (+ any extras).
export const billingSummaryResult = (input: BillingSummaryInput): CapabilityResult => {
  const label = input.currentMtdLabel ?? 'This month'
  const fields: Column[] = [{ key: 'currentMtd', label, role: 'money', currency: input.currency }]
  const value: Record<string, unknown> = { currentMtd: input.currentMtd }
  // Parallel to `fields`: each field's stat-card presentation (denominator/unit/caption/tone). A bare key
  // renders plain; a spec adds the rich layers. Order tracks `fields` so cards render in the declared order.
  const statFields: (string | StatFieldSpec<Record<string, unknown>>)[] = [
    input.currentMtdCaption ? { key: 'currentMtd', caption: input.currentMtdCaption } : 'currentMtd'
  ]

  if (input.baseFee !== undefined) {
    fields.push({ key: 'baseFee', label: 'Base', role: 'money', currency: input.currency })
    value.baseFee = input.baseFee
    statFields.push('baseFee')
  }

  if (input.meteredMtd !== undefined) {
    fields.push({ key: 'meteredMtd', label: 'Overage', role: 'money', currency: input.currency })
    value.meteredMtd = input.meteredMtd
    statFields.push('meteredMtd')
  }

  if (input.plan !== undefined) {
    fields.push({ key: 'plan', label: 'Plan', role: 'label' })
    value.plan = input.plan ?? null
    statFields.push('plan')
  }

  const months = monthlySpend(input.invoices)
  const delta = input.showDelta === false ? undefined : monthOverMonthDelta(months, input.currentMtd, input.mtdBasis)

  if (delta !== undefined) {
    fields.push({ key: 'momDelta', label: 'Δ vs last month', role: 'money', currency: input.currency })
    value.momDelta = delta
    // Spending less than the baseline is the good direction → green; more → red.
    statFields.push({ key: 'momDelta', tone: delta < 0 ? 'positive' : delta > 0 ? 'negative' : 'muted' })
  }

  for (const stat of input.stats ?? []) {
    fields.push({ key: stat.key, label: stat.label, role: stat.role, currency: stat.currency, badges: stat.badges })
    value[stat.key] = stat.value
    statFields.push(
      stat.max != null || stat.unit != null || stat.caption != null || stat.tone != null
        ? { key: stat.key, max: stat.max, unit: stat.unit, caption: stat.caption, tone: stat.tone }
        : stat.key
    )
  }

  const account = record.fromColumns({ id: 'account', fields, value })
  const monthly = monthlyTable(months, input.currency)

  const s =
    input.currentMtd != null
      ? monthly.summary({
          section: 'spend',
          label,
          value: input.currentMtd,
          currency: input.currency,
          basis: input.mtdBasis ?? 'invoiced',
          x: 'month',
          y: 'amount'
        })
      : undefined

  return capabilityResult({
    sections: [
      account.stat({ fields: statFields }),
      monthly.timeseries({
        x: 'month',
        y: 'amount',
        granularity: 'monthly',
        title: input.monthlyTitle ?? 'Monthly spend'
      })
    ],
    summaries: s ? [s] : undefined
  })
}

// The billing preset: build the role-tagged datasets, the default views, and the spend.mtd summary,
// so a single-tab billing plugin's whole collect() is `return billingResult({...})`. (Plugins that split
// into Summary + detail tabs use billingSummaryResult + their own invoices table instead.)
export const billingResult = (input: BillingInput): CapabilityResult => {
  const invoices = table<InvoiceRow>({
    id: 'invoices',
    columns: [
      { key: 'date', label: 'Date', role: 'timestamp' },
      { key: 'amount', label: 'Amount', role: 'money', currency: input.currency },
      { key: 'status', label: 'Status', role: 'status', badges: input.statusTones },
      { key: 'pdfUrl', label: 'PDF', role: 'url' },
      { key: 'id', role: 'identifier', hidden: true },
      { key: 'name', role: 'label', hidden: true }
    ],
    rows: input.invoices.map((i) => ({
      // `id` (provider id, else a date+amount fallback) keys the dataset so invoices accumulate past the window.
      id: i.id ?? `${i.date ?? 'undated'}:${i.amount}`,
      date: i.date ?? null,
      amount: i.amount,
      status: i.status,
      pdfUrl: i.pdfUrl ?? i.hostedUrl ?? null,
      // The download host names each file from this column; absent it falls back to the row index.
      name: `Invoice ${i.date ?? 'unknown'}`
    })),
    key: 'id'
  })

  const invoicesSection: ViewSpec =
    input.invoiceDownload === true
      ? invoices.fileTable(DEFAULT_INVOICE_FILES)
      : input.invoiceDownload
        ? invoices.fileTable(fileTableFromOverride(input.invoiceDownload))
        : invoices.table({ title: 'Invoices' })

  const accountFields: Column[] = [{ key: 'currentMtd', label: 'This month', role: 'money', currency: input.currency }]
  const accountValue: Record<string, unknown> = { currentMtd: input.currentMtd }

  if (input.baseFee !== undefined) {
    accountFields.push({ key: 'baseFee', label: 'Base', role: 'money', currency: input.currency })
    accountValue.baseFee = input.baseFee
  }

  if (input.meteredMtd !== undefined) {
    accountFields.push({ key: 'meteredMtd', label: 'Overage', role: 'money', currency: input.currency })
    accountValue.meteredMtd = input.meteredMtd
  }

  const months = monthlySpend(input.invoices)
  const delta = monthOverMonthDelta(months, input.currentMtd, input.mtdBasis)

  if (delta !== undefined) {
    accountFields.push({ key: 'momDelta', label: 'Δ vs last month', role: 'money', currency: input.currency })
    accountValue.momDelta = delta
  }

  accountFields.push({ key: 'plan', label: 'Plan', role: 'label' })
  accountValue.plan = input.plan ?? null

  const account = record.fromColumns({ id: 'account', fields: accountFields, value: accountValue })
  const monthly = monthlyTable(months, input.currency)

  const pm = input.paymentMethod ? paymentMethodRecord(input.paymentMethod) : undefined
  const credits = input.credits
    ? creditsRecord({ ...input.credits, currency: input.credits.currency ?? input.currency })
    : undefined

  const s =
    input.currentMtd != null
      ? monthly.summary({
          section: 'spend',
          label: 'This month',
          value: input.currentMtd,
          currency: input.currency,
          basis: input.mtdBasis ?? 'invoiced',
          x: 'month',
          y: 'amount'
        })
      : undefined

  return capabilityResult({
    sections: [
      account.stat(),
      pm,
      credits,
      monthly.timeseries({ x: 'month', y: 'amount', granularity: 'monthly', title: 'Monthly spend' }),
      invoicesSection
    ],
    summaries: s ? [s] : undefined
  })
}

// Normalize an explicit TableFiles override (`source`/`name`/`folder`) into a fileTable spec, defaulting the
// same wiring as `invoiceDownload: true`.
const fileTableFromOverride = (override: TableFiles): FileTableSpec<InvoiceRow> => {
  const { urlKey, nameKey, folderKey, ext, category, useFetch } = resolveTableFiles(override)

  return {
    title: 'Invoices',
    name: (nameKey ?? 'name') as keyof InvoiceRow & string,
    source: useFetch ? { fetch: true } : { url: (urlKey ?? 'pdfUrl') as keyof InvoiceRow & string },
    ext,
    category: category ?? 'Invoices',
    folder: folderKey as (keyof InvoiceRow & string) | undefined
  }
}
