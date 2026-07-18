import { defineCapability, definePlugin, type CollectContext, type DocumentBytes } from '@butinapp/sdk'
import { capabilityResult, record, table, type CapabilityResult } from '@butinapp/sdk/data'
import { fetchStripeHostedInvoicePdf } from '@butinapp/sdk/integrations'
import { billing, usage, type UsageMetricInput } from '@butinapp/sdk/presets'
import { centsToMajor, epochSecDay, isoDay, round2 } from '@butinapp/sdk/util'

import { sampleScreenshotapiBilling, sampleScreenshotapiUsage } from './sample.js'

// Screenshot API (app.screenshotapi.net) — a programmatic screenshot service billed as a flat monthly
// subscription (the test account is on "Ramp Up Monthly": $99/mo for 50,000 screenshots; usage over the
// included quota would meter, but the history is a flat $99 each month).
//
// Three read-only tabs over one bearer session:
//   1. Summary — the overview: the recurring flat fee as the current-period spend + the monthly-spend trend
//      chart (the cross-service Overview rolls up its spend.mtd) + a tight status/quota/next-bill stat row.
//   2. Billing — the detail: the subscription account record (plan, status, period, card, quota, fee) + the
//      downloadable invoice history (Stripe-hosted receipts).
//   3. Usage — the current period's daily screenshot counts successful/failed + quota + all-time count
//      (counts, not money).
// Summary + Billing share one billing fetch (the query cache dedupes it).
//
// ⚠️ Money units DIFFER per endpoint: invoices + billing/info amounts are already DOLLARS (`amount: 99` = $99),
// but subscription-history `plan_amount` is raw Stripe CENTS (`9900`). Normalized to USD dollars here — the
// cents value is only the `monthlyAmount` fallback when `nextBillingAmount` is absent.

// ── constants ───────────────────────────────────────────────────────────────────────
// The dashboard (a Next.js Auth0 SPA) talks to the sibling API host carrying the Auth0 id_token as a Bearer.
const API = 'https://api.screenshotapi.net'

// ── types ─────────────────────────────────────────────────────────────────────────
// Raw* = the wire shapes the API returns (only the fields we read); the rest are the normalized domain types.

export interface RawInvoice {
  // DOLLARS (not cents) — e.g. 99 = $99.
  amount?: number
  planName?: string
  hostedUrl?: string
  // "YYYY/MM/DD".
  date?: string
}

export interface RawInvoicesResponse {
  success?: boolean
  invoices?: RawInvoice[]
  legacy?: boolean
}

export interface RawBillingInfo {
  subscriptionStatus?: string
  cardBrand?: string
  cardLastFour?: string
  cardExpMonth?: number
  cardExpYear?: number
  currentPlan?: string
  cancelAt?: number | null
  // ISO timestamp.
  nextBillDate?: string
  // DOLLARS.
  nextBillingAmount?: number
  // Included screenshots per period for the current plan.
  screenshot_amount?: number
  nextInvoiceUsage?: number
  customerId?: string
  subscriptionId?: string
  // ISO timestamp.
  currentPeriodStart?: string
  // Screenshots consumed in the current billing period.
  current_billing_period_count?: number
}

export interface RawBillingInfoResponse {
  billingInfo?: RawBillingInfo
}

export interface RawSubscription {
  status?: string
  currency?: string
  // Unix seconds.
  current_period_start?: number
  // Unix seconds.
  current_period_end?: number
  // Unix seconds.
  start_date?: number
  plan_id?: string
  // CENTS (raw Stripe).
  plan_amount?: number
  interval?: string
  interval_count?: number
  quantity?: number
  plan_name?: string
}

export interface RawSubscriptionHistory {
  subscriptions?: RawSubscription[]
}

export interface RawUsageDay {
  // Short label like "May 13" (no year).
  day?: string
  successful?: number
  failed?: number
}

export interface RawUsageResponse {
  success?: boolean
  usage?: {
    days?: RawUsageDay[]
    // All-time successful screenshots.
    totalScreenshots?: number
    totalFailed?: number
  }
}

// Normalized billing report (all money in USD dollars).
export interface ScreenshotApiInvoice {
  date?: string // 'YYYY-MM-DD' (buckets the monthly chart)
  status: string
  amount: number // dollars
  planName: string
  hostedUrl?: string | null // the Stripe-hosted invoice page; the PDF is resolved from it at download time
}

export interface ScreenshotApiSubscription {
  status: string
  planName: string
  monthlyAmount: number // recurring fee, dollars
  interval: string
  currentPeriodStart?: string
  currentPeriodEnd?: string
  nextBillDate?: string
  nextBillingAmount: number // dollars
  cardBrand: string
  cardLast4: string
  cardExp: string // 'M/YYYY' (empty when no card on file)
  quota: number // included screenshots per period
  usedThisPeriod: number
}

export interface ScreenshotApiBillingReport {
  currentMtd: number | null
  subscription: ScreenshotApiSubscription
  invoices: ScreenshotApiInvoice[] // newest-first
  totalBilled: number // sum of invoice amounts, dollars
  currency: string
}

export interface ScreenshotApiUsageDay {
  day: string
  successful: number
  failed: number
}

export interface ScreenshotApiUsageReport {
  days: ScreenshotApiUsageDay[]
  totalSuccessfulPeriod: number
  totalFailedPeriod: number
  usedThisPeriod: number
  quota: number
  lifetimeScreenshots: number
  periodStart?: string
}

// ── date helpers (service-specific formats not covered by date.ts) ──────────────────

// "YYYY/MM/DD" → "YYYY-MM-DD" (or undefined when malformed).
const isoFromSlash = (value?: string): string | undefined => {
  const m = value ? /^(\d{4})\/(\d{2})\/(\d{2})/.exec(value) : null

  return m ? `${m[1]}-${m[2]}-${m[3]}` : undefined
}

// ── billing ─────────────────────────────────────────────────────────────────────────
// Pure transform — fixture-tested. Always fully-shaped with safe defaults so a drifted response never reads
// `undefined`. currentMtd = the recurring flat fee (a flat subscription bills the same fixed amount each open
// period, already incurred at period start); null only when there's no fee figure (empty month).

export const buildScreenshotapiBilling = (
  rawInvoices: RawInvoicesResponse | null | undefined,
  rawInfo: RawBillingInfoResponse | null | undefined,
  rawSubHistory: RawSubscriptionHistory | null | undefined
): ScreenshotApiBillingReport => {
  const info = rawInfo?.billingInfo ?? {}
  const sub = rawSubHistory?.subscriptions?.[0] ?? {}

  const invoices: ScreenshotApiInvoice[] = (rawInvoices?.invoices ?? []).map((inv) => ({
    date: isoFromSlash(inv?.date),
    // The invoices endpoint lists issued/paid invoices with no status field.
    status: 'paid',
    amount: inv?.amount ?? 0,
    planName: inv?.planName ?? sub.plan_name ?? 'unknown',
    hostedUrl: inv?.hostedUrl ?? null
  }))

  const nextBillingAmount = info.nextBillingAmount ?? 0
  const monthlyAmount = nextBillingAmount || centsToMajor(sub.plan_amount)

  const subscription: ScreenshotApiSubscription = {
    status: info.subscriptionStatus ?? sub.status ?? 'unknown',
    planName: sub.plan_name ?? 'unknown',
    monthlyAmount,
    interval: sub.interval ?? 'month',
    currentPeriodStart: isoDay(info.currentPeriodStart) ?? epochSecDay(sub.current_period_start),
    currentPeriodEnd: epochSecDay(sub.current_period_end),
    nextBillDate: isoDay(info.nextBillDate),
    nextBillingAmount,
    cardBrand: info.cardBrand ?? '',
    cardLast4: info.cardLastFour ?? '',
    cardExp: info.cardExpMonth && info.cardExpYear ? `${info.cardExpMonth}/${info.cardExpYear}` : '',
    quota: info.screenshot_amount ?? 0,
    usedThisPeriod: info.current_billing_period_count ?? info.nextInvoiceUsage ?? 0
  }

  const totalBilled = round2(invoices.reduce((sum, i) => sum + i.amount, 0))
  const mtd = nextBillingAmount || monthlyAmount

  return {
    currentMtd: mtd > 0 ? mtd : null,
    subscription,
    invoices,
    totalBilled,
    currency: (sub.currency ?? 'usd').toUpperCase()
  }
}

// Summary tab — the overview the cross-service Overview rolls up (spend.mtd): the headline (the recurring flat
// fee as the current-period spend), the monthly-spend trend chart, and a tight status / quota-used / next-bill
// stat row. The subscription detail (plan, period, card, fee) and the invoice list live on the Billing tab.
// A flat recurring plan: the monthly fee IS the floor and the whole bill (no metered overage), so baseFee is
// omitted (it would just echo the headline) and the basis is 'flat'.
export const buildScreenshotapiSummaryResult = (report: ScreenshotApiBillingReport): CapabilityResult => {
  const sub = report.subscription

  return billing.summary({
    currentMtd: report.currentMtd,
    currency: report.currency,
    mtdBasis: 'flat',
    invoices: report.invoices.map((i) => ({ date: i.date, amount: i.amount, status: i.status })),
    stats: [
      { key: 'status', label: 'Status', role: 'status', value: sub.status },
      { key: 'quotaUsed', label: 'Screenshots this period', role: 'count', value: sub.usedThisPeriod, max: sub.quota },
      { key: 'nextBill', label: 'Next bill', role: 'timestamp', value: sub.nextBillDate ?? null }
    ]
  })
}

// Billing tab — the financial detail (not the Overview rollup; the headline + chart live on Summary): the
// subscription account record (plan, status, period, card, quota, monthly fee) + the downloadable invoice
// history (Stripe-hosted receipts).

interface BillingAccountRow {
  plan: string
  status: string
  period: string | null
  nextBill: string | null
  card: string | null
  quota: number
  quotaUsed: number
  monthlyFee: number
}

// Row type for the downloadable invoices table. The PDF has no direct URL (it's resolved from `hostedUrl` at
// download time via fetchFile), so the table downloads through the fetch source; `name` (hidden) is the filename.
interface BillingInvoiceRow {
  date: string | null
  amount: number
  status: string
  hostedUrl: string | null
  name: string
}

export const buildScreenshotapiBillingTab = (report: ScreenshotApiBillingReport): CapabilityResult => {
  const sub = report.subscription
  const ccy = report.currency
  const period =
    sub.currentPeriodStart && sub.currentPeriodEnd ? `${sub.currentPeriodStart} → ${sub.currentPeriodEnd}` : null
  const exp = sub.cardExp ? ` (exp ${sub.cardExp})` : ''
  const card = sub.cardBrand && sub.cardLast4 ? `${sub.cardBrand} •••• ${sub.cardLast4}${exp}` : null

  const account = record<BillingAccountRow>({
    id: 'account',
    fields: [
      { key: 'plan', label: 'Plan', role: 'label' },
      { key: 'status', label: 'Status', role: 'status' },
      { key: 'period', label: 'Current period', role: 'text' },
      { key: 'nextBill', label: 'Next bill', role: 'timestamp' },
      { key: 'card', label: 'Card', role: 'label' },
      { key: 'quota', label: 'Included quota', role: 'count' },
      { key: 'quotaUsed', label: 'Screenshots this period', role: 'count' },
      { key: 'monthlyFee', label: 'Monthly fee', role: 'money', currency: ccy }
    ],
    value: {
      plan: sub.planName,
      status: sub.status,
      period,
      nextBill: sub.nextBillDate ?? null,
      card,
      quota: sub.quota,
      quotaUsed: sub.usedThisPeriod,
      monthlyFee: sub.monthlyAmount
    }
  })

  const invoices = table<BillingInvoiceRow>({
    id: 'invoices',
    columns: [
      { key: 'date', label: 'Date', role: 'timestamp' },
      { key: 'amount', label: 'Amount', role: 'money', currency: ccy },
      { key: 'status', label: 'Status', role: 'status' },
      { key: 'hostedUrl', label: 'Receipt', role: 'url' },
      { key: 'name', role: 'label', hidden: true }
    ],
    rows: report.invoices.map((i) => ({
      date: i.date ?? null,
      amount: i.amount,
      status: i.status,
      hostedUrl: i.hostedUrl ?? null,
      name: `Invoice ${i.date ?? 'unknown'}`
    })),
    // One subscription invoice per billing month (the payload carries no invoice id) — the date is the stable
    // unique identity, keyed so each invoice's status/amount accumulates in the ledger past the fetch window.
    key: 'date'
  })

  return capabilityResult({
    sections: [
      account.keyvalue({ title: 'Subscription' }),
      report.invoices.length
        ? invoices.fileTable({
            title: 'Invoices',
            name: 'name',
            // The PDF isn't a direct URL — fetchScreenshotapiInvoice resolves it from the row's hostedUrl.
            source: { fetch: true },
            ext: 'pdf',
            category: 'Invoices'
          })
        : null
    ]
  })
}

// Summary + Billing read the same three billing endpoints; both fetch the same raw bundle and the core query
// cache dedupes the underlying reads. fetch returns the RAW wire bundle; buildScreenshotapiBilling normalizes.
export interface RawScreenshotapiBilling {
  invoices: RawInvoicesResponse | null
  info: RawBillingInfoResponse | null
  subHistory: RawSubscriptionHistory | null
}

const fetchScreenshotapiBilling = async (ctx: CollectContext): Promise<RawScreenshotapiBilling> => {
  const [invoices, info, subHistory] = await Promise.all([
    ctx.client.get<RawInvoicesResponse>(`${API}/v1/billing/invoices`),
    ctx.client.get<RawBillingInfoResponse>(`${API}/v1/billing/info`),
    ctx.client.get<RawSubscriptionHistory>(`${API}/v1/billing/subscription-history`)
  ])

  return { invoices, info, subHistory }
}

// Per-row invoice download: the API exposes only the Stripe-hosted invoice page, so the SDK helper resolves
// the real PDF via Stripe's two-hop file-url handoff (no screenshotapi bearer/cookie on either hop).
const fetchScreenshotapiInvoice = (ctx: CollectContext, row: Record<string, unknown>): Promise<DocumentBytes> =>
  fetchStripeHostedInvoicePdf(ctx.client, typeof row.hostedUrl === 'string' ? row.hostedUrl : null)

// ── usage ─────────────────────────────────────────────────────────────────────────
// Pure transform — fixture-tested. The current billing period's screenshot consumption. Counts, not money.

export const buildScreenshotapiUsage = (
  rawUsage: RawUsageResponse | null | undefined,
  rawInfo: RawBillingInfoResponse | null | undefined
): ScreenshotApiUsageReport => {
  const info = rawInfo?.billingInfo ?? {}
  const days: ScreenshotApiUsageDay[] = (rawUsage?.usage?.days ?? []).map((d) => ({
    day: d?.day ?? '',
    successful: d?.successful ?? 0,
    failed: d?.failed ?? 0
  }))

  return {
    days,
    totalSuccessfulPeriod: days.reduce((sum, d) => sum + d.successful, 0),
    totalFailedPeriod: days.reduce((sum, d) => sum + d.failed, 0),
    usedThisPeriod: info.current_billing_period_count ?? info.nextInvoiceUsage ?? 0,
    quota: info.screenshot_amount ?? 0,
    lifetimeScreenshots: rawUsage?.usage?.totalScreenshots ?? 0,
    periodStart: isoDay(info.currentPeriodStart)
  }
}

// The usage metrics (counts) feeding usage.result: screenshots this period (vs quota), successful/failed splits,
// and the account all-time count. No cost field → no money summary (these are counts).
export const buildScreenshotapiUsageMetrics = (report: ScreenshotApiUsageReport): UsageMetricInput[] => [
  { label: 'Screenshots this period', value: report.usedThisPeriod, unit: 'screenshots', limit: report.quota || null },
  { label: 'Successful (period)', value: report.totalSuccessfulPeriod, unit: 'screenshots' },
  { label: 'Failed (period)', value: report.totalFailedPeriod, unit: 'screenshots' },
  { label: 'All-time screenshots', value: report.lifetimeScreenshots, unit: 'screenshots' }
]

// Row type for the daily screenshot breakdown table.
interface DailyRow {
  day: string
  successful: number
  failed: number
}

// Compose the usage result: the count metrics + an optional daily successful/failed breakdown. The API's day
// labels ("May 13") carry no year, so they're categorical — rendered as a table, not a timeseries (whose x
// axis the contract requires to be a real timestamp column).
export const buildScreenshotapiUsageResult = (report: ScreenshotApiUsageReport): CapabilityResult => {
  const result = usage.result({
    periodStart: report.periodStart,
    metrics: buildScreenshotapiUsageMetrics(report)
  })

  if (report.days.length) {
    const dailyTable = table<DailyRow>({
      id: 'daily',
      columns: [
        { key: 'day', label: 'Day', role: 'label' },
        { key: 'successful', label: 'Successful', role: 'count' },
        { key: 'failed', label: 'Failed', role: 'count' }
      ],
      rows: report.days.map((d) => ({ day: d.day, successful: d.successful, failed: d.failed }))
    })
    const { dataset, view } = dailyTable.table({ title: 'Daily screenshots' })

    result.datasets.push(dataset)
    result.views = [...(result.views ?? []), view]
  }

  return result
}

// fetch returns the RAW wire bundle; buildScreenshotapiUsage normalizes it.
export interface RawScreenshotapiUsage {
  usage: RawUsageResponse | null
  info: RawBillingInfoResponse | null
}

const fetchScreenshotapiUsage = async (ctx: CollectContext): Promise<RawScreenshotapiUsage> => {
  const [usage, info] = await Promise.all([
    ctx.client.get<RawUsageResponse>(`${API}/v1/billing/usage`),
    ctx.client.get<RawBillingInfoResponse>(`${API}/v1/billing/info`)
  ])

  return { usage, info }
}

// ── descriptor ──────────────────────────────────────────────────────────────────────
// bearer-token over plain Node axios. The durable credential is NOT a cookie — it's the long-lived (~13-month
// exp) Auth0 id_token the dashboard SPA stores in localStorage under `@SCREENSHOT-id_token`. Magic Login
// captures it once into the `accessToken` field; core attaches `Authorization: Bearer <accessToken>` per fetch
// (bearer-token's default tokenField). The API host is Cloudflare-fronted but serves JSON directly (the edge
// accepts a plain client), so node transport is fine — and we mirror the cross-subdomain Origin/Sec-Fetch markers the
// browser sends. When the token finally expires the API 401s → core clears the session and the UI re-prompts.
export const screenshotapiPlugin = definePlugin({
  reportingCurrency: 'USD',
  meta: {
    id: 'screenshotapi',
    name: 'Screenshot API',
    vendor: 'Screenshot API',
    category: 'devtools',
    color: '#5b2ef7',
    description: 'Screenshot API subscription billing + screenshot usage.',
    homepage: 'https://screenshotapi.net',
    dashboardUrl: 'https://app.screenshotapi.net'
  },
  session: {
    loginUrl: 'https://app.screenshotapi.net/login',
    dashboardMarkers: ['/dashboard', '/usage', '/billing'],
    cookieDomains: ['screenshotapi.net'],
    // The credential is NOT a cookie — it's the Auth0 id_token in localStorage. Gate on it landing, not a cookie.
    localStorageTokens: [{ key: '@SCREENSHOT-id_token', storeAs: 'accessToken' }]
  },
  auth: { kind: 'bearer-token', tokenField: 'accessToken' },
  transport: {
    defaultHeaders: {
      Accept: 'application/json, text/plain, */*',
      Origin: 'https://app.screenshotapi.net',
      Referer: 'https://app.screenshotapi.net/',
      'Sec-Fetch-Site': 'same-site',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty'
    }
  },
  capabilities: [
    defineCapability({
      id: 'summary',
      label: 'Summary',
      fetch: fetchScreenshotapiBilling,
      build: (raw) =>
        buildScreenshotapiSummaryResult(buildScreenshotapiBilling(raw.invoices, raw.info, raw.subHistory)),
      sample: sampleScreenshotapiBilling
    }),
    defineCapability({
      id: 'billing',
      label: 'Billing',
      fetch: fetchScreenshotapiBilling,
      build: (raw) => buildScreenshotapiBillingTab(buildScreenshotapiBilling(raw.invoices, raw.info, raw.subHistory)),
      sample: sampleScreenshotapiBilling,
      fetchFile: fetchScreenshotapiInvoice
    }),
    defineCapability({
      id: 'usage',
      label: 'Usage',
      fetch: fetchScreenshotapiUsage,
      build: (raw) => buildScreenshotapiUsageResult(buildScreenshotapiUsage(raw.usage, raw.info)),
      sample: sampleScreenshotapiUsage
    })
  ],
  probe: async (ctx) => {
    // /v1/billing/info is the cheapest authed call — a 200 proves the id_token Bearer is still live.
    await ctx.client.get(`${API}/v1/billing/info`)
  }
})
