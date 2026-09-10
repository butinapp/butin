import {
  type AuthAttachment,
  defineCapability,
  defineConfigSchema,
  definePlugin,
  type AuthContext,
  type CollectContext,
  type ConfigOf
} from '@butinapp/sdk'
import { capabilityResult, table, type CapabilityResult } from '@butinapp/sdk/data'
import { DateTime } from '@butinapp/sdk/libs'
import { billing, type BillingStat } from '@butinapp/sdk/presets'
import { getReportingZone, normalizeCurrency, parseDecimalAmount, round2 } from '@butinapp/sdk/util'

import { sampleStripeFees, sampleStripeSummary } from './sample.js'

// Stripe authenticates from the dashboard session captured by Magic Login — no pasted API key, no `stripe`
// npm SDK. The dashboard's /v1 API does NOT accept the cookie directly: it wants `Authorization: Bearer
// uk_…`, a per-session "user key" the SPA mints. That key is the `json.session_api_key` of the cookie-authed
// `/ajax/preloaded`, so this is minted-jwt auth — replay the captured cookie to fetch the key, then attach it
// as the Bearer on every /v1 read. dashboard.stripe.com doesn't need the browser engine, so transport is Node axios
// mirroring the dashboard XHR's same-origin headers.
//
// WHAT THIS READS — your Stripe fees (what you pay Stripe), not the invoices you issue to your customers. A
// merchant account can hold tens of thousands of customer invoices, so summing /v1/invoices is both slow and
// the wrong figure for "what Stripe costs me". Instead this drives the dashboard's Plans & fees report:
// `all_fees.balance_transaction_created.summary.2` — an async report run that returns one line per fee type
// (card processing, Invoicing Plus, Sigma, FX, …) for a calendar-month interval. That report is the source of
// truth for spend, and it loads in a handful of requests regardless of invoice volume.
//
// The report takes an arbitrary [interval_start, interval_end) — querying [month-start, now) yields the live
// month-to-date fees, just as a full-month interval yields a complete month. So the headline is real MTD.
//
// Two capabilities:
//   summary  → this month's fees so far (MTD) as the headline + a monthly-fees chart over recent COMPLETE
//              months + a Last-month comparison card. Feeds the cross-service Overview rollup via spend.mtd.
//   fees     → this month's fees so far, broken down by product/feature (the Plans & fees table).
//
// MONEY: the report's `amount` column is a decimal string already in MAJOR units (USD) → parseDecimalAmount.

const DASHBOARD = 'https://dashboard.stripe.com'

// The Plans & fees report — one row per fee type for a balance-transaction interval, summed.
const FEES_REPORT_TYPE = 'all_fees.balance_transaction_created.summary.2'

// How many complete months the Summary monthly-fees chart spans (the most recent month is the headline).
const CHART_MONTHS = 6

// A fee report run is async: create it, then poll until its query completes. The dashboard polls ~1s apart and
// most runs finish within a few seconds; a run that overruns this budget is skipped so one slow month can't
// blank the whole chart.
const POLL_INTERVAL_MS = 800
const POLL_MAX_TRIES = 20

// The dashboard build SHA the gateway expects from the manage client. A captured constant; if Stripe ever
// rejects a stale value, refresh it from a live request.
const MANAGE_CLIENT_REVISION = 'a190d2e5ceffad3ea65fe558a8e9cebbcb49660d'

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
]

// ── types ─────────────────────────────────────────────────────────────────────────

// The async report-run object: a run owns a `reporting_query` whose `status` reaches 'completed' once results
// are ready. The run-level `status` lags (stays 'pending' after the query completes), so the query status is
// the completion signal.
type RawReportRun = {
  id?: string
  reporting_query?: { id?: string; status?: string }
}

// A Sigma results page: positional rows against a named column list. The all_fees summary columns are
// suite · product · feature_name · feature_description · amount · tax · currency.
type RawSigmaResults = {
  columns?: { name: string }[] | null
  data?: { row?: unknown[] }[] | null
}

// One normalized fee line for a period — major-unit USD.
export type StripeFee = {
  suite: string
  product: string
  feature: string
  amount: number
  currency: string
}

// One calendar month's fees: the [start, next-month-start) interval to query + the normalized result.
type MonthSpec = {
  key: string // 'YYYY-MM'
  label: string // 'May 2026'
  startSec: number
  endSec: number
}

export type StripeMonthFees = MonthSpec & {
  total: number // USD sum of the month's fee lines
  fees: StripeFee[]
}

// ── domain logic ────────────────────────────────────────────────────────────────────

// The most recent `n` COMPLETE calendar months (ascending; the last entry is the month just ended), each as
// the [month-start, next-month-start) UTC epoch-second interval the report wants.
export const recentCompleteMonths = (n: number, now = new Date()): MonthSpec[] => {
  const thisMonth = DateTime.fromJSDate(now, { zone: getReportingZone() }).startOf('month')
  const specs: MonthSpec[] = []

  for (let back = n; back >= 1; back--) {
    const start = thisMonth.minus({ months: back })
    const end = start.plus({ months: 1 })

    specs.push({
      key: start.toFormat('yyyy-MM'),
      label: `${MONTH_NAMES[start.month - 1]} ${start.year}`,
      startSec: Math.floor(start.toSeconds()),
      endSec: Math.floor(end.toSeconds())
    })
  }

  return specs
}

// The current calendar month as a [month-start, now) interval → the report returns fees accrued so far this
// month (MTD), not a full month.
export const currentMonthSpec = (now = new Date()): MonthSpec => {
  const dt = DateTime.fromJSDate(now, { zone: getReportingZone() })
  const start = dt.startOf('month')

  return {
    key: start.toFormat('yyyy-MM'),
    label: `${MONTH_NAMES[start.month - 1]} ${start.year}`,
    startSec: Math.floor(start.toSeconds()),
    endSec: Math.floor(dt.toSeconds())
  }
}

// Pure transform — fixture-tested. A Sigma results page → normalized fee lines (decimal string → USD major
// units). Columns are read by name so a reordered payload still maps correctly.
export const buildFeeRows = (results: RawSigmaResults | undefined | null): StripeFee[] => {
  const names = (results?.columns ?? []).map((c) => c.name)
  const idx = (name: string): number => names.indexOf(name)
  const at = (row: unknown[], name: string): string => {
    const i = idx(name)

    return i >= 0 ? String(row[i] ?? '') : ''
  }

  return (results?.data ?? [])
    .map((r) => r.row ?? [])
    .map((row) => ({
      suite: at(row, 'suite'),
      product: at(row, 'product'),
      feature: at(row, 'feature_name'),
      amount: round2(parseDecimalAmount(at(row, 'amount'))),
      currency: normalizeCurrency(at(row, 'currency'))
    }))
}

// --- Summary tab (its spend.mtd summary is what the cross-service Overview rolls up) ---
// The headline is this month's fees so far (MTD, an accruing figure); the chart is the monthly total over the
// recent COMPLETE months (the current partial month is deliberately not a chart bar — it would read as a dip).
// The complete-month series feeds the shared billing.summary preset as one synthetic invoice per month
// for the Overview spark. A neutral Last-month card carries the comparison (no tinted MTD-vs-full-month delta,
// which reads misleadingly green early in the month — hence showDelta: false).
export const buildStripeFeesSummaryResult = (
  completeMonths: StripeMonthFees[],
  current: StripeMonthFees | undefined
): CapabilityResult => {
  const lastComplete = completeMonths.at(-1)
  const invoices = completeMonths.map((mo) => ({ id: mo.key, date: `${mo.key}-01`, status: 'paid', amount: mo.total }))
  const top = [...(current?.fees ?? [])].sort((a, b) => b.amount - a.amount)[0]
  const stats: BillingStat[] = []

  if (lastComplete) {
    stats.push({
      key: 'lastMonth',
      label: 'Last month',
      role: 'money',
      value: lastComplete.total,
      caption: lastComplete.label
    })
  }

  if (top) {
    stats.push({
      key: 'topFee',
      label: 'Largest fee',
      role: 'money',
      value: top.amount,
      caption: top.feature
    })
  }

  return billing.summary({
    currentMtd: current?.total ?? 0,
    currentMtdLabel: 'This month',
    currentMtdCaption: current ? `${current.label} · so far` : undefined,
    mtdBasis: 'accrued',
    showDelta: false,
    invoices,
    monthlyTitle: 'Monthly fees',
    stats
  })
}

// --- Fees tab (the Plans & fees breakdown; NOT the Overview rollup) ---
// A month's fee lines as a table, largest first — what the dashboard's Plans & fees page shows.

type FeeTableRow = {
  suite: string
  product: string
  feature: string
  amount: number
}

export const buildStripeFeesBreakdownResult = (month: StripeMonthFees | undefined): CapabilityResult => {
  const rows: FeeTableRow[] = [...(month?.fees ?? [])]
    .sort((a, b) => b.amount - a.amount)
    .map((f) => ({ suite: f.suite, product: f.product, feature: f.feature, amount: f.amount }))

  const fees = table<FeeTableRow>({
    id: 'fees',
    columns: [
      { key: 'feature', label: 'Fee', role: 'label' },
      { key: 'product', label: 'Product', role: 'label' },
      { key: 'suite', label: 'Category', role: 'label' },
      { key: 'amount', label: 'Amount', role: 'money' }
    ],
    rows
  })

  return capabilityResult({ sections: [fees.table({ title: month ? `Fees — ${month.label}` : 'Fees' })] })
}

// --- fetch (cookie-authed; the dashboard session is replayed centrally) ---

// The dashboard's internal /v1 API also requires the request markers that identify it as the manage
// dashboard's own XHR, or its gateway falls through to public-API mode. The full set, mirrored from a live
// dashboard request:
//   Stripe-Account   — the account scope.
//   x-request-source — declares the manage-srv client + the operation (telemetry the gateway tolerates).
//   x-stripe-manage-client-revision — the dashboard build SHA the gateway expects from the manage client.
//   x-stripe-csrf-token — a fixed, deprecated placeholder (the real CSRF is the Fetch-Metadata + cookie).
//   x-requested-with — the custom-header CSRF marker. Stripe-Version pins the response shape; Stripe-Livemode
//                      selects live (vs test) data.
const manageHeaders = (accountId: string, operation: string): Record<string, string> => ({
  'Stripe-Account': accountId,
  'Stripe-Version': '2025-06-30.basil',
  'Stripe-Livemode': 'true',
  'x-stripe-csrf-token': 'fake-deprecated-token',
  'x-requested-with': 'XMLHttpRequest',
  'x-request-source': `service="manage-srv"; project="billing_analytics"; operation="${operation}"`,
  'x-stripe-manage-client-revision': MANAGE_CLIENT_REVISION
})

// The account id rides the dashboard URL (auto-captured into config at sign-in) and scopes every read.
const accountIdOf = (ctx: CollectContext<StripeConfig>): string => {
  const id = ctx.config.accountId?.trim()

  if (!id) {
    throw new Error('Stripe: the account id (acct_…) is captured at sign-in — reconnect, or set it in Settings.')
  }

  return id
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// `/ajax/preloaded` is the cookie-authed dashboard endpoint that hands the SPA its session key — the response
// is `{ id, json: { session_api_key: 'uk_…', … } }`.
type StripePreloaded = {
  json?: { session_api_key?: string }
}

// Mint the per-session `uk_` key (minted-jwt). The dashboard's /v1 API authenticates with `Authorization:
// Bearer uk_…`, NOT the cookie — the cookie only authenticates `/ajax/preloaded`, which returns the key.
// `client` already carries the captured cookie + same-origin headers; add the XHR marker + account scope the
// dashboard sends. Memoized per run, re-minted on a cleared 401.
const resolveStripeKey = async ({ client, config }: AuthContext): Promise<AuthAttachment> => {
  const accountId = (config.accountId as string | undefined)?.trim()
  const preloaded = await client.get<StripePreloaded>(`${DASHBOARD}/ajax/preloaded`, {
    'x-requested-with': 'XMLHttpRequest',
    ...(accountId ? { 'Stripe-Account': accountId } : {})
  })
  const key = preloaded.json?.session_api_key

  if (!key) {
    throw new Error('Stripe: no session_api_key from /ajax/preloaded — the dashboard session is incomplete; reconnect.')
  }

  return { headers: { Authorization: `Bearer ${key}` } }
}

// Run the all_fees report for one month: create the run, poll its query to completion, then read the Sigma
// results. The create POST is deduped by the query cache (identical body across both tabs → one run), but each
// poll opts OUT of the cache (`cache: false`) — a cached 'pending' snapshot pinned for the TTL would never let
// the loop observe completion. A run that doesn't complete in the budget yields no fees rather than throwing.
const runFeesReport = async (
  ctx: CollectContext<StripeConfig>,
  startSec: number,
  endSec: number
): Promise<StripeFee[]> => {
  const accountId = accountIdOf(ctx)
  const body = `parameters[interval_start]=${startSec}&parameters[interval_end]=${endSec}&report_type=${FEES_REPORT_TYPE}`
  const run = await ctx.client.post<RawReportRun>(`${DASHBOARD}/v1/reporting/report_runs`, body, {
    ...manageHeaders(accountId, 'CreateFinanceReportRunWrapperV2Mutation'),
    'Content-Type': 'application/x-www-form-urlencoded'
  })

  const runId = run.id
  let queryId = run.reporting_query?.id
  let completed = run.reporting_query?.status === 'completed'

  if (!runId) {
    throw new Error('Stripe: the fee report run returned no id.')
  }

  for (let tries = 0; tries < POLL_MAX_TRIES && !completed; tries++) {
    await delay(POLL_INTERVAL_MS)

    const poll = await ctx.client.request<RawReportRun>({
      url: `${DASHBOARD}/v1/reporting/report_runs/${runId}`,
      headers: manageHeaders(accountId, 'FinanceReportRunQuery'),
      cache: false
    })

    queryId = poll.data.reporting_query?.id ?? queryId
    completed = poll.data.reporting_query?.status === 'completed'
  }

  if (!completed || !queryId) {
    return []
  }

  const results = await ctx.client.get<RawSigmaResults>(
    `${DASHBOARD}/v1/sigma/queries/${queryId}/results?limit=10000&offset=0`,
    manageHeaders(accountId, 'FinanceReportResultsQuery')
  )

  return buildFeeRows(results)
}

const loadMonthFees = async (ctx: CollectContext<StripeConfig>, spec: MonthSpec): Promise<StripeMonthFees> => {
  const fees = await runFeesReport(ctx, spec.startSec, spec.endSec)

  return { ...spec, fees, total: round2(fees.reduce((sum, f) => sum + f.amount, 0)) }
}

// The Summary tab's raw bundle: the recent COMPLETE months (for the chart) + the current month-to-date.
export type StripeFeesSummaryRaw = {
  completeMonths: StripeMonthFees[]
  current: StripeMonthFees
}

const fetchStripeSummary = async (ctx: CollectContext<StripeConfig>): Promise<StripeFeesSummaryRaw> => {
  const [completeMonths, current] = await Promise.all([
    Promise.all(recentCompleteMonths(CHART_MONTHS).map((spec) => loadMonthFees(ctx, spec))),
    loadMonthFees(ctx, currentMonthSpec())
  ])

  return { completeMonths, current }
}

const fetchStripeFees = (ctx: CollectContext<StripeConfig>): Promise<StripeMonthFees> =>
  loadMonthFees(ctx, currentMonthSpec())

// ── config ────────────────────────────────────────────────────────────────────────

// Typed settings: an optional account id, for the case the dashboard session spans multiple accounts and a
// read must target a specific one. Auth is the captured dashboard cookie, not a config value.
export const stripeConfigSchema = defineConfigSchema([
  {
    key: 'accountId',
    label: 'Account ID',
    kind: 'text',
    placeholder: 'acct_…',
    help: 'Optional — only if your dashboard session spans multiple accounts and reads must target a specific one.'
  }
])

export type StripeConfig = ConfigOf<typeof stripeConfigSchema>

// ── descriptor ──────────────────────────────────────────────────────────────────────

export const stripePlugin = definePlugin({
  reportingCurrency: 'USD',
  meta: {
    id: 'stripe',
    name: 'Stripe',
    vendor: 'Stripe',
    category: 'devtools',
    description: 'Stripe fees and monthly spend from the dashboard Plans & fees report.',
    color: '#635BFF',
    homepage: 'https://stripe.com',
    dashboardUrl: 'https://dashboard.stripe.com'
  },
  // minted-jwt → Magic Login captures the dashboard.stripe.com cookie; resolveStripeKey exchanges it for the
  // per-session `uk_` key (via /ajax/preloaded) that the /v1 API authenticates with as a Bearer. A 401 means
  // the cookie session is dead → clear it (default clearOnStatuses) so the UI re-prompts Magic Login.
  auth: { kind: 'minted-jwt', resolve: resolveStripeKey },
  // dashboard.stripe.com doesn't need the browser engine → node transport. The dashboard's edge accepts the
  // session cookie only on a request that looks like its own same-origin XHR: the Sec-Fetch-Site:same-origin
  // trio + Referer, and NO Origin header (a browser omits Origin on a same-origin GET; sending one makes the
  // edge treat the call as cross-origin and demand a Bearer key). The Stripe-* / CSRF markers are per-request.
  // nativeBrowserHeaders: the capture window must NOT rewrite request headers — Stripe's CSRF gate enforces
  // Fetch-Metadata, and the central header rewrite's `callback({ requestHeaders })` drops the native Sec-Fetch-* /
  // X-Requested-With during sign-in, corrupting the session that gets captured.
  transport: {
    engine: 'node',
    baseUrl: DASHBOARD,
    nativeBrowserHeaders: true,
    defaultHeaders: {
      Accept: 'application/json',
      Referer: `${DASHBOARD}/`,
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty'
    }
  },
  session: {
    loginUrl: 'https://dashboard.stripe.com/login',
    // The authed dashboard lands on the account home `dashboard.stripe.com/acct_<id>` (and the SSO handoff
    // ends at `/sessions/handoff_complete`). NOT `/dashboard` — that substring also matches the login host
    // `dashboard.stripe.com/login`, so it would read "ready" before sign-in.
    dashboardMarkers: ['/acct_', '/sessions/handoff_complete'],
    // Scope to the host we query, NOT the `stripe.com` suffix. The auth cookies are `__Host-` prefixed, which
    // are host-locked: every Stripe subdomain (docs./marketplace./access./…) sets its OWN `__Host-session` +
    // `__Host-auth_token` with a different value. A broad `stripe.com` match flattens all of them into the
    // replayed Cookie header — many conflicting `__Host-session` values — and Stripe can't resolve a valid
    // session, so it 401s as unauthenticated. Capturing only dashboard.stripe.com sends the one a browser
    // would (the apex `.stripe.com` analytics cookies aren't needed for auth).
    cookieDomains: ['dashboard.stripe.com'],
    // The cross-domain SSO handoff (a token bounced through docs./marketplace./apex stripe.com) is blocked
    // by Chromium with ERR_BLOCKED_BY_RESPONSE in the capture window — that's HARMLESS (it only syncs the
    // session to ancillary domains we don't read). Do NOT relax the cross-origin response headers to silence
    // it: that half-runs the handoff and corrupts the dashboard session's CSRF state.
    // The account id sits in the dashboard URL (dashboard.stripe.com/acct_<id>) — capture it for the
    // account-scoped reads.
    captureFromUrl: [{ pattern: '/(acct_[A-Za-z0-9]+)', storeAs: 'accountId' }],
    // No requiredCookie named yet (the dashboard session cookie isn't identified) — wait for an explicit
    // Capture so a partial jar isn't grabbed the instant a marker matches. Pin the requiredCookie once known.
    manualCaptureOnly: true
  },
  config: stripeConfigSchema,
  capabilities: [
    defineCapability({
      id: 'summary',
      label: 'Summary',
      fetch: fetchStripeSummary,
      build: (raw) => buildStripeFeesSummaryResult(raw.completeMonths, raw.current),
      sample: sampleStripeSummary
    }),
    defineCapability({
      id: 'fees',
      label: 'Fees',
      fetch: fetchStripeFees,
      build: (month) => buildStripeFeesBreakdownResult(month),
      sample: sampleStripeFees
    })
  ],
  // Cheap authed probe: one small page of invoices proves the dashboard cookie + account scope + minted key are live.
  probe: async (ctx: CollectContext<StripeConfig>) => {
    await ctx.client.get(`${DASHBOARD}/v1/invoices?limit=1`, manageHeaders(accountIdOf(ctx), 'InvoicesQuery'))
  }
})
