import {
  defineCapability,
  defineConfigSchema,
  definePlugin,
  type CollectContext,
  type ConfigOf,
  type DocumentBytes
} from '@butinapp/sdk'
import { capabilityResult, record, table, type CapabilityResult } from '@butinapp/sdk/data'
import {
  fetchStripeHostedInvoicePdf,
  fetchStripePortalResource,
  openStripePortal,
  openStripePortalViaRedirect,
  type RawStripeInvoiceList
} from '@butinapp/sdk/integrations'
import {
  billing,
  members,
  usage,
  type BillingInvoiceInput,
  type MemberInput,
  type MembersInput
} from '@butinapp/sdk/presets'
import { centsToMajor, epochSecDay, monthMinus, utcDaysAgo } from '@butinapp/sdk/util'

import { samplePosthogBilling, samplePosthogMembers, samplePosthogUsage } from './sample.js'

// PostHog (us.posthog.com / eu.posthog.com) billing + usage insights from the session-gated billing API.
// AUTH is the dashboard SESSION cookie (`sessionid` + `posthog_csrftoken`) replayed verbatim — PostHog's
// billing viewset categorically rejects personal API keys (403 "does not support personal API key access")
// before scopes are even evaluated, so the cookie is the only way in. Django session auth needs no CSRF
// token for safe (GET) methods, so the cookie alone suffices. us.posthog.com doesn't need the browser engine
// (no cf_clearance), so this stays on plain node transport. A 403 here means a stale session (PostHog
// returns 403, not 401, for a dead session on these endpoints) → clear the cookie to re-prompt Magic Login.
//
// MONEY is MIXED: `/api/billing/` + breakdown `*_usd` fields are USD dollar STRINGS ("250.00") → usd();
// Stripe-portal invoices report `amount_due` in CENTS → centsToMajor.

const BASE_BY_REGION: Record<string, string> = {
  us: 'https://us.posthog.com',
  eu: 'https://eu.posthog.com'
}

// Trailing-window dates (last 30 days, UTC) for the breakdown queries — independent of the billing period,
// matching the dashboard. Computed in the fetch fn so the build*() transforms stay pure.
const trailingWindow = (days = 30): { start: string; end: string } => ({ start: utcDaysAgo(days), end: utcDaysAgo(0) })

// ── raw wire shapes (only the fields we read) ────────────────────────────────────────

// The Stripe billing-portal invoice/list shapes (RawStripeInvoice / RawStripeInvoiceList) come from
// @butinapp/sdk — money in CENTS, timestamps in unix seconds.

interface RawBillingPeriod {
  current_period_start?: string
  current_period_end?: string
  interval?: string
}

export interface RawProduct {
  type?: string
  name?: string
  subscribed?: boolean
  current_amount_usd?: string | null
  projected_amount_usd?: string | null
  current_usage?: number | null
  usage_limit?: number | null
  projected_usage?: number | null
  percentage_usage?: number | null
  has_exceeded_limit?: boolean
  unit?: string | null
}

export interface RawBilling {
  billing_plan?: string | null
  subscription_level?: string
  has_active_subscription?: boolean
  is_annual_plan_customer?: boolean
  billing_period?: RawBillingPeriod
  current_total_amount_usd?: string | null
  current_total_amount_usd_after_discount?: string | null
  projected_total_amount_usd?: string | null
  projected_total_amount_usd_after_discount?: string | null
  discount_percent?: number | null
  discount_amount_usd?: string | null
  products?: RawProduct[]
  account_owner?: { name?: string; email?: string } | null
  stripe_portal_url?: string | null
}

interface RawBreakdownSeries {
  id?: number
  label?: string
  data?: number[]
  dates?: string[]
}

export interface RawBreakdowns {
  results?: RawBreakdownSeries[]
}

// The raw bundle the billing fetch returns (Summary + Billing share it): the billing payload + the
// trailing-window spend breakdown + the Stripe-portal invoice history.
export interface PosthogBillingRaw {
  billing: RawBilling
  spend: RawBreakdowns
  stripeInvoices: RawStripeInvoiceList
}

// The raw bundle the usage fetch returns: the billing payload (for per-product usage vs limit) + the
// trailing-window usage breakdown.
export interface PosthogUsageRaw {
  billing: RawBilling
  usage: RawBreakdowns
}

// ── normalized domain types ───────────────────────────────────────────────────────────

export interface PosthogProductSpend {
  type: string
  name: string
  subscribed: boolean
  currentAmount: number
  projectedAmount: number
}

// A timeseries ready for a stacked chart: one date axis, one series per product.
export interface PosthogTimeseries {
  dates: string[]
  series: Array<{ label: string; data: number[] }>
}

export interface PosthogInvoice extends BillingInvoiceInput {
  date?: string
  status: string
  amount: number
  hostedUrl?: string
}

export interface PosthogBillingReport {
  plan?: string
  subscriptionLevel?: string
  hasActiveSubscription: boolean
  isAnnualPlan: boolean
  period: { start?: string; end?: string; interval?: string }
  currentTotal: number
  // Current period spend-to-date is the live MTD (the projection is separate).
  currentMtd: number
  projectedTotal: number
  currentTotalAfterDiscount: number
  projectedTotalAfterDiscount: number
  discountPercent?: number | null
  discountAmount: number
  accountOwner?: { name?: string; email?: string }
  // Products with a subscription or any current/projected spend, by projected desc.
  products: PosthogProductSpend[]
  // Per-product daily spend over the trailing window (zero-only series dropped).
  spend: PosthogTimeseries
  // Monthly invoice history from the Stripe portal (newest first, dollars).
  invoices: PosthogInvoice[]
  // Sum of `amount` across the returned invoices, dollars.
  totalBilled: number
  // Link to PostHog's billing portal (302s to the Stripe-hosted portal).
  portalUrl?: string
}

export interface PosthogUsageProduct {
  type: string
  name: string
  currentUsage: number
  usageLimit: number | null
  projectedUsage: number | null
  percentageUsage: number | null
  hasExceededLimit: boolean
  unit?: string
}

export interface PosthogUsageReport {
  period: { start?: string; end?: string; interval?: string }
  products: PosthogUsageProduct[]
  usage: PosthogTimeseries
}

// ── pure helpers (fixture-tested) ───────────────────────────────────────────────────

// Parse a USD dollar string/number to a number (0 on missing/invalid). PostHog's `*_usd` fields are
// dollar strings ("250.00"), NOT cents — so this is Number(...), not centsToMajor.
export const usd = (value?: string | number | null): number => {
  if (value === null || value === undefined) {
    return 0
  }

  const n = typeof value === 'number' ? value : Number(value)

  return Number.isFinite(n) ? n : 0
}

// Normalize a breakdowns response to {dates, series}, dropping all-zero series so charts stay legible.
export const normalizeTimeseries = (raw: RawBreakdowns): PosthogTimeseries => {
  const results = raw.results ?? []
  const dates = results.find((r) => r.dates?.length)?.dates ?? []
  const series = results
    .filter((r) => (r.data ?? []).some((n) => n > 0))
    .map((r) => ({ label: r.label ?? 'Unknown', data: r.data ?? [] }))

  return { dates, series }
}

// ── summary (billing.summary: MTD + monthly spark + per-product stats; spend.mtd is what the Overview rolls up) ──

// Pure transform — fixture-tested. Mixes both money units: dollar-strings for the period totals/products,
// cents for the Stripe-portal monthly invoices.
export const buildBillingReport = (
  billing: RawBilling,
  spend: RawBreakdowns,
  stripeInvoices: RawStripeInvoiceList = {}
): PosthogBillingReport => {
  const invoices: PosthogInvoice[] = (stripeInvoices.data ?? [])
    .map((inv) => ({
      date: epochSecDay(inv.effective_at) ?? epochSecDay(inv.finalized_at) ?? epochSecDay(inv.due_date),
      status: inv.status ?? 'unknown',
      amount: centsToMajor(inv.amount_due),
      hostedUrl: inv.hosted_invoice_url
    }))
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))

  const products: PosthogProductSpend[] = (billing.products ?? [])
    .map((p) => ({
      type: p.type ?? 'unknown',
      name: p.name ?? p.type ?? 'Unknown',
      subscribed: p.subscribed ?? false,
      currentAmount: usd(p.current_amount_usd),
      projectedAmount: usd(p.projected_amount_usd)
    }))
    .filter((p) => p.subscribed || p.currentAmount > 0 || p.projectedAmount > 0)
    .sort((a, b) => b.projectedAmount - a.projectedAmount)

  const currentTotal = usd(billing.current_total_amount_usd)

  return {
    plan: billing.billing_plan ?? undefined,
    subscriptionLevel: billing.subscription_level,
    hasActiveSubscription: billing.has_active_subscription ?? false,
    isAnnualPlan: billing.is_annual_plan_customer ?? false,
    period: {
      start: billing.billing_period?.current_period_start,
      end: billing.billing_period?.current_period_end,
      interval: billing.billing_period?.interval
    },
    currentTotal,
    currentMtd: currentTotal,
    projectedTotal: usd(billing.projected_total_amount_usd),
    currentTotalAfterDiscount: usd(billing.current_total_amount_usd_after_discount),
    projectedTotalAfterDiscount: usd(billing.projected_total_amount_usd_after_discount),
    discountPercent: billing.discount_percent ?? null,
    discountAmount: usd(billing.discount_amount_usd),
    accountOwner: billing.account_owner
      ? { name: billing.account_owner.name, email: billing.account_owner.email }
      : undefined,
    products,
    spend: normalizeTimeseries(spend),
    invoices,
    totalBilled: invoices.reduce((sum, i) => sum + i.amount, 0),
    portalUrl: billing.stripe_portal_url ?? undefined
  }
}

// Compose the Summary result: the shared billing.summary preset (MTD stat + monthly-spend chart + the
// cross-service spend.mtd summary) feeding off the Stripe-portal invoices, plus extra headline stats (plan,
// subscription, projected period spend) and a per-product current/projected-spend table.
export const buildPosthogSummaryResult = (report: PosthogBillingReport): CapabilityResult => {
  const result = billing.summary({
    currentMtd: report.currentMtd,
    currentMtdLabel: 'This period',
    // Projected period spend accruing live over the open period.
    mtdBasis: 'accrued',
    plan: report.plan,
    // Invoices are effective a day or two into the following month (prior period billed in arrears), so
    // bucket the chart by the incurred month — June's bill under June — leaving the open month for the live
    // accrual backfill instead of last period's settled total.
    invoices: report.invoices.map((i) => ({ ...i, date: i.date ? monthMinus(i.date, 1) : i.date })),
    stats: [
      { key: 'subscription', label: 'Subscription', role: 'label', value: report.subscriptionLevel ?? null },
      { key: 'projected', label: 'Projected', role: 'money', value: report.projectedTotal }
    ]
  })

  if (report.products.length) {
    interface ProductRow {
      name: string
      currentAmount: number
      projectedAmount: number
    }

    const products = table<ProductRow>({
      id: 'products',
      columns: [
        { key: 'name', label: 'Product', role: 'label' },
        { key: 'currentAmount', label: 'Current', role: 'money' },
        { key: 'projectedAmount', label: 'Projected', role: 'money' }
      ],
      rows: report.products.map((p) => ({
        name: p.name,
        currentAmount: p.currentAmount,
        projectedAmount: p.projectedAmount
      })),
      // One row per product, uniquely named → keyed so per-product spend accumulates.
      key: 'name'
    })

    result.datasets.push(products.dataset)
    result.views = [...(result.views ?? []), products.table({ title: 'Spend by product' }).view]
  }

  return result
}

// ── billing tab (the detail: subscription record + downloadable invoice history) ──

// The subscription record row.
interface PosthogAccountRow {
  plan: string | null
  subscription: string | null
  period: string | null
  owner: string | null
  totalBilled: number
}

// The invoices table row. `name` rides hidden (names each downloaded file); `hostedUrl` is the per-row source
// the fetchFile hook resolves into a PDF.
interface PosthogInvoiceRow {
  date: string | null
  amount: number
  status: string
  hostedUrl: string | null
  name: string
}

// Pure transform — fixture-tested. The Billing tab: the account/subscription record + the downloadable invoice
// history. No chart, no spend.mtd (the Summary tab owns those). PostHog's Stripe invoices expose only the
// hosted-invoice page, so the table downloads via fetchFile (the SDK's two-hop hosted→PDF handoff), not a URL.
export const buildPosthogBillingTab = (report: PosthogBillingReport): CapabilityResult => {
  const period = [report.period.start, report.period.end].filter(Boolean).join(' → ')

  const account = record<PosthogAccountRow>({
    id: 'account',
    fields: [
      { key: 'plan', label: 'Plan', role: 'label' },
      { key: 'subscription', label: 'Subscription', role: 'label' },
      { key: 'period', label: 'Billing period', role: 'label' },
      { key: 'owner', label: 'Account owner', role: 'label' },
      { key: 'totalBilled', label: 'Total billed', role: 'money' }
    ],
    value: {
      plan: report.plan ?? null,
      subscription: report.subscriptionLevel ?? null,
      period: period || null,
      owner: report.accountOwner?.email ?? report.accountOwner?.name ?? null,
      totalBilled: report.totalBilled
    }
  })

  const invoices = table<PosthogInvoiceRow>({
    id: 'invoices',
    columns: [
      { key: 'date', label: 'Date', role: 'timestamp' },
      { key: 'amount', label: 'Amount', role: 'money' },
      { key: 'status', label: 'Status', role: 'status' },
      { key: 'hostedUrl', label: 'Invoice', role: 'url' },
      { key: 'name', role: 'label', hidden: true }
    ],
    rows: report.invoices.map((i) => ({
      date: i.date ?? null,
      amount: i.amount,
      status: i.status,
      hostedUrl: i.hostedUrl ?? null,
      name: `Invoice ${i.date ?? 'unknown'}`
    })),
    // PostHog posts one monthly invoice per period → the invoice date is unique, keying its accumulation.
    key: 'date'
  })

  return capabilityResult({
    sections: [
      account.keyvalue({ title: 'Subscription' }),
      invoices.dataset.rows.length > 0
        ? invoices.fileTable({
            title: 'Invoices',
            name: 'name',
            source: { fetch: true },
            ext: 'pdf',
            category: 'Invoices'
          })
        : null
    ]
  })
}

// PostHog has no invoice-history API — the history lives in its Stripe-hosted billing portal, reached from the
// `stripe_portal_url` on the billing payload (a URL that 302s to the portal session, or the session URL
// itself). Best-effort: a failed walk degrades to empty invoices so the headline + chart still render.
const fetchPosthogStripeInvoices = async (
  ctx: CollectContext<PosthogConfig>,
  portalUrl: string | null | undefined,
  limit = 24
): Promise<RawStripeInvoiceList> => {
  if (!portalUrl) {
    return {}
  }

  const session = portalUrl.includes('/p/session/')
    ? await openStripePortal(ctx.client, portalUrl)
    : await openStripePortalViaRedirect(ctx.client, portalUrl)

  return fetchStripePortalResource<RawStripeInvoiceList>(ctx.client, session, 'invoices', { limit })
}

// Summary + Billing share this one fetch (the query cache dedupes the billing GET, the spend GET, and the
// portal walk): the billing payload + trailing-window spend + the Stripe-portal invoice history.
const fetchPosthogBilling = async (ctx: CollectContext<PosthogConfig>): Promise<PosthogBillingRaw> => {
  const base = regionBase(ctx)
  const { start, end } = trailingWindow()
  const spendPath = `${base}/api/billing/spend/?breakdowns=${encodeURIComponent('["type"]')}&start_date=${start}&end_date=${end}&interval=day`
  const [billing, spend] = await Promise.all([
    ctx.client.get<RawBilling>(`${base}/api/billing/`),
    // The trend is secondary to the totals: if the window errors, still render the headline + products.
    ctx.client.get<RawBreakdowns>(spendPath).catch(() => ({}) as RawBreakdowns)
  ])

  const stripeInvoices = await fetchPosthogStripeInvoices(ctx, billing.stripe_portal_url).catch((err) => {
    ctx.log(`posthog stripe-portal walk failed (${(err as Error).message}); degrading to empty invoices.`)

    return {} as RawStripeInvoiceList
  })

  return { billing, spend, stripeInvoices }
}

// Per-row invoice download: PostHog's Stripe invoices expose only the hosted-invoice page, so the SDK helper
// resolves the real PDF via Stripe's two-hop file-url handoff (no PostHog cookie on either hop).
const fetchPosthogInvoice = (
  ctx: CollectContext<PosthogConfig>,
  row: Record<string, unknown>
): Promise<DocumentBytes> =>
  fetchStripeHostedInvoicePdf(ctx.client, typeof row.hostedUrl === 'string' ? row.hostedUrl : null)

// ── usage (per-product usage vs limit + daily-usage timeseries via usage.result) ──

// Pure transform — fixture-tested. Raw counts (NOT money — spend lives on the summary tab).
export const buildUsageReport = (billing: RawBilling, usage: RawBreakdowns): PosthogUsageReport => {
  const products: PosthogUsageProduct[] = (billing.products ?? [])
    .map((p) => ({
      type: p.type ?? 'unknown',
      name: p.name ?? p.type ?? 'Unknown',
      currentUsage: p.current_usage ?? 0,
      usageLimit: p.usage_limit ?? null,
      projectedUsage: p.projected_usage ?? null,
      percentageUsage: p.percentage_usage ?? null,
      hasExceededLimit: p.has_exceeded_limit ?? false,
      unit: p.unit ?? undefined
    }))
    .filter((p) => p.currentUsage > 0 || p.usageLimit !== null || (p.projectedUsage ?? 0) > 0)
    .sort((a, b) => b.currentUsage - a.currentUsage)

  return {
    period: {
      start: billing.billing_period?.current_period_start,
      end: billing.billing_period?.current_period_end,
      interval: billing.billing_period?.interval
    },
    products,
    usage: normalizeTimeseries(usage)
  }
}

// Compose the usage result: one metric per product (current usage vs limit) + an optional per-product daily
// stacked timeseries. The usage.result preset draws the summary stat + the metric table; we append the chart.
export const buildPosthogUsageResult = (report: PosthogUsageReport): CapabilityResult => {
  const result = usage.result({
    periodStart: report.period.start,
    periodEnd: report.period.end,
    metrics: report.products.map((p) => ({
      label: p.name,
      value: p.currentUsage,
      unit: p.unit,
      limit: p.usageLimit
    }))
  })

  // One date axis, one numeric column per product series → a stacked daily-usage chart.
  if (report.usage.series.length && report.usage.dates.length) {
    // Dynamic columns keyed by series label — cast via `never` because Row is open-ended.
    interface DailyRow {
      date: string
      [series: string]: string | number
    }

    const seriesColumns = report.usage.series.map((s) => ({ key: s.label, label: s.label, role: 'count' as const }))
    const rows: DailyRow[] = report.usage.dates.map((date, i) => {
      const row: DailyRow = { date }

      for (const s of report.usage.series) {
        row[s.label] = s.data[i] ?? 0
      }

      return row
    })

    // Chart the first (largest) product series; the table dataset still carries every product column.
    const firstSeries = report.usage.series[0]!
    const daily = table<DailyRow>({
      id: 'daily',
      columns: [{ key: 'date', label: 'Date', role: 'timestamp' }, ...seriesColumns] as never,
      rows: rows as never,
      // One row per day → keyed by date so the usage trend accumulates past the trailing window.
      key: 'date'
    }).timeseries({ x: 'date', y: firstSeries.label as never, granularity: 'daily', title: 'Daily usage' })

    result.datasets.push(daily.dataset)
    result.views = [...(result.views ?? []), daily.view]
  }

  return result
}

const fetchPosthogUsage = async (ctx: CollectContext<PosthogConfig>): Promise<PosthogUsageRaw> => {
  const base = regionBase(ctx)
  const { start, end } = trailingWindow()
  const usagePath = `${base}/api/billing/usage/?breakdowns=${encodeURIComponent('["type"]')}&start_date=${start}&end_date=${end}&interval=day`
  const [billing, usage] = await Promise.all([
    ctx.client.get<RawBilling>(`${base}/api/billing/`),
    ctx.client.get<RawBreakdowns>(usagePath).catch(() => ({}) as RawBreakdowns)
  ])

  return { billing, usage }
}

// ── members (the org member roster via members.result) ──

// Org membership levels (from OrganizationMembership.Level): 1 → member, 8 → admin, 15 → owner.
const LEVEL_TO_ROLE: Record<number, string> = { 1: 'member', 8: 'admin', 15: 'owner' }

// Raw org-members wire shape — only the fields we read. The same dashboard SESSION cookie that reaches
// /api/billing/ also reaches GET /api/organizations/@current/members/ (Django session auth, no personal
// API key needed). The endpoint is paginated ({ results, next, ... }); we read the first page only.
interface RawMemberUser {
  uuid?: string
  first_name?: string
  last_name?: string
  email?: string
}

interface RawMember {
  level?: number
  user?: RawMemberUser
}

export interface RawMembersList {
  results?: RawMember[]
}

// Pure transform — fixture-tested. Map each member's nested user → id/name/email and `level` → role.
export const buildPosthogMembers = (raw: RawMembersList): MembersInput => ({
  members: (raw.results ?? []).map((m, i) => {
    const name = [m.user?.first_name, m.user?.last_name].filter(Boolean).join(' ').trim()

    return {
      id: m.user?.uuid ?? String(i),
      name: name || undefined,
      email: m.user?.email,
      role: m.level === undefined ? undefined : (LEVEL_TO_ROLE[m.level] ?? 'member')
    } satisfies MemberInput
  })
})

const fetchPosthogMembers = (ctx: CollectContext<PosthogConfig>): Promise<RawMembersList> =>
  ctx.client.get<RawMembersList>(`${regionBase(ctx)}/api/organizations/@current/members/?limit=200`)

// ── shared ───────────────────────────────────────────────────────────────────────────

// The region the account lives in (us | eu) → its API host. Defaults to us when unset/unknown.
const regionBase = (ctx: CollectContext<PosthogConfig>): string => {
  const region = ctx.config.region?.trim() || 'us'

  return BASE_BY_REGION[region] ?? BASE_BY_REGION.us!
}

// ── descriptor ──────────────────────────────────────────────────────────────────────

export const posthogConfigSchema = defineConfigSchema([
  {
    key: 'region',
    label: 'Region',
    kind: 'select',
    options: [
      { value: 'us', label: 'US (us.posthog.com)' },
      { value: 'eu', label: 'EU (eu.posthog.com)' }
    ],
    help: 'The PostHog Cloud region your account lives in.'
  }
])

export type PosthogConfig = ConfigOf<typeof posthogConfigSchema>

export const posthogPlugin = definePlugin({
  reportingCurrency: 'USD',
  meta: {
    id: 'posthog',
    name: 'PostHog',
    vendor: 'PostHog',
    category: 'devtools',
    color: '#f54e00',
    description:
      'PostHog spend summary (period + per-product spend), downloadable Stripe invoices, and product-usage insights.',
    homepage: 'https://posthog.com',
    dashboardUrl: 'https://us.posthog.com/organization/billing'
  },
  session: {
    loginUrl: 'https://us.posthog.com/login',
    dashboardMarkers: ['/project/', '/organization/', '/insights'],
    cookieDomains: ['posthog.com'],
    requiredCookie: 'sessionid'
  },
  // Replay the stored session cookie verbatim. A 403 means a dead session on PostHog's billing endpoints
  // (it returns 403, not 401, there) → clear the cookie to re-prompt Magic Login.
  auth: { kind: 'cookie', clearOnStatuses: [401, 403] },
  transport: {
    defaultHeaders: { Accept: 'application/json' }
  },
  config: posthogConfigSchema,
  capabilities: [
    defineCapability({
      id: 'summary',
      label: 'Summary',
      fetch: fetchPosthogBilling,
      build: (raw) => buildPosthogSummaryResult(buildBillingReport(raw.billing, raw.spend, raw.stripeInvoices)),
      sample: samplePosthogBilling
    }),
    defineCapability({
      id: 'billing',
      label: 'Billing',
      fetch: fetchPosthogBilling,
      build: (raw) => buildPosthogBillingTab(buildBillingReport(raw.billing, raw.spend, raw.stripeInvoices)),
      sample: samplePosthogBilling,
      fetchFile: fetchPosthogInvoice
    }),
    defineCapability({
      id: 'usage',
      label: 'Usage',
      fetch: fetchPosthogUsage,
      build: (raw) => buildPosthogUsageResult(buildUsageReport(raw.billing, raw.usage)),
      sample: samplePosthogUsage
    }),
    defineCapability({
      id: 'members',
      label: 'Members',
      fetch: fetchPosthogMembers,
      build: (raw) => members.result(buildPosthogMembers(raw)),
      sample: samplePosthogMembers
    })
  ],
  probe: async (ctx) => {
    // GET /api/billing/ is the cheapest authed call — a 200 proves the sessionid cookie is live.
    await ctx.client.get(`${regionBase(ctx)}/api/billing/`)
  }
})
