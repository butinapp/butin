import {
  defineCapability,
  defineConfigSchema,
  definePlugin,
  type CollectContext,
  type ConfigOf,
  type ConfigOption
} from '@butinapp/sdk'
import { capabilityResult, record, table, type CapabilityResult } from '@butinapp/sdk/data'
import { billing, members, usage, type MembersInput, type UsageMetricInput } from '@butinapp/sdk/presets'
import { byDayAsc, byDayDesc, centsToMajor, epochSecDay, isoDay, normalizeCurrency } from '@butinapp/sdk/util'

import { sampleIntercomAdmins, sampleIntercomBilling, sampleIntercomUsage } from './sample.js'

// Intercom (app.intercom.com), the customer-support / messaging platform. Four read-only tabs over one
// cookie session:
//   1. Summary — the overview: the in-progress period's running total + the monthly-spend trend chart (the
//      cross-service Overview rolls up its spend.mtd). Plan/totals/invoices live on Billing, not here.
//   2. Billing — the subscription account record (plan, period, totals, total billed), the per-product line
//      breakdown, and the downloadable invoice history. Intercom bills monthly on a seat-based plan plus add-ons.
//   3. Usage — per-billable-metric current consumption vs included allowance + a daily seat/activity trend.
//   4. Members — the workspace teammate roster.
// Summary + Billing share one billing fetch (the query cache dedupes it).
//
// TRANSPORT: Intercom's billing UI is an Ember SPA backed by plain-JSON `/ember/*` endpoints. app.intercom.com
// is fronted by nginx, NOT Cloudflare (no cf_clearance/__cf_bm in the jar), so plain `node` transport works.
// AUTH is the Rails session cookie `_intercom_session` (HttpOnly), replayed verbatim (cookie auth, clear on
// 401 only — a 403 is a per-endpoint permission gap). The endpoints we read are all GET, so the browser's
// X-CSRF-Token is not required (Rails only enforces CSRF on non-GET).
//
// Every `/ember/*` request must carry the workspace ("app") id as an `app_id` query param. That id is a stable
// per-workspace identifier (not a secret), picked from a combobox whose options the session self-lists
// (`/ember/admins/apps.json`) and read via `ctx.config.appId`.
//
// MIXED money units: the subscription / current-period endpoints report cents. The invoice list is
// heterogeneous — native invoice rows carry `amount` already in dollars, while raw Stripe invoice objects
// (`object:'invoice'`) carry `total`/`amount_due` in cents plus hosted/PDF links. `normalizeInvoice`
// branches on `object`.

const ORIGIN = 'https://app.intercom.com'

// ── billing endpoints ─────────────────────────────────────────────────────────────────
const INVOICES = '/ember/invoices'
const SUBSCRIPTION = '/ember/billing/customer_subscription_details'
const CURRENT_PERIOD = '/ember/billing/current_billing_period_charges'
const APP_DETAILS = '/ember/billing/app_billing_details'
// ── usage endpoints ───────────────────────────────────────────────────────────────────
const USAGE = '/ember/usage'
const PRICING_METRICS = '/ember/billing/current_active_pricing_metrics'
// ── members endpoint ──────────────────────────────────────────────────────────────────
// The teammate roster rides on the app object's `admins` attribute (id_code in the path, no app_id param).
const adminsPath = (id: string): string => `/ember/apps/${id}.json?attribute_allowlist=admins`
// The session's workspace list (no app_id needed) — feeds the appId combobox.
const APPS = '/ember/admins/apps.json'

// ── types: billing wire shapes (only the fields we read) ────────────────────────────────

// Intercom-native invoice: `amount` is already in dollars.
export interface RawNativeInvoice {
  object?: undefined
  id?: string
  number?: string
  amount?: number
  balance?: number
  due_date?: string
  invoice_date?: string
  status?: string
}

// A raw Stripe invoice object: money in cents.
export interface RawStripeInvoice {
  object: 'invoice'
  id?: string
  number?: string
  total?: number
  amount_due?: number
  created?: number // epoch seconds
  currency?: string
  status?: string
  hosted_invoice_url?: string | null
  invoice_pdf?: string | null
}

export type RawInvoice = RawNativeInvoice | RawStripeInvoice

export interface RawSubscriptionItem {
  id?: string
  quantity?: number
  total_amount?: number // cents
  pricing_metric?: string
  nickname?: string
}

export interface RawSubscriptionItemGroup {
  product_name?: string
  items?: RawSubscriptionItem[]
}

export interface RawProduct {
  type?: string
  id?: string
  total_amount?: number // cents
  items?: RawSubscriptionItemGroup[]
}

export interface RawSubscriptionDetails {
  next_payment_date?: string
  current_period_start?: string
  current_period_end?: string
  cadence?: string
  subtotal_amount?: number // cents
  total_amount?: number // cents
  total_discount_amount?: number // cents
  total_discount_percentage?: number // percent
  is_renewal_month?: boolean
  products?: RawProduct[]
  customer_type?: string
  intercom_account_credit?: number // cents
}

export interface RawCurrentPeriodCharges {
  invoice_date?: string
  current_period_start?: string
  current_period_end?: string
  subtotal_amount?: number // cents
  total_amount?: number // cents
  amount_due?: number // cents
  amount_paid?: number // cents
  total_discount_amount?: number // cents
  is_renewal_month?: boolean
}

export interface RawAppBillingDetails {
  cadence?: string
  customer_type?: string
  in_trial?: boolean
  seat_based?: boolean
}

// ── types: normalized billing domain (DOLLARS) ──────────────────────────────────────────

export interface IntercomInvoice {
  id: string
  number: string
  date?: string // YYYY-MM-DD
  status: string
  amount: number // dollars
  hostedUrl?: string | null
  pdfUrl?: string | null
}

export interface IntercomProductLine {
  name: string // display name, e.g. 'Full seats'
  pricingMetric: string // e.g. 'core_seat_count'
  quantity: number
  totalUsd: number
}

export interface IntercomSubscription {
  plan: string
  planName: string
  cadence: string
  customerType: string
  seatBased: boolean
  inTrial: boolean
  currentPeriodStart?: string
  currentPeriodEnd?: string
  nextPaymentDate?: string
  subtotalUsd: number // pre-discount
  totalUsd: number // post-discount
  discountUsd: number
  discountPercentage: number // 0–100
  products: IntercomProductLine[]
  creditUsd: number
}

export interface IntercomCurrentPeriod {
  invoiceDate?: string
  periodStart?: string
  periodEnd?: string
  subtotalUsd: number
  totalUsd: number
  amountDueUsd: number
  amountPaidUsd: number
  discountUsd: number
  isRenewalMonth: boolean
}

export interface IntercomBillingReport {
  subscription: IntercomSubscription
  currentPeriod: IntercomCurrentPeriod
  // Finalized invoices, newest-first.
  invoices: IntercomInvoice[]
  // Sum of all invoice totals, dollars.
  totalBilled: number
  // The in-progress period's running total — the live MTD, or null when no period is open.
  currentMtd: number | null
  currency: string
}

// ── billing transforms (pure, fixture-tested) ───────────────────────────────────────────

// Normalize one invoice row to dollars, branching on native vs Stripe shape.
export const normalizeInvoice = (raw: RawInvoice): IntercomInvoice => {
  if (raw && raw.object === 'invoice') {
    return {
      id: raw.id ?? '',
      number: raw.number ?? '',
      date: epochSecDay(raw.created),
      status: raw.status ?? 'unknown',
      amount: centsToMajor(raw.total ?? raw.amount_due),
      hostedUrl: raw.hosted_invoice_url ?? null,
      pdfUrl: raw.invoice_pdf ?? null
    }
  }

  const n = raw as RawNativeInvoice

  return {
    id: n.id ?? '',
    number: n.number ?? '',
    date: isoDay(n.invoice_date ?? n.due_date),
    status: n.status ?? 'unknown',
    amount: n.amount ?? 0,
    hostedUrl: null,
    pdfUrl: null
  }
}

const buildSubscription = (sub: RawSubscriptionDetails, app: RawAppBillingDetails): IntercomSubscription => {
  const core = (sub.products ?? []).find((p) => p.type === 'core') ?? (sub.products ?? [])[0]
  const group = (core?.items ?? [])[0]
  const products: IntercomProductLine[] = (sub.products ?? []).flatMap((p) =>
    (p.items ?? []).flatMap((g) =>
      (g.items ?? []).map((item) => ({
        name: item.nickname ?? g.product_name ?? item.pricing_metric ?? 'item',
        pricingMetric: item.pricing_metric ?? '',
        quantity: item.quantity ?? 0,
        totalUsd: centsToMajor(item.total_amount)
      }))
    )
  )

  return {
    plan: core?.id ?? 'unknown',
    planName: group?.product_name ?? core?.id ?? 'unknown',
    cadence: sub.cadence ?? app.cadence ?? 'unknown',
    customerType: sub.customer_type ?? app.customer_type ?? 'unknown',
    seatBased: app.seat_based ?? false,
    inTrial: app.in_trial ?? false,
    currentPeriodStart: isoDay(sub.current_period_start),
    currentPeriodEnd: isoDay(sub.current_period_end),
    nextPaymentDate: isoDay(sub.next_payment_date),
    subtotalUsd: centsToMajor(sub.subtotal_amount),
    totalUsd: centsToMajor(sub.total_amount),
    discountUsd: centsToMajor(sub.total_discount_amount),
    discountPercentage: sub.total_discount_percentage ?? 0,
    products,
    creditUsd: centsToMajor(sub.intercom_account_credit)
  }
}

const buildCurrentPeriod = (cur: RawCurrentPeriodCharges): IntercomCurrentPeriod => ({
  invoiceDate: isoDay(cur.invoice_date),
  periodStart: isoDay(cur.current_period_start),
  periodEnd: isoDay(cur.current_period_end),
  subtotalUsd: centsToMajor(cur.subtotal_amount),
  totalUsd: centsToMajor(cur.total_amount),
  amountDueUsd: centsToMajor(cur.amount_due),
  amountPaidUsd: centsToMajor(cur.amount_paid),
  discountUsd: centsToMajor(cur.total_discount_amount),
  isRenewalMonth: cur.is_renewal_month ?? false
})

// Build the normalized billing report. Pure (no I/O), always fully-shaped with safe defaults so a drifted
// response never reads `undefined`. The in-progress period's running total is the Summary headline
// (currentMtd); the invoice list is the finalized history (the monthly chart's trend).
export const buildIntercomBilling = (
  rawInvoices: RawInvoice[] | null | undefined,
  rawSub: RawSubscriptionDetails | null | undefined,
  rawCurrent: RawCurrentPeriodCharges | null | undefined,
  rawApp: RawAppBillingDetails | null | undefined
): IntercomBillingReport => {
  const invoices: IntercomInvoice[] = (rawInvoices ?? []).map(normalizeInvoice)
  const subscription = buildSubscription(rawSub ?? {}, rawApp ?? {})
  const currentPeriod = buildCurrentPeriod(rawCurrent ?? {})

  invoices.sort(byDayDesc)

  const totalBilled = invoices.reduce((sum, i) => sum + i.amount, 0)
  // The in-progress period's running total is the live MTD. 0 stays (the Overview reads the current-month bar)
  // rather than nulling out and dropping the service from the Overview when a fresh period has accrued nothing.
  const currentMtd = currentPeriod.totalUsd

  return { subscription, currentPeriod, invoices, totalBilled, currentMtd, currency: 'usd' }
}

// Summary tab — the overview the cross-service Overview rolls up (spend.mtd): just the headline (the
// in-progress period's running total), the monthly-spend trend chart, and the Δ-vs-last-month the preset
// derives. The plan, totals, line items, and the invoice list are the Billing tab's detail — not here.
export const buildIntercomSummaryResult = (report: IntercomBillingReport): CapabilityResult => {
  const ccy = normalizeCurrency(report.currency)

  return billing.summary({
    currentMtd: report.currentMtd,
    currentMtdLabel: 'This period so far',
    currentMtdCaption: `accrued · ${ccy}`,
    mtdBasis: 'accrued',
    currency: ccy,
    invoices: report.invoices.map((i) => ({
      date: i.date,
      amount: i.amount,
      status: i.status,
      hostedUrl: i.hostedUrl ?? null,
      pdfUrl: i.pdfUrl ?? null
    }))
  })
}

// Billing tab — the financial detail (not the Overview rollup; the headline + chart live on Summary): the
// subscription account record (plan, period, totals, total billed), the per-product line breakdown, and the
// downloadable invoice history.

interface BillingAccountRow {
  plan: string
  cadence: string
  customerType: string
  period: string | null
  nextPayment: string | null
  subtotal: number
  discount: number
  total: number
  credit: number
  totalBilled: number
}

interface ProductRow {
  name: string
  metric: string
  quantity: number
  total: number
}

interface BillingInvoiceRow {
  date: string | null
  number: string
  amount: number
  status: string
  pdfUrl: string | null
  // Hidden — carried for the download filename.
  name: string
  // Hidden — the invoice's stable id (present on every native/Stripe invoice, unlike `number` which is blank
  // until finalized); rides as the ledger key so an invoice's status accumulates as it finalizes.
  id: string
}

export const buildIntercomBillingTab = (report: IntercomBillingReport): CapabilityResult => {
  const ccy = normalizeCurrency(report.currency)
  const sub = report.subscription
  const period =
    sub.currentPeriodStart && sub.currentPeriodEnd ? `${sub.currentPeriodStart} → ${sub.currentPeriodEnd}` : null

  const account = record<BillingAccountRow>({
    id: 'account',
    fields: [
      { key: 'plan', label: 'Plan', role: 'label' },
      { key: 'cadence', label: 'Cadence', role: 'label' },
      { key: 'customerType', label: 'Customer', role: 'label' },
      { key: 'period', label: 'Current period', role: 'label' },
      { key: 'nextPayment', label: 'Next payment', role: 'timestamp' },
      { key: 'subtotal', label: 'Subtotal', role: 'money', currency: ccy },
      { key: 'discount', label: 'Discount', role: 'money', currency: ccy },
      { key: 'total', label: 'Total', role: 'money', currency: ccy },
      { key: 'credit', label: 'Account credit', role: 'money', currency: ccy },
      { key: 'totalBilled', label: 'Total billed (all time)', role: 'money', currency: ccy }
    ],
    value: {
      plan: sub.planName,
      cadence: sub.cadence,
      customerType: sub.customerType,
      period,
      nextPayment: sub.nextPaymentDate ?? null,
      subtotal: sub.subtotalUsd,
      discount: sub.discountUsd,
      total: sub.totalUsd,
      credit: sub.creditUsd,
      totalBilled: report.totalBilled
    }
  })

  const products = table<ProductRow>({
    id: 'products',
    columns: [
      { key: 'name', label: 'Line item', role: 'label' },
      { key: 'metric', label: 'Metric', role: 'label' },
      { key: 'quantity', label: 'Qty', role: 'count' },
      { key: 'total', label: 'Total', role: 'money', currency: ccy }
    ],
    rows: sub.products.map((p) => ({ name: p.name, metric: p.pricingMetric, quantity: p.quantity, total: p.totalUsd })),
    // One row per subscription line item, uniquely named → keyed so each line's quantity/total accumulates.
    key: 'name'
  })

  const invoices = table<BillingInvoiceRow>({
    id: 'invoices',
    columns: [
      { key: 'date', label: 'Date', role: 'timestamp' },
      { key: 'number', label: 'Invoice', role: 'label' },
      { key: 'amount', label: 'Amount', role: 'money', currency: ccy },
      { key: 'status', label: 'Status', role: 'status' },
      { key: 'pdfUrl', label: 'PDF', role: 'url' },
      { key: 'name', role: 'label', hidden: true },
      { key: 'id', role: 'identifier', hidden: true }
    ],
    rows: report.invoices.map((i) => ({
      date: i.date ?? null,
      number: i.number || '—',
      amount: i.amount,
      status: i.status,
      pdfUrl: i.pdfUrl ?? i.hostedUrl ?? null,
      name: `Invoice ${i.number || i.date || 'unknown'}`,
      id: i.id
    })),
    key: 'id'
  })

  return capabilityResult({
    sections: [
      account.keyvalue({ title: 'Subscription' }),
      products.dataset.rows.length > 0 ? products.table({ title: 'Line items' }) : null,
      invoices.fileTable({
        title: 'Invoices',
        name: 'name',
        source: { url: 'pdfUrl' },
        ext: 'pdf',
        category: 'Invoices'
      })
    ]
  })
}

// ── types: usage wire shapes (plain counts, not money) ──────────────────────────────────

type MetricMap = Record<string, number | null | undefined>

export interface RawUsageStatistic {
  created_at?: string
  core_seat_count?: number | null
  latest_daily_admin_count?: number | null
  resolutions?: number | null
  conversations?: number | null
  messages_sent?: number | null
  emails_sent?: number | null
}

export interface RawUsageContract {
  prepaid_usage?: MetricMap
  total_usage?: MetricMap
  billing_cycle_end_date?: string
}

export interface RawUsage {
  contract?: RawUsageContract
  usage_statistics?: RawUsageStatistic[]
}

export interface RawPricingMetric {
  metric_key?: string
  metric_nickname?: string
  usage_category?: string
}

// ── types: members wire shape ──────────────────────────────────────────────────────────
export interface RawIntercomAdmin {
  id?: string | number
  email?: string
  name?: string
  // The list mixes real teammates with team entities + service bots; these flags single out the people.
  is_team?: boolean
  is_app_team?: boolean
  is_bot?: boolean
  is_operator?: boolean
  is_github_bot?: boolean
  is_facebook_bot?: boolean
}
export interface RawIntercomAdminList {
  admins?: RawIntercomAdmin[]
}

// One workspace the session can read (GET /ember/admins/apps.json).
export interface RawIntercomApp {
  id?: string
  id_code?: string
  name?: string
}

// ── usage transforms (pure, fixture-tested) ─────────────────────────────────────────────

const num = (v?: number | null): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export interface IntercomUsageMetric {
  key: string
  label: string
  usage: number // current consumption this period
  allowance?: number // included allowance (prepaid), if the plan defines one
  category?: string
}

export interface IntercomDailyUsage {
  date: string
  coreSeats: number
  resolutions: number
  conversations: number
  messagesSent: number
  emailsSent: number
}

export interface IntercomUsageReport {
  periodStart?: string
  periodEnd?: string
  metrics: IntercomUsageMetric[]
  daily: IntercomDailyUsage[]
  coreSeatCount: number // total_usage.core_seat_count
  latestAdminCount: number // most recent daily admin count
}

// Build the normalized usage report. Pure (no I/O), always fully-shaped. Each billable metric is joined to its
// current total and prepaid allowance by `metric_key`.
export const buildIntercomUsage = (
  rawUsage: RawUsage | null | undefined,
  rawMetrics: RawPricingMetric[] | null | undefined
): IntercomUsageReport => {
  const contract = rawUsage?.contract ?? {}
  const total = contract.total_usage ?? {}
  const prepaid = contract.prepaid_usage ?? {}
  const stats = rawUsage?.usage_statistics ?? []

  const metrics: IntercomUsageMetric[] = (rawMetrics ?? [])
    .filter((m) => !!m.metric_key)
    .map((m) => {
      const key = m.metric_key as string
      const allowance = prepaid[key]

      return {
        key,
        label: m.metric_nickname ?? key,
        usage: num(total[key]),
        allowance: typeof allowance === 'number' ? allowance : undefined,
        category: m.usage_category
      }
    })

  const daily: IntercomDailyUsage[] = stats
    .map((s) => ({
      date: isoDay(s.created_at) ?? '',
      coreSeats: num(s.core_seat_count),
      resolutions: num(s.resolutions),
      conversations: num(s.conversations),
      messagesSent: num(s.messages_sent),
      emailsSent: num(s.emails_sent)
    }))
    .filter((d) => !!d.date)
    .sort(byDayAsc)

  return {
    periodStart: daily[0]?.date ?? undefined,
    periodEnd: isoDay(contract.billing_cycle_end_date),
    metrics,
    daily,
    coreSeatCount: num(total.core_seat_count),
    latestAdminCount: num(total.latest_daily_admin_count)
  }
}

// Map the usage report onto the shared usage preset (per-metric current-vs-allowance table). Counts only —
// no money (billing owns the dollars), so no usage.primary money summary.
export const buildIntercomUsageResult = (report: IntercomUsageReport): CapabilityResult => {
  const metrics: UsageMetricInput[] = report.metrics.map((m) => ({
    label: m.label,
    value: m.usage,
    limit: m.allowance ?? null
  }))

  return usage.result({ periodStart: report.periodStart, periodEnd: report.periodEnd, metrics })
}

// ── members transform (pure, fixture-tested) ─────────────────────────────────────────────

// The teammate roster. The admins list interleaves team entities + service bots with the actual people, so
// keep only humans with an email (drops teams, the operator/GitHub/Facebook bots, and the seatless
// "Unassigned" placeholder). This payload carries no membership role, so role is left blank (the Members
// table still shows name + email).
const isHumanAdmin = (a: RawIntercomAdmin): boolean =>
  !a.is_team && !a.is_app_team && !a.is_bot && !a.is_operator && !a.is_github_bot && !a.is_facebook_bot

export const buildIntercomMembers = (raw: RawIntercomAdminList | null | undefined): MembersInput => ({
  members: (raw?.admins ?? [])
    .filter((a) => isHumanAdmin(a) && !!a.email)
    .map((a, i) => ({ id: String(a.id ?? a.email ?? i), name: a.name || undefined, email: a.email }))
})

// ── appId combobox options (pure, fixture-tested) ────────────────────────────────────────

// The workspace list → combobox options. The stored value is the `id_code` (the app_id used in the dashboard
// URL and every /ember/* query param); the workspace name is the label, with the id_code as subtext.
export const buildAppOptions = (apps: RawIntercomApp[] | null | undefined): ConfigOption[] =>
  (apps ?? [])
    .filter((a): a is RawIntercomApp & { id_code: string } => !!a.id_code)
    .map((a) => ({
      value: a.id_code,
      label: a.name?.trim() || a.id_code,
      description: a.name?.trim() ? a.id_code : undefined
    }))

// ── collectors ─────────────────────────────────────────────────────────────────────────

// The workspace ("app") id, a required text setting. Every `/ember/*` request appends it as `app_id`.
const appId = (ctx: CollectContext<IntercomConfig>): string => {
  const id = ctx.config.appId?.trim()

  if (!id) {
    throw new Error('Intercom: set the Workspace (app) ID in Settings — the app_id in your dashboard URL.')
  }

  return id
}

// `/ember/...?app_id=<id>` — both surfaces' GET endpoints share the same app_id query param.
const withAppId = (path: string, id: string): string => `${path}?app_id=${encodeURIComponent(id)}`

// Summary + Billing share the same four billing endpoints. The fetch returns the raw four-endpoint bundle;
// each tab's pure build derives its result from it (so the demo sample renders exactly what a live fetch
// would). Both capabilities call fetchIntercomBilling; the core query cache dedupes the underlying reads.
export interface RawIntercomBillingBundle {
  invoices: RawInvoice[] | null
  subscription: RawSubscriptionDetails | null
  current: RawCurrentPeriodCharges | null
  app: RawAppBillingDetails | null
}

const fetchIntercomBilling = async (ctx: CollectContext<IntercomConfig>): Promise<RawIntercomBillingBundle> => {
  const id = appId(ctx)
  const [invoices, subscription, current, app] = await Promise.all([
    ctx.client.get<RawInvoice[]>(withAppId(INVOICES, id)),
    ctx.client.get<RawSubscriptionDetails>(withAppId(SUBSCRIPTION, id)),
    ctx.client.get<RawCurrentPeriodCharges>(withAppId(CURRENT_PERIOD, id)),
    ctx.client.get<RawAppBillingDetails>(withAppId(APP_DETAILS, id))
  ])

  return { invoices, subscription, current, app }
}

const billingReport = (raw: RawIntercomBillingBundle): IntercomBillingReport =>
  buildIntercomBilling(raw.invoices, raw.subscription, raw.current, raw.app)

// The usage capability's raw bundle (the contract + the active pricing-metric list).
export interface RawIntercomUsageBundle {
  usage: RawUsage | null
  metrics: RawPricingMetric[] | null
}

const fetchIntercomUsage = async (ctx: CollectContext<IntercomConfig>): Promise<RawIntercomUsageBundle> => {
  const id = appId(ctx)
  // The usage contract is path-scoped by app id (`/ember/usage/<appId>`); it still appends app_id like the rest.
  const [usage, metrics] = await Promise.all([
    ctx.client.get<RawUsage>(withAppId(`${USAGE}/${id}`, id)),
    ctx.client.get<RawPricingMetric[]>(withAppId(PRICING_METRICS, id))
  ])

  return { usage, metrics }
}

// ── descriptor ──────────────────────────────────────────────────────────────────────────

export const intercomConfigSchema = defineConfigSchema([
  {
    key: 'appId',
    label: 'Workspace',
    kind: 'combobox',
    required: true,
    placeholder: 'Pick your workspace…',
    help: 'The Intercom workspace Butin reads. The stored value is its app_id (the code in app.intercom.com/a/apps/<app_id>/…).',
    loadOptions: async (ctx) => buildAppOptions(await ctx.client.get<RawIntercomApp[]>(APPS))
  }
])

export type IntercomConfig = ConfigOf<typeof intercomConfigSchema>

export const intercomPlugin = definePlugin({
  reportingCurrency: 'USD',
  meta: {
    id: 'intercom',
    name: 'Intercom',
    vendor: 'Intercom',
    category: 'devtools',
    color: '#1f8ded',
    description: 'Intercom workspace billing — invoices, seat-based subscription, and per-metric usage.',
    homepage: 'https://www.intercom.com',
    dashboardUrl: 'https://app.intercom.com'
  },
  session: {
    loginUrl: 'https://app.intercom.com/',
    dashboardMarkers: ['/a/apps/', '/inbox'],
    cookieDomains: ['intercom.com'],
    requiredCookie: '_intercom_session'
  },
  // The Rails session cookie is replayed verbatim; clear on 401 only (a 403 is a per-endpoint permission gap).
  auth: { kind: 'cookie' },
  // app.intercom.com is nginx, NOT Cloudflare → plain node transport (no requiresBrowserEngine). The node client
  // injects the canonical UA + sec-ch-ua centrally; we add only the JSON Accept + same-origin XHR markers.
  transport: {
    engine: 'node',
    baseUrl: ORIGIN,
    defaultHeaders: {
      Accept: 'application/json',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty'
    }
  },
  config: intercomConfigSchema,
  capabilities: [
    defineCapability({
      id: 'summary',
      label: 'Summary',
      fetch: fetchIntercomBilling,
      build: (raw) => buildIntercomSummaryResult(billingReport(raw)),
      sample: sampleIntercomBilling
    }),
    defineCapability({
      id: 'billing',
      label: 'Billing',
      fetch: fetchIntercomBilling,
      build: (raw) => buildIntercomBillingTab(billingReport(raw)),
      sample: sampleIntercomBilling
    }),
    defineCapability({
      id: 'usage',
      label: 'Usage',
      fetch: fetchIntercomUsage,
      build: (raw) => buildIntercomUsageResult(buildIntercomUsage(raw.usage, raw.metrics)),
      sample: sampleIntercomUsage
    }),
    defineCapability({
      id: 'members',
      label: 'Members',
      fetch: (ctx: CollectContext<IntercomConfig>) => ctx.client.get<RawIntercomAdminList>(adminsPath(appId(ctx))),
      build: (raw) => members.result(buildIntercomMembers(raw)),
      sample: sampleIntercomAdmins
    })
  ],
  probe: async (ctx) => {
    // The workspace list needs only the session cookie (no app_id) — a 200 proves _intercom_session is live.
    await ctx.client.get<RawIntercomApp[]>(APPS)
  }
})
