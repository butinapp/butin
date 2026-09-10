import { defineCapability, defineConfigSchema, definePlugin, type CollectContext, type ConfigOf } from '@butinapp/sdk'
import { addSections, capabilityResult, record, table, type CapabilityResult } from '@butinapp/sdk/data'
import {
  billing,
  members,
  usage,
  type MemberInput,
  type MembersInput,
  type UsageMetricInput
} from '@butinapp/sdk/presets'
import { byDayDesc, centsToMajor, isoDay, parseDecimalAmount, round2 } from '@butinapp/sdk/util'

import { sampleHookdeckBilling, sampleHookdeckMembers, sampleHookdeckUsage } from './sample.js'

// Hookdeck (hookdeck.com — webhook gateway / event infrastructure). Read-only tabs over the
// dashboard-internal billing API at `api.hookdeck.com/2025-07-01/internal/billing/*` (the endpoints the
// dashboard SPA itself calls):
//   1. summary — the overview: this calendar month's invoiced spend + the monthly-spend chart (the
//      cross-service Overview rolls up its spend.mtd). Plan/totals/payment/invoices live on Billing.
//   2. billing — the detail: subscription/account record (plan, period, base fee, status), payment method,
//      billing contact + tax id, and the downloadable Orb invoice history.
//   3. usage   — per-billable-metric daily consumption over the current billing period (counts).
//   4. members — the organization roster.
// Summary + Billing share one billing fetch (the query cache dedupes it).
//
// AUTH is the `sess__…` session cookie on `.hookdeck.com`, replayed verbatim (cookie auth). TRANSPORT is
// plain Node axios — the session validator requires `Origin: https://dashboard.hookdeck.com` (forbidden on
// Electron net.request) and a custom `x-team-id` header, so this doesn't need the browser engine; the team id is a
// required `text` config field passed per request (never hardcoded). MONEY: invoice amounts are cents
// (Orb, often with float noise like 6990.0000001) → centsToMajor + round; the subscription's per-price
// `unit_amount` is an Orb dollar string ("39.00") → parseDecimalAmount. Usage quantities are plain counts.
// Org selector is `current`.

const API = 'https://api.hookdeck.com/2025-07-01'

// ── shared config ─────────────────────────────────────────────────────────────────────

// The `x-team-id` header the session validator requires alongside the cookie. Held in config (a hardcoded
// id, not a secret) because it scopes every request to one workspace and varies per account.
const teamId = (ctx: CollectContext<HookdeckConfig>): string => {
  const team = ctx.config.teamId?.trim()

  if (!team) {
    throw new Error('Hookdeck: set the Team ID in Settings (the tm_… id from your dashboard requests).')
  }

  return team
}

// Each request carries x-team-id as a per-call header on top of the transport-level Origin/Sec-Fetch markers.
const teamGet = <T>(ctx: CollectContext<HookdeckConfig>, path: string, params?: Record<string, string>): Promise<T> => {
  const qs = params ? `?${new URLSearchParams(params).toString()}` : ''

  return ctx.client.get<T>(`${API}${path}${qs}`, { 'x-team-id': teamId(ctx) })
}

// ── types (the data dictionary) ─────────────────────────────────────────────────────────

// billing
export interface RawHookdeckInvoice {
  id?: string
  is_paid?: boolean
  // Cents (Orb), e.g. 6990 → $69.90. Can carry float noise (6990.0000001).
  amount_due?: number
  // ISO timestamp.
  issue_date?: string
  end_time?: string
  pdf_url?: string
}

interface RawPriceInterval {
  end_date?: string | null
  price?: {
    name?: string
    item?: { name?: string }
    // Orb dollar string, e.g. "39.00".
    unit_config?: { unit_amount?: string } | null
  } | null
}

export interface RawHookdeckSubscription {
  status?: string
  name?: string
  current_billing_period_start_date?: string
  current_billing_period_end_date?: string
  billing_cycle_day?: number
  customer?: {
    name?: string
    email?: string
    currency?: string
    portal_url?: string
  } | null
  plan?: {
    name?: string
    external_plan_id?: string
  } | null
  price_intervals?: RawPriceInterval[]
}

export interface RawHookdeckCard {
  brand?: string
  display_brand?: string
  last4?: string
  exp_month?: number
  exp_year?: number
  funding?: string
  country?: string
}

export interface RawHookdeckEmail {
  email?: string
}

export interface RawHookdeckAddress {
  billing_address?: { name?: string } | null
  tax_id?: string | null
}

export interface HookdeckInvoice {
  id: string
  // 'YYYY-MM-DD' from issue_date.
  date?: string
  // 'paid' | 'open'.
  status: string
  // Dollars.
  amount: number
  pdfUrl?: string
}

export interface HookdeckPaymentMethod {
  brand?: string
  last4?: string
  expMonth?: number
  expYear?: number
  funding?: string
  country?: string
}

export interface HookdeckBillingReport {
  invoices: HookdeckInvoice[]
  // Sum of `amount` across all invoices, dollars.
  totalBilled: number
  // Money charged in the current calendar month, dollars — the spend headline. null when no invoice
  // falls in the current month (so the Summary preset omits the spend summary).
  currentMtd: number | null
  // Most recent invoice (by date), if any.
  lastInvoice?: { date?: string; amount: number; status: string }
  // Plan display name, e.g. "Team".
  plan?: string
  // Orb external plan id, e.g. "starter" / "growth".
  planExternalId?: string
  // Subscription status, e.g. "active".
  subscriptionStatus?: string
  currentPeriodStart?: string
  currentPeriodEnd?: string
  billingCycleDay?: number
  // Plan base fee (the active "Plan" fixed price), dollars — undefined if not found.
  monthlyPlanCost?: number
  currency?: string
  paymentMethod: HookdeckPaymentMethod | null
  billingContact: { name?: string; email?: string } | null
  taxId?: string
  // Orb-hosted customer billing portal.
  portalUrl?: string
}

// ── billing ──────────────────────────────────────────────────────────────────────────────

const normalizeInvoice = (inv: RawHookdeckInvoice): HookdeckInvoice => ({
  id: inv.id ?? '',
  date: isoDay(inv.issue_date),
  status: inv.is_paid ? 'paid' : 'open',
  amount: round2(centsToMajor(inv.amount_due)),
  pdfUrl: inv.pdf_url || undefined
})

// The active "Plan" fixed-price unit amount (dollars), if present. Scans for the open interval (end_date
// null/undefined) whose item is named 'Plan'; usage prices (no unit_config) must NOT be picked.
const activePlanBaseFee = (sub: RawHookdeckSubscription): number | undefined => {
  const active = (sub.price_intervals ?? []).find(
    (pi) => (pi.end_date === null || pi.end_date === undefined) && pi.price?.item?.name === 'Plan'
  )
  const raw = active?.price?.unit_config?.unit_amount

  if (!raw) {
    return undefined
  }

  const n = parseDecimalAmount(raw)

  return Number.isFinite(n) && raw.trim() !== '' ? n : undefined
}

// Invoices: cents → dollars (float noise shed), sorted newest-first. currentMtd is this calendar month's
// invoice spend (null when none) so the Summary emits spend.mtd only when there's a figure. Per-price
// unit_amount is an Orb dollar string. Degrades on empty / missing inputs.
export const buildBillingReport = (
  invoiceList: RawHookdeckInvoice[] | null | undefined,
  sub: RawHookdeckSubscription | null | undefined,
  card: RawHookdeckCard | null | undefined,
  email: RawHookdeckEmail | null | undefined,
  address: RawHookdeckAddress | null | undefined
): HookdeckBillingReport => {
  const invoices = (invoiceList ?? []).map(normalizeInvoice).sort(byDayDesc)

  const s = sub ?? {}

  const paymentMethod: HookdeckPaymentMethod | null = card
    ? {
        brand: card.display_brand || card.brand || undefined,
        last4: card.last4 || undefined,
        expMonth: card.exp_month,
        expYear: card.exp_year,
        funding: card.funding || undefined,
        country: card.country || undefined
      }
    : null

  const contactName = address?.billing_address?.name || s.customer?.name || undefined
  const contactEmail = email?.email || s.customer?.email || undefined
  const billingContact = contactName || contactEmail ? { name: contactName, email: contactEmail } : null

  const last = invoices[0]

  return {
    invoices,
    totalBilled: round2(invoices.reduce((sum, i) => sum + i.amount, 0)),
    currentMtd: billing.invoicedMtd(invoices),
    lastInvoice: last ? { date: last.date, amount: last.amount, status: last.status } : undefined,
    plan: s.plan?.name || s.name || undefined,
    planExternalId: s.plan?.external_plan_id || undefined,
    subscriptionStatus: s.status || undefined,
    currentPeriodStart: isoDay(s.current_billing_period_start_date),
    currentPeriodEnd: isoDay(s.current_billing_period_end_date),
    billingCycleDay: s.billing_cycle_day,
    monthlyPlanCost: activePlanBaseFee(s),
    currency: s.customer?.currency || undefined,
    paymentMethod,
    billingContact,
    taxId: address?.tax_id || undefined,
    portalUrl: s.customer?.portal_url || undefined
  }
}

// Summary tab — the overview the cross-service Overview rolls up (spend.mtd): this month's invoiced spend,
// the monthly-spend chart, and the plan base fee as the recurring floor. The plan/period/payment/invoice
// detail lives on the Billing tab, not here.
export const buildHookdeckSummaryResult = (report: HookdeckBillingReport): CapabilityResult =>
  billing.summary({
    currentMtd: report.currentMtd,
    currency: report.currency,
    // The plan base fee is the recurring floor → baseFee. currentMtd is this month's invoiced spend (basis
    // 'invoiced'), so no metered overage is split out.
    baseFee: report.monthlyPlanCost ?? null,
    mtdBasis: 'invoiced',
    plan: report.plan,
    invoices: report.invoices.map((i) => ({
      date: i.date,
      amount: i.amount,
      status: i.status,
      pdfUrl: i.pdfUrl ?? null
    }))
  })

// Billing tab — the financial detail (the headline + chart live on Summary): the subscription/account
// record (plan, period, base fee, status, total billed), the payment-method + billing-contact records, and
// the downloadable Orb invoice history. A record with nothing to show is dropped.

interface AccountRow {
  plan: string
  planExternalId: string | null
  status: string | null
  period: string | null
  billingCycleDay: number | null
  baseFee: number | null
  totalBilled: number
  portalUrl: string | null
}

interface PaymentRow {
  brand: string | null
  last4: string | null
  expiry: string | null
  funding: string | null
  country: string | null
}

interface ContactRow {
  name: string | null
  email: string | null
  taxId: string | null
}

interface InvoiceRow {
  // Hidden — the Orb invoice id rides as the ledger key so an invoice accumulates past the fetch window. Two
  // invoices can share an issue date (a plan charge + a usage charge on the same day), so date/name aren't unique.
  id: string
  date: string | null
  status: string
  amount: number
  pdfUrl: string | null
  // Hidden — names the downloaded file.
  name: string
}

export const buildHookdeckBillingTab = (report: HookdeckBillingReport): CapabilityResult => {
  // The subscription carries the billing currency; default to the plugin's reporting currency when absent so
  // the money columns are always currency-stamped.
  const ccy = report.currency ?? 'USD'
  const period =
    report.currentPeriodStart && report.currentPeriodEnd
      ? `${report.currentPeriodStart} → ${report.currentPeriodEnd}`
      : null

  const account = record<AccountRow>({
    id: 'account',
    fields: [
      { key: 'plan', label: 'Plan', role: 'label' },
      { key: 'planExternalId', label: 'Plan id', role: 'label' },
      { key: 'status', label: 'Status', role: 'status' },
      { key: 'period', label: 'Current period', role: 'label' },
      { key: 'billingCycleDay', label: 'Billing day', role: 'count' },
      { key: 'baseFee', label: 'Plan base fee', role: 'money', currency: ccy },
      { key: 'totalBilled', label: 'Total billed (all time)', role: 'money', currency: ccy },
      { key: 'portalUrl', label: 'Billing portal', role: 'url' }
    ],
    value: {
      plan: report.plan ?? 'unknown',
      planExternalId: report.planExternalId ?? null,
      status: report.subscriptionStatus ?? null,
      period,
      billingCycleDay: report.billingCycleDay ?? null,
      baseFee: report.monthlyPlanCost ?? null,
      totalBilled: report.totalBilled,
      portalUrl: report.portalUrl ?? null
    }
  })

  const pm = report.paymentMethod
  const payment = pm
    ? record<PaymentRow>({
        id: 'paymentMethod',
        fields: [
          { key: 'brand', label: 'Card', role: 'label' },
          { key: 'last4', label: 'Last 4', role: 'label' },
          { key: 'expiry', label: 'Expires', role: 'label' },
          { key: 'funding', label: 'Funding', role: 'label' },
          { key: 'country', label: 'Country', role: 'label' }
        ],
        value: {
          brand: pm.brand ?? null,
          last4: pm.last4 ?? null,
          expiry: pm.expMonth && pm.expYear ? `${String(pm.expMonth).padStart(2, '0')}/${pm.expYear}` : null,
          funding: pm.funding ?? null,
          country: pm.country ?? null
        }
      })
    : null

  const c = report.billingContact
  const contact =
    c || report.taxId
      ? record<ContactRow>({
          id: 'contact',
          fields: [
            { key: 'name', label: 'Name', role: 'label' },
            { key: 'email', label: 'Email', role: 'label' },
            { key: 'taxId', label: 'Tax id', role: 'label' }
          ],
          value: { name: c?.name ?? null, email: c?.email ?? null, taxId: report.taxId ?? null }
        })
      : null

  const invoices = table<InvoiceRow>({
    id: 'invoices',
    columns: [
      { key: 'date', label: 'Date', role: 'timestamp' },
      { key: 'status', label: 'Status', role: 'status' },
      { key: 'amount', label: 'Amount', role: 'money', currency: ccy },
      { key: 'pdfUrl', label: 'PDF', role: 'url' },
      { key: 'name', role: 'label', hidden: true },
      { key: 'id', role: 'identifier', hidden: true }
    ],
    rows: report.invoices.map((i, idx) => ({
      id: i.id || `inv-${idx}`,
      date: i.date ?? null,
      status: i.status,
      amount: i.amount,
      pdfUrl: i.pdfUrl ?? null,
      name: `Invoice ${i.date ?? i.id}`
    })),
    key: 'id'
  })

  return capabilityResult({
    sections: [
      account.keyvalue({ title: 'Subscription' }),
      payment?.keyvalue({ title: 'Payment method' }),
      contact?.keyvalue({ title: 'Billing contact' }),
      report.invoices.length > 0
        ? invoices.fileTable({
            title: 'Invoices',
            name: 'name',
            source: { url: 'pdfUrl' },
            ext: 'pdf',
            category: 'Invoices'
          })
        : null
    ]
  })
}

// The raw bundle the five billing endpoints return — the wire shape Summary + Billing both transform. card /
// email / address can be 200-with-null when nothing is on file, so each field is nullable.
export interface RawHookdeckBilling {
  invoices: RawHookdeckInvoice[] | null
  subscription: RawHookdeckSubscription | null
  card: RawHookdeckCard | null
  email: RawHookdeckEmail | null
  address: RawHookdeckAddress | null
}

// Summary + Billing share the same five billing endpoints; the core query cache dedupes the underlying reads
// when both tabs fetch. A failed best-effort field stays null so a blank field doesn't blank the whole tab.
const fetchHookdeckBilling = async (ctx: CollectContext<HookdeckConfig>): Promise<RawHookdeckBilling> => {
  const [invoices, subscription, card, email, address] = await Promise.all([
    teamGet<RawHookdeckInvoice[]>(ctx, '/internal/billing/invoices').catch(() => null),
    teamGet<RawHookdeckSubscription>(ctx, '/internal/billing/subscription/details').catch(() => null),
    teamGet<RawHookdeckCard | null>(ctx, '/internal/billing/card').catch(() => null),
    teamGet<RawHookdeckEmail | null>(ctx, '/internal/billing/email').catch(() => null),
    teamGet<RawHookdeckAddress | null>(ctx, '/internal/billing/address').catch(() => null)
  ])

  return { invoices, subscription, card, email, address }
}

const reportOf = (raw: RawHookdeckBilling): HookdeckBillingReport =>
  buildBillingReport(raw.invoices ?? [], raw.subscription, raw.card, raw.email, raw.address)

// ── usage ────────────────────────────────────────────────────────────────────────────────

interface RawUsagePoint {
  quantity?: number
  timeframe_start?: string
  timeframe_end?: string
}

interface RawUsageMetric {
  billable_metric?: { id?: string; name?: string }
  usage?: RawUsagePoint[]
  view_mode?: string
}

export interface RawHookdeckUsageResponse {
  data?: RawUsageMetric[]
}

export interface HookdeckUsageDaily {
  date: string
  quantity: number
}

export interface HookdeckUsageMetric {
  id: string
  name: string
  // Sum of `quantity` across the period.
  total: number
  daily: HookdeckUsageDaily[]
}

export interface HookdeckUsageReport {
  metrics: HookdeckUsageMetric[]
  // Sorted unique day labels ('YYYY-MM-DD') spanning all metrics — chart x-axis.
  days: string[]
  // Total of the "Events" billable metric (the primary usage driver).
  totalEvents: number
  periodStart?: string
  periodEnd?: string
}

const dayOf = (point: RawUsagePoint): string => isoDay(point.timeframe_start) ?? ''

// One entry per billable metric, each summed over its daily points (counts, not money). Days is the merged
// sorted axis; totalEvents is the "Events" metric's total.
export const buildUsageReport = (
  raw: RawHookdeckUsageResponse | null | undefined,
  periodStart?: string,
  periodEnd?: string
): HookdeckUsageReport => {
  const metrics: HookdeckUsageMetric[] = (raw?.data ?? []).map((m) => {
    const daily = (m.usage ?? [])
      .map((p) => ({ date: dayOf(p), quantity: p.quantity ?? 0 }))
      .filter((d) => d.date.length > 0)

    return {
      id: m.billable_metric?.id ?? m.billable_metric?.name ?? 'unknown',
      name: m.billable_metric?.name ?? 'Unknown',
      total: daily.reduce((sum, d) => sum + d.quantity, 0),
      daily
    }
  })

  const days = [...new Set(metrics.flatMap((m) => m.daily.map((d) => d.date)))].sort()
  const totalEvents = metrics.find((m) => m.name.toLowerCase() === 'events')?.total ?? 0

  return { metrics, days, totalEvents, periodStart, periodEnd }
}

// Compose the usage result: one count metric per billable metric + a per-metric daily timeseries.
export const buildHookdeckUsageResult = (report: HookdeckUsageReport): CapabilityResult => {
  const metrics: UsageMetricInput[] = report.metrics.map((m) => ({
    label: m.name,
    value: m.total,
    unit: m.name.toLowerCase() === 'events' ? 'events' : 'requests'
  }))

  // Each metric's daily consumption points are a per-day series (the API uses granularity:'day').
  const series = report.metrics
    .filter((m) => m.daily.length)
    .map((m) =>
      table<HookdeckUsageDaily>({
        id: `daily-${m.id}`,
        columns: [
          { key: 'date', label: 'Date', role: 'timestamp' },
          { key: 'quantity', label: m.name, role: 'count' }
        ],
        rows: m.daily,
        // One point per day → keyed by date so each metric's daily consumption accumulates past the fetch window.
        key: 'date'
      }).timeseries({ x: 'date', y: 'quantity', granularity: 'daily', title: `Daily ${m.name}` })
    )

  return addSections(usage.result({ periodStart: report.periodStart, periodEnd: report.periodEnd, metrics }), ...series)
}

// The raw usage payload plus the billing-period bounds it was scoped to (ISO 'YYYY-MM-DD'), carried so build
// can stamp the period without re-reading the subscription.
export interface RawHookdeckUsage {
  usage: RawHookdeckUsageResponse | null
  periodStart?: string
  periodEnd?: string
}

const fetchHookdeckUsage = async (ctx: CollectContext<HookdeckConfig>): Promise<RawHookdeckUsage> => {
  // Scope usage to the current billing period: read the period bounds off the subscription, then pass them
  // verbatim (ISO with +00:00 offset) to the usage endpoint.
  const sub = await teamGet<RawHookdeckSubscription>(ctx, '/internal/billing/subscription/details').catch(() => null)
  const start = sub?.current_billing_period_start_date
  const end = sub?.current_billing_period_end_date

  const params: Record<string, string> = { granularity: 'day', product: 'event_gateway' }

  if (start) {
    params.timeframe_start = start
  }

  if (end) {
    params.timeframe_end = end
  }

  const usage = await teamGet<RawHookdeckUsageResponse>(ctx, '/internal/billing/usage', params).catch(() => null)

  return { usage, periodStart: isoDay(start), periodEnd: isoDay(end) }
}

export const buildHookdeckUsage = (raw: RawHookdeckUsage): CapabilityResult =>
  buildHookdeckUsageResult(buildUsageReport(raw.usage, raw.periodStart, raw.periodEnd))

// ── members ──────────────────────────────────────────────────────────────────────────────

// One row from GET /organizations/current/members — a bare array. The dashboard nests the person's name
// and email under user_* keys; `current` resolves the org from the session, so no org id is needed.
export interface RawHookdeckMember {
  // omem_… membership id.
  id?: string
  user_id?: string
  role?: string
  user_name?: string
  user_email?: string
}

export interface RawHookdeckMembersResponse {
  data?: RawHookdeckMember[]
}

// The endpoint returns a bare array; tolerate the `{ data: [...] }` envelope shape too. Members without an
// email are dropped (a half-provisioned row isn't a real seat). id falls back to user_id then the index so
// a row is never keyless. Degrades on empty / nullish input.
export const buildHookdeckMembers = (
  raw: RawHookdeckMember[] | RawHookdeckMembersResponse | null | undefined
): MembersInput => {
  const rows = Array.isArray(raw) ? raw : (raw?.data ?? [])

  const members: MemberInput[] = rows
    .filter((m) => !!m.user_email)
    .map((m, i) => ({
      id: m.id ?? m.user_id ?? String(i),
      name: m.user_name || undefined,
      email: m.user_email,
      role: m.role || undefined
    }))

  return { members }
}

// Same session as billing/usage: the cookie + x-team-id + Origin reach the management surface. `current`
// resolves the org from the session, so there's no org id to pass.
const fetchHookdeckMembers = (
  ctx: CollectContext<HookdeckConfig>
): Promise<RawHookdeckMember[] | RawHookdeckMembersResponse> =>
  teamGet<RawHookdeckMember[] | RawHookdeckMembersResponse>(ctx, '/organizations/current/members')

// ── descriptor ──────────────────────────────────────────────────────────────────────────

export const hookdeckConfigSchema = defineConfigSchema([
  {
    key: 'teamId',
    label: 'Team ID',
    kind: 'text',
    placeholder: 'tm_…',
    help: 'The tm_… id Hookdeck sends as x-team-id on its dashboard requests. Auto-detected at sign-in; set it only to override.'
  }
])

export type HookdeckConfig = ConfigOf<typeof hookdeckConfigSchema>

export const hookdeckPlugin = definePlugin({
  reportingCurrency: 'USD',
  meta: {
    id: 'hookdeck',
    name: 'Hookdeck',
    vendor: 'Hookdeck',
    category: 'devtools',
    color: '#004dff',
    description: 'Hookdeck event-gateway billing (Orb invoices + plan) and event-usage consumption.',
    homepage: 'https://hookdeck.com',
    dashboardUrl: 'https://dashboard.hookdeck.com'
  },
  session: {
    loginUrl: 'https://dashboard.hookdeck.com/login',
    dashboardMarkers: ['/dashboard', '/events', '/connections'],
    cookieDomains: ['hookdeck.com'],
    requiredCookie: 'sess__',
    // The team id is in no URL — the dashboard SPA sends it as `x-team-id` on its own requests, so capture
    // it off the wire during sign-in to prefill the config field.
    captureFromHeader: [{ header: 'x-team-id', storeAs: 'teamId', on: 'request' }]
  },
  auth: { kind: 'cookie' },
  // Plain node axios: the session validator requires Origin: https://dashboard.hookdeck.com + same-site
  // Sec-Fetch markers (forbidden on Electron net.request), so this doesn't need the browser engine. The custom
  // x-team-id header is added per request from the teamId config field (it varies per workspace).
  transport: {
    defaultHeaders: {
      Accept: '*/*',
      Origin: 'https://dashboard.hookdeck.com',
      Referer: 'https://dashboard.hookdeck.com/',
      'Sec-Fetch-Site': 'same-site',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty'
    }
  },
  config: hookdeckConfigSchema,
  capabilities: [
    defineCapability({
      id: 'summary',
      label: 'Summary',
      fetch: fetchHookdeckBilling,
      build: (raw) => buildHookdeckSummaryResult(reportOf(raw)),
      sample: sampleHookdeckBilling
    }),
    defineCapability({
      id: 'billing',
      label: 'Billing',
      fetch: fetchHookdeckBilling,
      build: (raw) => buildHookdeckBillingTab(reportOf(raw)),
      sample: sampleHookdeckBilling
    }),
    defineCapability({
      id: 'usage',
      label: 'Usage',
      fetch: fetchHookdeckUsage,
      build: buildHookdeckUsage,
      sample: sampleHookdeckUsage
    }),
    defineCapability({
      id: 'members',
      label: 'Members',
      fetch: fetchHookdeckMembers,
      build: (raw) => members.result(buildHookdeckMembers(raw)),
      sample: sampleHookdeckMembers
    })
  ],
  probe: async (ctx) => {
    // The subscription details call is the cheapest authed billing call — a 200 proves the sess__ cookie +
    // x-team-id pair is live.
    await teamGet(ctx, '/internal/billing/subscription/details')
  }
})
