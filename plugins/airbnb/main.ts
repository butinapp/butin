import { type CollectContext, defineCapability, definePlugin } from '@butinapp/sdk'
import { capabilityResult, type CapabilityResult, record, table } from '@butinapp/sdk/data'
import { isoDay, round2 } from '@butinapp/sdk/util'

import { sampleAirbnbSummary, sampleAirbnbTaxDocuments, sampleAirbnbTransactions } from './sample.js'

// No icon to ship — Butin renders a brand-colored letter monogram from meta.name + meta.color.

// ── constants ───────────────────────────────────────────────────────────────────────
const BASE = 'https://www.airbnb.ca'
const REPORTING_CURRENCY = 'CAD'
// Airbnb's public web API key — a static key shipped to every browser; the real auth is the session cookie.
const API_KEY = 'd306zoyjsyarp7ifhu67rjxn52tv0t20'

// Persisted GraphQL operations: Airbnb's web API is GET /api/v3/<Op>/<sha256>, the query referenced by its
// hash. The hashes are pinned to the deployed web schema and rotate on a major release — refresh them from a
// fresh capture if a fetch starts 404ing. Each entry is [operationName, sha256Hash].
const OPS = {
  hostStats: ['FetchHostTransactionStats', '077a779779bb6e20b3896f4233496a0dce7376b07e9a041da18d513ab57214d4'],
  earningsGraph: [
    'FetchEarningsComparisonGraphQuery',
    'a02b0cd6356342c166e6e03d8658842929da2d7e95e0db0a2f55398ccfde2c04'
  ],
  productTransactions: ['FetchProductTransactions', 'f51f8017882418392880c0ad4ffff57b64fdf855c47d7cc7df5af4769ded839d'],
  taxDocuments: ['TaxesTaxDocumentsTabQuery', '285302c3bb1d9ea6242910d9726a460b9e52e4942dc7ba728fe930ce787c1205']
} as const

// A reservation payout history page holds 50; cap the walk so a long-running host doesn't pull thousands.
const TRANSACTIONS_PAGE = 50
const TRANSACTIONS_MAX = 200

// ── types ─────────────────────────────────────────────────────────────────────────
// Money arrives as a string of MICROS (millionths of a unit): "1310000000" = 1310.00. The matching currency
// is on the same object; everything in the .ca surface is CAD, the plugin's reportingCurrency.
export interface RawCurrencyAmount {
  amountMicros?: string | null
  currency?: string | null
}

// Summary — host transaction stats (a YTD breakdown) + the monthly earnings series.
export interface RawHostTransactionStats {
  reconciledGrossEarningsTotal?: RawCurrencyAmount[] | null
  reconciledServiceFeesTotal?: RawCurrencyAmount[] | null
  reconciledOccupancyTaxesTotal?: RawCurrencyAmount[] | null
  payoutTransactionsTotal?: RawCurrencyAmount[] | null
  futureTransactionsTotal?: RawCurrencyAmount[] | null
}

export interface RawEarningsMonth {
  startDate?: string | null
  completedTotal?: number | null // already in major units
  upcomingTotal?: number | null
}

export interface RawAirbnbSummary {
  stats: RawHostTransactionStats | null
  months: RawEarningsMonth[]
}

interface HostStatsResponse {
  payout_transaction_history?: {
    fetchHostTransactionStats?: { hostTransactionStats?: RawHostTransactionStats[] | null } | null
  } | null
}
interface EarningsGraphResponse {
  payout_transaction_history?: { fetchEarningsGraph?: { multiChartData?: RawEarningsMonth[][] | null } | null } | null
}

interface AirbnbMonthPoint {
  month: string
  earned: number
}
interface AirbnbSummaryStats {
  gross: number
  payouts: number
  upcoming: number
  serviceFees: number
  occupancyTaxes: number
}

// Transactions — per-reservation payout rows.
export interface RawProductTransaction {
  token?: string | null
  allocationToken?: string | null
  startDate?: string | null
  nights?: number | null
  guestNames?: string[] | null
  hostingName?: string | null
  productConfirmationCode?: string | null
  currencyAmount?: { nativeCurrencyAmountFormatted?: RawCurrencyAmount | null } | null
  transactionStatus?: { localizedStatus?: string | null; status?: string | null } | null
}

interface ProductTransactionsResponse {
  payout_transaction_history?: {
    fetchProductTransactions?: {
      productTransactions?: RawProductTransaction[] | null
      paginationToken?: string | null
    } | null
  } | null
}

interface AirbnbTransactionRow {
  date: string | null
  guest: string
  listing: string | null
  nights: number
  amount: number
  status: string
  confirmation: string | null
  token: string
}

// Tax documents — the host's own annual income summaries (metadata only; the web surface exposes no direct
// download URL, so this is an informational list, not a downloadable table).
export interface RawTaxDocument {
  metadata?: { title?: string | null; taxYear?: number | null; regulatoryAuthority?: string | null } | null
}
interface TaxDocsResponse {
  viewer?: {
    user?: { taxDocuments?: { taxDocumentListV3?: { items?: RawTaxDocument[] | null } | null } | null } | null
  } | null
}
interface AirbnbTaxDocRow {
  year: string | null
  title: string
  authority: string | null
}

// ── shared helpers ──────────────────────────────────────────────────────────────────
// GET a persisted GraphQL operation and return its `data` (null on an error envelope). The query is named by
// its hash; variables + the persistedQuery extension ride the query string.
const gqlGet = async <T>(
  ctx: CollectContext,
  [op, hash]: readonly [string, string],
  variables: unknown
): Promise<T | null> => {
  const params = new URLSearchParams({
    operationName: op,
    locale: 'en-CA',
    currency: REPORTING_CURRENCY,
    variables: JSON.stringify(variables),
    extensions: JSON.stringify({ persistedQuery: { version: 1, sha256Hash: hash } })
  })
  const body = await ctx.client.get<{ data?: T }>(`${BASE}/api/v3/${op}/${hash}?${params.toString()}`)

  return body?.data ?? null
}

// The host's own user id lives in the readable `_user_attributes` cookie ({"id":…,"curr":"CAD"}); pull it from
// the captured jar so the plugin needs no manual config.
export const extractUserId = (cookie: string | undefined): string | null => {
  const match = cookie?.match(/(?:^|;\s*)_user_attributes=([^;]+)/)

  if (!match) {
    return null
  }

  try {
    const attrs = JSON.parse(decodeURIComponent(match[1])) as { id_str?: string; id?: number }

    return attrs.id_str ?? (attrs.id != null ? String(attrs.id) : null)
  } catch {
    return null
  }
}

const requireUserId = (ctx: CollectContext): string => {
  const id = extractUserId(ctx.creds.get('cookie'))

  if (!id) {
    throw new Error('Airbnb user id not found in the captured session — reconnect to refresh it')
  }

  return id
}

// Micros (string millionths) → major units, rounded to cents.
const microsToMajor = (micros?: string | null): number => {
  const n = micros ? Number(micros) : 0

  return Number.isFinite(n) ? round2(n / 1_000_000) : 0
}
const firstAmount = (amounts?: RawCurrencyAmount[] | null): number => microsToMajor(amounts?.[0]?.amountMicros)

const yearStart = (year: number): string => `${year}-01-01T00:00:00Z`
const yearEnd = (year: number): string => `${year}-12-31T23:59:59Z`

// --- summary: YTD earnings breakdown + the monthly earnings chart ---
const fetchAirbnbSummary = async (ctx: CollectContext): Promise<RawAirbnbSummary> => {
  const userId = requireUserId(ctx)
  const year = new Date().getUTCFullYear()
  const statsVars = {
    input: {
      filters: [
        {
          userInfo: { userId, forUser: null },
          airbnbProductTypeFilters: null,
          startTimestamp: yearStart(year),
          endTimestamp: yearEnd(year),
          includedAttributes: ['FOR_SUMMARY_BREAKDOWN']
        }
      ]
    }
  }
  const graphVars = {
    input: {
      userId,
      seriesFilters: [{ userIds: [userId], startTimestamp: yearStart(year), endTimestamp: yearEnd(year) }],
      earningsGraphConfig: { earningsGraphType: 'MONTH_OVER_MONTH', earningsPeriodType: 'CALENDAR_YEAR' }
    }
  }
  // The chart is secondary to the breakdown cards — if it errors, still render the stats.
  const [stats, graph] = await Promise.all([
    gqlGet<HostStatsResponse>(ctx, OPS.hostStats, statsVars),
    gqlGet<EarningsGraphResponse>(ctx, OPS.earningsGraph, graphVars).catch(() => null)
  ])

  return {
    stats: stats?.payout_transaction_history?.fetchHostTransactionStats?.hostTransactionStats?.[0] ?? null,
    months: graph?.payout_transaction_history?.fetchEarningsGraph?.multiChartData?.[0] ?? []
  }
}

// Pure transform — fixture-tested.
export const buildAirbnbSummary = (raw: RawAirbnbSummary): CapabilityResult => {
  const s = raw.stats
  const months = raw.months
    .map((m) => ({ month: isoDay(m.startDate) ?? '', earned: round2(m.completedTotal ?? 0) }))
    .filter((m) => m.month !== '')
  const ytd = round2(months.reduce((sum, m) => sum + m.earned, 0))

  const monthly = table<AirbnbMonthPoint>({
    id: 'monthly',
    columns: [
      { key: 'month', label: 'Month', role: 'timestamp' },
      { key: 'earned', label: 'Earned', role: 'money' }
    ],
    rows: months
  })

  const stats = record<AirbnbSummaryStats>({
    id: 'stats',
    fields: [
      { key: 'gross', label: 'Gross earnings (YTD)', role: 'money' },
      { key: 'payouts', label: 'Net payouts (YTD)', role: 'money' },
      { key: 'upcoming', label: 'Upcoming', role: 'money' },
      { key: 'serviceFees', label: 'Service fees', role: 'money' },
      { key: 'occupancyTaxes', label: 'Occupancy taxes collected', role: 'money' }
    ],
    value: {
      gross: firstAmount(s?.reconciledGrossEarningsTotal),
      payouts: firstAmount(s?.payoutTransactionsTotal),
      upcoming: firstAmount(s?.futureTransactionsTotal),
      serviceFees: firstAmount(s?.reconciledServiceFeesTotal),
      occupancyTaxes: firstAmount(s?.reconciledOccupancyTaxesTotal)
    }
  })

  return capabilityResult({
    sections: [
      stats.stat({}),
      monthly.timeseries({ x: 'month', y: 'earned', granularity: 'monthly', title: 'Monthly earnings' })
    ],
    summaries: [
      monthly.summary({ section: 'other', label: 'Earnings (YTD)', value: ytd, role: 'money', x: 'month', y: 'earned' })
    ]
  })
}

// --- transactions: per-reservation payout history (upcoming + paid) ---
const TRANSACTION_ATTRIBUTES = [
  'LOCALIZED_PRODUCT_DETAILS',
  'LOCALIZED_PRODUCT_DESCRIPTIONS',
  'GUEST_NAMES',
  'ATTACHED_RESERVATION_DETAILS',
  'TRANSACTION_STATUS'
]

const fetchProductTransactionPage = async (
  ctx: CollectContext,
  userId: string,
  reconciled: boolean,
  token: string | null
) => {
  const vars = {
    input: {
      metaOptions: { limit: String(TRANSACTIONS_PAGE), paginationToken: token },
      productTransactionAttributes: TRANSACTION_ATTRIBUTES,
      productTransactionFilters: { userIds: [userId], reconciled, searchText: '', forUser: null }
    }
  }
  const data = await gqlGet<ProductTransactionsResponse>(ctx, OPS.productTransactions, vars)

  return data?.payout_transaction_history?.fetchProductTransactions ?? null
}

export const fetchAirbnbTransactions = async (
  ctx: CollectContext
): Promise<(RawProductTransaction & { id: string })[]> => {
  const userId = requireUserId(ctx)
  const all: (RawProductTransaction & { id: string })[] = []

  // reconciled:false = upcoming (scheduled) payouts, reconciled:true = the paid history — same endpoint. Upcoming
  // rows are future-dated and few, so they're always walked in full, ignoring ctx.since; core's watermark is
  // min(newest kept, now-window), so it never clamps past the paid rows the walk below is stopping on.
  for (const reconciled of [false, true]) {
    let token: string | null = null

    while (all.length < TRANSACTIONS_MAX) {
      const page = await fetchProductTransactionPage(ctx, userId, reconciled, token)
      const rows = page?.productTransactions ?? []

      all.push(...rows.map((r) => ({ ...r, id: r.token ?? r.allocationToken ?? '' })))
      token = page?.paginationToken ?? null

      // Paid history only: once a whole page has aged below the watermark, older pages are already stored.
      if (reconciled && ctx.since && rows.length > 0 && rows.every((r) => (r.startDate ?? '') < ctx.since!)) {
        break
      }

      if (rows.length < TRANSACTIONS_PAGE || !token) {
        break
      }
    }
  }

  return all
}

// Pure transform — fixture-tested. Keyed by the allocation token so accumulation merges across fetches. The
// param type carries the synthetic `id` fetchAirbnbTransactions stamps on each row (unused here) so it matches
// the incremental raw shape the capability declares.
export const buildAirbnbTransactions = (raw: (RawProductTransaction & { id?: string })[]): CapabilityResult => {
  const rows = raw
    .map((t) => ({
      date: t.startDate ?? null,
      guest: t.guestNames?.[0] ?? '—',
      listing: t.hostingName ?? null,
      nights: t.nights ?? 0,
      amount: microsToMajor(t.currencyAmount?.nativeCurrencyAmountFormatted?.amountMicros),
      status: t.transactionStatus?.localizedStatus ?? t.transactionStatus?.status ?? '—',
      confirmation: t.productConfirmationCode ?? null,
      token: t.token ?? t.allocationToken ?? ''
    }))
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))

  const transactions = table<AirbnbTransactionRow>({
    id: 'transactions',
    columns: [
      { key: 'date', label: 'Check-in', role: 'timestamp' },
      { key: 'guest', label: 'Guest', role: 'label' },
      { key: 'listing', label: 'Listing', role: 'label' },
      { key: 'nights', label: 'Nights', role: 'count' },
      { key: 'amount', label: 'Payout', role: 'money' },
      {
        key: 'status',
        label: 'Status',
        role: 'status',
        badges: { scheduled: 'info', released: 'success', upcoming: 'info', cancelled: 'neutral' }
      },
      { key: 'confirmation', label: 'Confirmation', role: 'identifier' },
      { key: 'token', role: 'identifier', hidden: true }
    ],
    rows,
    key: 'token'
  })

  return capabilityResult({ sections: [transactions.table({ title: 'Transactions' })] })
}

// --- tax documents: the host's annual income summaries ---
const fetchAirbnbTaxDocuments = async (ctx: CollectContext): Promise<RawTaxDocument[]> => {
  const year = new Date().getUTCFullYear()
  // The four completed years before now — the same trailing set the web UI requests.
  const vars = { taxYears: [year - 1, year - 2, year - 3, year - 4], mockIdentifier: null, bulkVatEnabled: true }
  const data = await gqlGet<TaxDocsResponse>(ctx, OPS.taxDocuments, vars)

  return data?.viewer?.user?.taxDocuments?.taxDocumentListV3?.items ?? []
}

// Pure transform — fixture-tested.
export const buildAirbnbTaxDocuments = (raw: RawTaxDocument[]): CapabilityResult => {
  const rows = raw
    .map((d) => ({
      year: d.metadata?.taxYear != null ? String(d.metadata.taxYear) : null,
      title: d.metadata?.title ?? '—',
      authority: d.metadata?.regulatoryAuthority?.toUpperCase() || null
    }))
    .sort((a, b) => (b.year ?? '').localeCompare(a.year ?? ''))

  const docs = table<AirbnbTaxDocRow>({
    id: 'taxDocuments',
    columns: [
      { key: 'year', label: 'Tax year', role: 'label' },
      { key: 'title', label: 'Document', role: 'label' },
      { key: 'authority', label: 'Authority', role: 'category' }
    ],
    rows
  })

  return capabilityResult({ sections: [docs.table({ title: 'Tax documents' })] })
}

// ── descriptor ──────────────────────────────────────────────────────────────────────
export const airbnbPlugin = definePlugin({
  reportingCurrency: REPORTING_CURRENCY,
  meta: {
    id: 'airbnb',
    name: 'Airbnb',
    vendor: 'Airbnb',
    category: 'rental',
    color: '#FF5A5F',
    description: 'Airbnb hosting earnings, reservation payouts, and tax documents.',
    homepage: 'https://www.airbnb.ca',
    dashboardUrl: 'https://www.airbnb.ca/hosting'
  },
  // Open the host dashboard: Airbnb bounces to the login flow if signed out (Google/email/MFA — anything),
  // then returns to /hosting once `_aat` (the auth-token cookie) is set. `_airbed_session_id` is the transient
  // Rails session — cleared before capture so a stale one can't poison a fresh social-login OAuth state.
  session: {
    loginUrl: 'https://www.airbnb.ca/hosting',
    dashboardMarkers: ['/hosting'],
    cookieDomains: ['airbnb.ca'],
    requiredCookie: '_aat',
    clearCookiesBeforeCapture: ['_airbed_session_id']
  },
  auth: { kind: 'cookie' },
  // Airbnb's API edge is TLS/UA-sensitive and only accepts a real browser —
  // `electron` replays with the real browser's TLS identity, and core matches the UA to the capture window centrally. The
  // GraphQL calls are same-origin GETs, so no Origin/Sec-Fetch headers are needed; only the web API headers.
  transport: {
    engine: 'electron',
    defaultHeaders: {
      'X-Airbnb-API-Key': API_KEY,
      'X-Airbnb-GraphQL-Platform': 'web',
      'X-Airbnb-Supports-Airlock-V2': 'true',
      Accept: '*/*',
      Referer: `${BASE}/`
    }
  },
  capabilities: [
    defineCapability({
      id: 'summary',
      label: 'Summary',
      fetch: fetchAirbnbSummary,
      build: buildAirbnbSummary,
      sample: sampleAirbnbSummary
    }),
    defineCapability<(RawProductTransaction & { id?: string })[]>({
      id: 'transactions',
      label: 'Transactions',
      fetch: fetchAirbnbTransactions,
      build: buildAirbnbTransactions,
      sample: sampleAirbnbTransactions,
      // The paid-history walk stops at ctx.since (see fetchAirbnbTransactions); upcoming rows are future-dated
      // and always re-fetched in full regardless of the watermark.
      incremental: { id: 'id', timestamp: 'startDate', window: { days: 30 } }
    }),
    defineCapability({
      id: 'taxDocuments',
      label: 'Tax documents',
      fetch: fetchAirbnbTaxDocuments,
      build: buildAirbnbTaxDocuments,
      sample: sampleAirbnbTaxDocuments
    })
  ],
  // The tax-documents query is the cheapest authed call that needs no user id — a 200 proves the session cookie.
  probe: async (ctx) => {
    await fetchAirbnbTaxDocuments(ctx)
  }
})
