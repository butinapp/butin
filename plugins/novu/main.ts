import {
  defineCapability,
  definePlugin,
  type AuthAttachment,
  type AuthContext,
  type CollectContext
} from '@butinapp/sdk'
import {
  capabilityResult,
  record,
  table,
  type CapabilityResult,
  type Column,
  type StatFieldSpec
} from '@butinapp/sdk/data'
import {
  fetchStripePortalResource,
  openStripePortal,
  type RawStripeInvoice,
  type RawStripeInvoiceList
} from '@butinapp/sdk/integrations'
import { billing, members, type BillingInvoiceInput, type MembersInput } from '@butinapp/sdk/presets'
import { centsToMajor, dayOf, epochSecDay, isoDaysAgo, round2, startCase } from '@butinapp/sdk/util'

import { sampleNovuBilling, sampleNovuMemberships, sampleNovuUsage } from './sample.js'

// Novu Cloud (dashboard.novu.co): read-only Billing + Usage. Novu delegates auth to **Clerk** — api.novu.co
// takes a short-lived (~60s) Clerk session JWT as `Authorization: Bearer`, NOT Novu's public ApiKey. The
// durable credential is the Clerk `__client` cookie on .clerk.dashboard.novu.co. resolve() mints a fresh
// Bearer per fetch from that cookie (the minted-jwt kind), so nothing is written back. Billing history has
// no Novu invoice API — it lives in a Stripe-hosted billing portal (the portal page embeds bps/ek/account
// tokens we scrape, then read the portal's /invoices). All hosts are plain axios (node transport): Cloudflare-
// fronted api.novu.co only needs an Origin header, which axios sets.
const FAPI_BASE = 'https://clerk.dashboard.novu.co'
const NOVU_API_BASE = 'https://api.novu.co'
const DASHBOARD_ORIGIN = 'https://dashboard.novu.co'
const BILLING_PAGE_URL = `${DASHBOARD_ORIGIN}/settings/billing`
const MEMBERS_PAGE_URL = `${DASHBOARD_ORIGIN}/settings/team`
const ACTIVITY_PAGE_URL = `${DASHBOARD_ORIGIN}/activity`
// Clerk FAPI pins these as query params on every call; bump them if Clerk changes the pair.
const CLERK_API_VERSION = '2026-05-12'
const CLERK_JS_VERSION = '6.17.0'
// Novu Cloud bills in USD; stamped on every money column/value.
const CURRENCY = 'USD'

// --- types: Raw* wire shapes + normalized domain types (the data dictionary). The Stripe invoice/line shapes
//     (RawStripeInvoice / RawStripeLine / RawStripeInvoiceList) + the portal session come from @butinapp/sdk. ---

// api.novu.co/v1/billing/subscription → `{ data: {...} }`.
export interface RawNovuSubscription {
  data?: {
    apiServiceLevel?: string
    isActive?: boolean
    status?: string
    hasPaymentMethod?: boolean
    currentPeriodStart?: string | null
    currentPeriodEnd?: string | null
    billingInterval?: string
    events?: { current?: number; included?: number }
    trial?: { isActive?: boolean; start?: string | null; end?: string | null; daysTotal?: number }
    cancelAt?: string | null
  }
}

// GET /v1/client body — the active session's freshly-minted token lives under .response.sessions[].
interface RawClerkClient {
  response?: RawClerkClientBody
  client?: RawClerkClientBody
  sessions?: RawClerkSession[]
  last_active_session_id?: string
}

interface RawClerkClientBody {
  sessions?: RawClerkSession[]
  last_active_session_id?: string
}

interface RawClerkSession {
  id?: string
  last_active_token?: { jwt?: string }
  last_active_organization_id?: string
}

// GET /v1/organizations/{orgId}/memberships → `{ response: { data: [...] } }`. Novu's org roster lives on
// Clerk (same __client cookie → minted Bearer the billing/usage capabilities replay). Each membership nests
// the person under public_user_data and carries the un-prefixed-on-display Clerk role (org:owner, …).
export interface RawClerkMembershipList {
  response?: { data?: RawClerkMembership[] }
  data?: RawClerkMembership[]
}

export interface RawClerkMembership {
  id?: string // orgmem_…
  role?: string // org:owner | org:admin | org:author | org:viewer
  role_name?: string
  public_user_data?: {
    user_id?: string
    identifier?: string // the member's email
    first_name?: string | null
    last_name?: string | null
  }
}

// Normalized plan summary — the Summary headline reads the plan slug + status; the Billing tab record reads
// the full set (period, billing interval, trial, payment method, cancel date).
export interface NovuPlanSummary {
  plan: string
  status: string
  hasPaymentMethod: boolean
  billingInterval: string
  currentPeriodStart?: string
  currentPeriodEnd?: string
  trialActive: boolean
  cancelAt?: string
}

// --- date helpers ---

// --- auth: mint a fresh Clerk session JWT from the durable __client cookie (minted-jwt) ---

// Pull the active session's freshly-minted token from a GET /v1/client body. FAPI returns the client under
// `.response`; an unauthenticated client has an empty `sessions` array → the captured cookie is stale.
export const parseClerkJwt = (body: RawClerkClient | undefined): string => {
  const client: RawClerkClientBody = body?.response ?? body?.client ?? body ?? {}
  const sessions = client.sessions ?? []
  const sessionId = client.last_active_session_id ?? sessions[0]?.id

  if (!sessionId || sessions.length === 0) {
    throw new Error('[novu] No active Clerk session — re-run Magic Login.')
  }

  const active = sessions.find((s) => s.id === sessionId) ?? sessions[0]
  const jwt = active?.last_active_token?.jwt

  if (!jwt) {
    throw new Error('[novu] Clerk session has no active token — re-run Magic Login.')
  }

  return jwt
}

// Pull the active session's { orgId, sessionId } from a GET /v1/client body — the roster endpoint is org-scoped
// (`/v1/organizations/{orgId}/memberships`) and Clerk pins the active session id as a query param. An empty
// `sessions` array means the captured cookie is stale; no active org means none is open in the dashboard yet.
export const parseClerkOrg = (body: RawClerkClient | undefined): { orgId: string; sessionId: string } => {
  const client: RawClerkClientBody = body?.response ?? body?.client ?? body ?? {}
  const sessions = client.sessions ?? []
  const sessionId = client.last_active_session_id ?? sessions[0]?.id

  if (!sessionId || sessions.length === 0) {
    throw new Error('[novu] No active Clerk session — re-run Magic Login.')
  }

  const active = sessions.find((s) => s.id === sessionId) ?? sessions[0]
  const orgId = active?.last_active_organization_id

  if (!orgId) {
    throw new Error(
      '[novu] No active organization — open an organization in the Novu dashboard, then re-run Magic Login.'
    )
  }

  return { orgId, sessionId }
}

// resolve(): GET clerk.dashboard.novu.co/v1/client with the stored __client cookie → the active session's
// fresh ~60s JWT → attach it as the Bearer + the dashboard Origin for api.novu.co. GET does not rotate the
// cookie (no write-back). Core memoizes per the minted-jwt contract; we never hand-cache across the TTL.
// The captured cookie rides along too: the Members tab reads its roster off the Clerk FAPI host, which
// authenticates on __client, not the api.novu.co Bearer — those calls drop the Bearer (sendAuth:false) and
// replay this cookie instead.
export const resolveNovuJwt = async ({ client, creds }: AuthContext): Promise<AuthAttachment> => {
  const body = await client.get<RawClerkClient>(
    `${FAPI_BASE}/v1/client?__clerk_api_version=${CLERK_API_VERSION}&_clerk_js_version=${CLERK_JS_VERSION}`,
    { Origin: DASHBOARD_ORIGIN, Referer: BILLING_PAGE_URL }
  )
  const jwt = parseClerkJwt(body)

  return { headers: { Authorization: `Bearer ${jwt}`, Origin: DASHBOARD_ORIGIN }, cookie: creds.get('cookie') ?? '' }
}

// --- billing: subscription plan + Stripe-portal invoice history ---

// Unix seconds → UTC 'YYYY-MM-DD', preferring effective_at → finalized_at → created.
const invoiceDate = (inv: RawStripeInvoice): string | undefined =>
  epochSecDay(inv.effective_at) ?? epochSecDay(inv.finalized_at) ?? epochSecDay(inv.created)

// Pure transform — fixture-tested. Normalize Stripe invoices (cents → USD dollars, unix → ISO day), newest
// first. pdfUrl falls back to the hosted invoice URL so the PDF column always links somewhere useful.
export const buildNovuInvoices = (raw: RawStripeInvoiceList): BillingInvoiceInput[] =>
  (raw?.data ?? [])
    .map((inv) => ({
      date: invoiceDate(inv),
      amount: centsToMajor(inv.total ?? inv.amount_due),
      status: inv.status ?? 'unknown',
      pdfUrl: inv.invoice_pdf || null,
      hostedUrl: inv.hosted_invoice_url || null
    }))
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))

// Pure transform — fixture-tested. The current plan/period summary from api.novu.co/v1/billing/subscription.
export const buildNovuPlan = (raw: RawNovuSubscription): NovuPlanSummary => {
  const sub = raw?.data ?? {}

  return {
    plan: sub.apiServiceLevel ?? 'unknown',
    status: sub.status ?? 'unknown',
    hasPaymentMethod: !!sub.hasPaymentMethod,
    billingInterval: sub.billingInterval ?? 'month',
    currentPeriodStart: dayOf(sub.currentPeriodStart),
    currentPeriodEnd: dayOf(sub.currentPeriodEnd),
    trialActive: !!sub.trial?.isActive,
    cancelAt: dayOf(sub.cancelAt)
  }
}

// Title-case Novu's plan slug ('business' → 'Business'); 'unknown' degrades to em-dash (undefined).
const planLabel = (plan: string): string | undefined => (plan && plan !== 'unknown' ? startCase(plan) : undefined)

// One billing fetch normalized once: the Stripe-portal invoice history + the api.novu.co subscription plan.
// Summary and Billing both build from this — the collects share it, the query cache dedupes the fetches.
export interface NovuBillingReport {
  invoices: BillingInvoiceInput[]
  plan: NovuPlanSummary
}

export const buildNovuBilling = (
  rawInvoices: RawStripeInvoiceList,
  rawSub: RawNovuSubscription
): NovuBillingReport => ({
  invoices: buildNovuInvoices(rawInvoices),
  plan: buildNovuPlan(rawSub)
})

// One month's invoiced spend ('YYYY-MM'). Novu posts one invoice per billing month and exposes no separate
// running total, so a month's invoice IS its month-to-date figure; null when that month has no invoice.
export const currentMonthInvoiced = (invoices: BillingInvoiceInput[], month: string): number | null => {
  const inMonth = invoices.filter((i) => i.date?.slice(0, 7) === month)

  return inMonth.length > 0 ? round2(inMonth.reduce((sum, i) => sum + i.amount, 0)) : null
}

// The most recent 'YYYY-MM' an invoice falls in, or undefined when there are none.
const latestInvoicedMonth = (invoices: BillingInvoiceInput[]): string | undefined =>
  invoices
    .map((i) => i.date?.slice(0, 7))
    .filter((m): m is string => Boolean(m))
    .sort()
    .at(-1)

// Summary tab — the lean overview the cross-service Overview rolls up: the monthly-spend chart off the invoice
// history + the plan/invoice-count/status headline stats. Novu exposes no running MTD figure, so "This month"
// is the latest billed month's invoiced total (invoiced basis); null only when there are no invoices yet.
export const buildNovuSummaryResult = (
  report: NovuBillingReport,
  month = latestInvoicedMonth(report.invoices)
): CapabilityResult =>
  billing.summary({
    currentMtd: month ? currentMonthInvoiced(report.invoices, month) : null,
    mtdBasis: 'invoiced',
    currency: CURRENCY,
    plan: planLabel(report.plan.plan),
    invoices: report.invoices,
    stats: [
      { key: 'invoiceCount', label: 'Invoices', role: 'count', value: report.invoices.length },
      { key: 'status', label: 'Status', role: 'label', value: report.plan.status }
    ]
  })

// Billing tab — the financial detail (not the Overview rollup; the headline + chart live on Summary): the
// subscription account record (plan, status, period, billing interval, trial, payment method, cancel date) and
// the downloadable invoice history (PDF, falling back to the hosted invoice URL).

interface NovuAccountRow {
  plan: string
  status: string
  billingInterval: string
  period: string | null
  trial: string
  paymentMethod: string
  cancelAt: string | null
}

interface NovuInvoiceRow {
  date: string | null
  amount: number
  status: string
  pdfUrl: string | null
  // Hidden — carried for the download filename.
  name: string
}

export const buildNovuBillingTab = (report: NovuBillingReport): CapabilityResult => {
  const plan = report.plan
  const period =
    plan.currentPeriodStart && plan.currentPeriodEnd ? `${plan.currentPeriodStart} → ${plan.currentPeriodEnd}` : null

  const account = record<NovuAccountRow>({
    id: 'account',
    fields: [
      { key: 'plan', label: 'Plan', role: 'label' },
      { key: 'status', label: 'Status', role: 'status' },
      { key: 'billingInterval', label: 'Billing interval', role: 'label' },
      { key: 'period', label: 'Current period', role: 'label' },
      { key: 'trial', label: 'Trial', role: 'label' },
      { key: 'paymentMethod', label: 'Payment method', role: 'label' },
      { key: 'cancelAt', label: 'Cancels at', role: 'timestamp' }
    ],
    value: {
      plan: planLabel(plan.plan) ?? plan.plan,
      status: plan.status,
      billingInterval: plan.billingInterval,
      period,
      trial: plan.trialActive ? 'Active' : 'No',
      paymentMethod: plan.hasPaymentMethod ? 'On file' : 'None',
      cancelAt: plan.cancelAt ?? null
    }
  })

  const invoices = table<NovuInvoiceRow>({
    id: 'invoices',
    columns: [
      { key: 'date', label: 'Date', role: 'timestamp' },
      { key: 'amount', label: 'Amount', role: 'money', currency: CURRENCY },
      { key: 'status', label: 'Status', role: 'status' },
      { key: 'pdfUrl', label: 'PDF', role: 'url' },
      { key: 'name', role: 'label', hidden: true }
    ],
    rows: report.invoices.map((i) => ({
      date: i.date ?? null,
      amount: i.amount ?? 0,
      status: i.status ?? 'unknown',
      pdfUrl: i.pdfUrl ?? i.hostedUrl ?? null,
      name: `Invoice ${i.date ?? 'unknown'}`
    }))
  })

  return capabilityResult({
    sections: [
      account.keyvalue({ title: 'Subscription' }),
      invoices.dataset.rows.length > 0
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

// Invoice history via Novu's Stripe-hosted billing portal (Novu has no invoice API of its own):
//   1. GET api.novu.co/v1/billing/portal?isv2dashboard=true (Clerk Bearer) → { data: stripe portal URL }
//   2. GET that portal page (no auth) → HTML embedding the bps/ek/account tokens
//   3. GET the portal session's /invoices with the ephemeral key — the same captcha-free call the UI makes.
const fetchStripeInvoices = async (ctx: CollectContext, limit = 24): Promise<RawStripeInvoiceList> => {
  const portal = await ctx.client.get<{ data?: string }>(`${NOVU_API_BASE}/v1/billing/portal?isv2dashboard=true`, {
    Referer: BILLING_PAGE_URL
  })
  const url = portal?.data

  if (!url) {
    throw new Error('[novu] /v1/billing/portal did not return a Stripe portal session URL (session expired?).')
  }

  // The portal page + invoice call ride on Stripe's own ephemeral-key auth, not the Novu/Clerk session — the
  // shared helpers drop the Clerk Bearer + cookie on both hops.
  const session = await openStripePortal(ctx.client, url)

  return fetchStripePortalResource<RawStripeInvoiceList>(ctx.client, session, 'invoices', { limit })
}

// Summary + Billing share this one billing fetch (the query cache dedupes the underlying reads): the raw Stripe-
// portal invoice history + the raw api.novu.co subscription, the wire shapes both tabs' build closures normalize.
export interface RawNovuBilling {
  invoices: RawStripeInvoiceList
  sub: RawNovuSubscription
}

const fetchNovuBilling = async (ctx: CollectContext): Promise<RawNovuBilling> => {
  const [invoices, sub] = await Promise.all([
    fetchStripeInvoices(ctx).catch(() => ({}) as RawStripeInvoiceList),
    ctx.client.get<RawNovuSubscription>(`${NOVU_API_BASE}/v1/billing/subscription`, { Referer: BILLING_PAGE_URL })
  ])

  return { invoices, sub: sub ?? {} }
}

// --- usage: metered workflow-run allowance + engagement scorecards + delivery / runs trends + top workflows ---

// The analytics charts the dashboard's Usage page loads over a rolling window (createdAtGte = now − N days).
const USAGE_WINDOW_DAYS = 30
// /v1/activity/charts returns one slice per reportType in a single call: four current-vs-previous scorecards,
// the top workflows by send volume, and the daily workflow-runs + per-channel delivery trends.
const USAGE_REPORT_TYPES = [
  'messages-delivered',
  'active-subscribers',
  'avg-messages-per-subscriber',
  'total-interactions',
  'workflow-by-volume',
  'workflow-runs-trend',
  'delivery-trend'
] as const

// /v1/activity/charts → `{ data: { <reportType>: … } }`. Scorecards are a current/previous pair; the *-trend
// slices are daily point arrays; workflow-by-volume is a per-workflow send count.
interface RawScorecard {
  currentPeriod?: number
  previousPeriod?: number
}

interface RawWorkflowVolume {
  workflowName?: string
  count?: number
}

interface RawRunsTrendPoint {
  timestamp?: string
  completed?: number
}

interface RawDeliveryTrendPoint {
  timestamp?: string
  inApp?: number
  email?: number
  sms?: number
  chat?: number
  push?: number
}

export interface RawActivityCharts {
  data?: {
    'messages-delivered'?: RawScorecard
    'active-subscribers'?: RawScorecard
    'avg-messages-per-subscriber'?: RawScorecard
    'total-interactions'?: RawScorecard
    'workflow-by-volume'?: RawWorkflowVolume[]
    'workflow-runs-trend'?: RawRunsTrendPoint[]
    'delivery-trend'?: RawDeliveryTrendPoint[]
  }
}

type DeliveryChannel = keyof Omit<RawDeliveryTrendPoint, 'timestamp'>

const DELIVERY_CHANNELS: { key: DeliveryChannel; label: string }[] = [
  { key: 'inApp', label: 'In-App' },
  { key: 'email', label: 'Email' },
  { key: 'sms', label: 'SMS' },
  { key: 'chat', label: 'Chat' },
  { key: 'push', label: 'Push' }
]

// The engagement scorecards, in display order, mapping a card key to its activity-charts reportType.
const SCORECARDS: { key: string; label: string; report: keyof NonNullable<RawActivityCharts['data']> }[] = [
  { key: 'messagesDelivered', label: 'Messages delivered', report: 'messages-delivered' },
  { key: 'activeSubscribers', label: 'Active subscribers', report: 'active-subscribers' },
  { key: 'interactions', label: 'Inbox interactions', report: 'total-interactions' },
  { key: 'avgPerSubscriber', label: 'Avg msgs / subscriber', report: 'avg-messages-per-subscriber' }
]

// Compact a count for a caption (59678 → '59.7K'); keeps the sign so a negative delta reads '-9'.
const compactCount = (n: number): string => {
  const abs = Math.abs(n)

  if (abs >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`
  }

  if (abs >= 1_000) {
    return `${(n / 1_000).toFixed(1)}K`
  }

  return `${Math.round(n * 10) / 10}`
}

// A scorecard's current-vs-previous delta as a caption ('+59.7K vs prior period'); undefined when the slice
// (or its previous figure) is absent so the card renders without one.
const deltaCaption = (sc?: RawScorecard): string | undefined => {
  if (!sc || sc.currentPeriod == null || sc.previousPeriod == null) {
    return undefined
  }

  const delta = sc.currentPeriod - sc.previousPeriod

  return `${delta >= 0 ? '+' : ''}${compactCount(delta)} vs prior period`
}

// Pure transform — fixture-tested. The Usage tab: a headline stat row (the metered workflow-run allowance with
// its used/included progress, then each engagement scorecard with its prior-period delta), a per-channel
// stacked delivery trend, the daily workflow-runs trend, and the top workflows by volume. The subscription is
// always present; each charts-derived section is gated on data, so a charts fetch failure degrades to just the
// allowance card.
export const buildNovuUsageResult = (rawSub: RawNovuSubscription, rawCharts: RawActivityCharts): CapabilityResult => {
  const sub = rawSub?.data ?? {}
  const charts = rawCharts?.data ?? {}
  const periodStart = dayOf(sub.currentPeriodStart)
  const periodEnd = dayOf(sub.currentPeriodEnd)
  const period = periodStart && periodEnd ? `${periodStart} → ${periodEnd}` : undefined
  const eventsIncluded = sub.events?.included ?? 0

  const fields: Column[] = [{ key: 'workflowRuns', label: 'Workflow Runs', role: 'count' }]
  const value: Record<string, unknown> = { workflowRuns: sub.events?.current ?? 0 }
  const statFields: (string | StatFieldSpec<Record<string, unknown>>)[] = [
    { key: 'workflowRuns', max: eventsIncluded > 0 ? eventsIncluded : undefined, caption: period }
  ]

  for (const card of SCORECARDS) {
    const sc = charts[card.report] as RawScorecard | undefined

    if (!sc || sc.currentPeriod == null) {
      continue
    }

    fields.push({ key: card.key, label: card.label, role: 'count' })
    value[card.key] = sc.currentPeriod
    statFields.push({ key: card.key, caption: deltaCaption(sc) })
  }

  const headline = record<Record<string, unknown>>({ id: 'usage', fields: fields as never, value: value as never })

  // Delivery trend, stacked by channel: long-format rows for every channel that saw volume over the window (an
  // all-zero channel is dropped so the legend stays meaningful).
  const deliveryPoints = charts['delivery-trend'] ?? []
  const deliveryRows = DELIVERY_CHANNELS.filter((c) => deliveryPoints.some((p) => (p[c.key] ?? 0) > 0)).flatMap((c) =>
    deliveryPoints.map((p) => ({ day: p.timestamp ?? '', channel: c.label, count: p[c.key] ?? 0 }))
  )
  const delivery = table<{ day: string; channel: string; count: number }>({
    id: 'delivery',
    columns: [
      { key: 'day', label: 'Day', role: 'timestamp' },
      { key: 'channel', label: 'Channel', role: 'label' },
      { key: 'count', label: 'Delivered', role: 'count' }
    ],
    rows: deliveryRows
  })

  const runsTrend = charts['workflow-runs-trend'] ?? []
  const runs = table<{ day: string; runs: number }>({
    id: 'runs',
    columns: [
      { key: 'day', label: 'Day', role: 'timestamp' },
      { key: 'runs', label: 'Workflow runs', role: 'count' }
    ],
    rows: runsTrend.map((p) => ({ day: p.timestamp ?? '', runs: p.completed ?? 0 }))
  })

  const volume = charts['workflow-by-volume'] ?? []
  const topWorkflows = table<{ workflow: string; count: number }>({
    id: 'topWorkflows',
    columns: [
      { key: 'workflow', label: 'Workflow', role: 'label' },
      { key: 'count', label: 'Runs', role: 'count' }
    ],
    rows: volume.map((w) => ({ workflow: w.workflowName ?? 'Unknown', count: w.count ?? 0 }))
  })

  return capabilityResult({
    sections: [
      headline.stat({ fields: statFields }),
      deliveryRows.length > 0
        ? delivery.timeseries({
            x: 'day',
            y: 'count',
            stackBy: 'channel',
            granularity: 'daily',
            title: 'Delivery trend'
          })
        : null,
      runsTrend.length > 0
        ? runs.timeseries({ x: 'day', y: 'runs', granularity: 'daily', title: 'Workflow runs' })
        : null,
      topWorkflows.dataset.rows.length > 0 ? topWorkflows.table({ title: 'Top workflows by volume' }) : null
    ]
  })
}

// The metered allowance comes off the subscription; the engagement scorecards + trends + top workflows off a
// single activity-charts call over the rolling window (best-effort — a failure still leaves the allowance card).
export interface RawNovuUsage {
  sub: RawNovuSubscription
  charts: RawActivityCharts
}

const fetchNovuUsage = async (ctx: CollectContext): Promise<RawNovuUsage> => {
  const since = encodeURIComponent(isoDaysAgo(USAGE_WINDOW_DAYS))
  const reports = USAGE_REPORT_TYPES.map((r) => `reportType%5B%5D=${r}`).join('&')
  const [sub, charts] = await Promise.all([
    ctx.client.get<RawNovuSubscription>(`${NOVU_API_BASE}/v1/billing/subscription`, { Referer: BILLING_PAGE_URL }),
    ctx.client
      .get<RawActivityCharts>(`${NOVU_API_BASE}/v1/activity/charts?createdAtGte=${since}&${reports}`, {
        Referer: ACTIVITY_PAGE_URL
      })
      .catch(() => ({}) as RawActivityCharts)
  ])

  return { sub: sub ?? {}, charts: charts ?? {} }
}

// --- members: the org roster (Clerk org memberships, same __client → Bearer session) ---

// Drop Clerk's `org:` prefix for display ('org:owner' → 'owner'); pass anything un-prefixed through unchanged.
const ROLE_PREFIX = 'org:'
const displayRole = (role?: string): string | undefined =>
  role ? (role.startsWith(ROLE_PREFIX) ? role.slice(ROLE_PREFIX.length) : role) : undefined

// Pure transform — fixture-tested. Each Clerk membership nests the person under public_user_data: join the
// first/last name, surface the identifier as the email, and key on user_id (falling back to the orgmem id).
export const buildNovuMembers = (raw: RawClerkMembershipList): MembersInput => {
  const memberships = raw?.response?.data ?? raw?.data ?? []

  return {
    members: memberships.map((m, i) => {
      const u = m.public_user_data ?? {}
      const name = [u.first_name, u.last_name].filter(Boolean).join(' ').trim()

      return {
        id: u.user_id ?? m.id ?? String(i),
        name: name || undefined,
        email: u.identifier,
        role: displayRole(m.role)
      }
    })
  }
}

// A Clerk FAPI GET: authenticated by the replayed __client cookie, NOT the api.novu.co Bearer — sendAuth:false
// drops that wrong-audience Bearer (Clerk 401s it) while resolve()'s cookie still rides along.
const clerkGet = async <T>(ctx: CollectContext, url: string): Promise<T> =>
  (
    await ctx.client.request<T>({
      url,
      sendAuth: false,
      headers: { Origin: DASHBOARD_ORIGIN, Referer: MEMBERS_PAGE_URL }
    })
  ).data

// Roster fetch: resolve { orgId, sessionId } from /v1/client (the same call the JWT mint uses), then GET the
// org's Clerk memberships with the session-id query param Clerk pins on org-scoped calls — both cookie-authed.
const fetchNovuMembers = async (ctx: CollectContext): Promise<RawClerkMembershipList> => {
  const clientBody = await clerkGet<RawClerkClient>(
    ctx,
    `${FAPI_BASE}/v1/client?__clerk_api_version=${CLERK_API_VERSION}&_clerk_js_version=${CLERK_JS_VERSION}`
  )
  const { orgId, sessionId } = parseClerkOrg(clientBody)

  return (
    (await clerkGet<RawClerkMembershipList>(
      ctx,
      `${FAPI_BASE}/v1/organizations/${orgId}/memberships` +
        `?__clerk_api_version=${CLERK_API_VERSION}&_clerk_js_version=${CLERK_JS_VERSION}` +
        `&_clerk_session_id=${sessionId}&paginated=true&limit=100&offset=0`
    )) ?? {}
  )
}

// --- descriptor ---

export const novuPlugin = definePlugin({
  reportingCurrency: 'USD',
  meta: {
    id: 'novu',
    name: 'Novu',
    vendor: 'Novu',
    category: 'devtools',
    color: '#0f62fe',
    description:
      'Novu Cloud billing (plan + Stripe invoices), workflow-run usage with delivery analytics, and org members — from your own dashboard session.',
    homepage: 'https://novu.co',
    dashboardUrl: 'https://dashboard.novu.co'
  },
  // Magic Login captures the Clerk __client cookie on .clerk.dashboard.novu.co (the durable credential the
  // minted-jwt resolve() exchanges for a fresh Bearer per fetch).
  session: {
    // Open on the Clerk sign-in page (redirecting to billing once authed), NOT a protected page: Clerk sets
    // __client (the requiredCookie) before sign-in, so opening directly on /settings/billing read as ready
    // and captured a pre-MFA session before the security-key step completed.
    loginUrl:
      'https://dashboard.novu.co/auth/sign-in?redirect_url=https%3A%2F%2Fdashboard.novu.co%2Fsettings%2Fbilling',
    // Authed-only paths. NOT '/dashboard' — that substring matches the dashboard.novu.co HOST (`//dashboard`),
    // so it marked every page (incl. sign-in) ready and fired capture before login finished.
    dashboardMarkers: ['/settings/billing', '/settings/team', '/workflows', '/activity'],
    cookieDomains: ['novu.co', 'clerk.dashboard.novu.co'],
    requiredCookie: '__client'
  },
  auth: { kind: 'minted-jwt', resolve: resolveNovuJwt },
  // Plain node (axios). api.novu.co is Cloudflare-fronted but only needs an Origin header (axios sets it) —
  // doesn't need the browser engine, so no electron transport. node injects the canonical UA + sec-ch-ua centrally.
  transport: {
    baseUrl: NOVU_API_BASE,
    defaultHeaders: {
      Accept: '*/*',
      'Sec-Fetch-Site': 'same-site',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty'
    }
  },
  capabilities: [
    defineCapability({
      id: 'summary',
      label: 'Summary',
      fetch: fetchNovuBilling,
      build: (raw) => buildNovuSummaryResult(buildNovuBilling(raw.invoices, raw.sub)),
      sample: sampleNovuBilling
    }),
    defineCapability({
      id: 'billing',
      label: 'Billing',
      fetch: fetchNovuBilling,
      build: (raw) => buildNovuBillingTab(buildNovuBilling(raw.invoices, raw.sub)),
      sample: sampleNovuBilling
    }),
    defineCapability({
      id: 'usage',
      label: 'Usage',
      fetch: fetchNovuUsage,
      build: (raw) => buildNovuUsageResult(raw.sub, raw.charts),
      sample: sampleNovuUsage
    }),
    defineCapability({
      id: 'members',
      label: 'Members',
      fetch: fetchNovuMembers,
      build: (raw) => members.result(buildNovuMembers(raw)),
      sample: sampleNovuMemberships
    })
  ],
  probe: async (ctx) => {
    // One subscription GET proves the minted Clerk Bearer reaches api.novu.co.
    await ctx.client.get<RawNovuSubscription>(`${NOVU_API_BASE}/v1/billing/subscription`, { Referer: BILLING_PAGE_URL })
  }
})
