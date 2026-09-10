import {
  defineCapability,
  defineConfigSchema,
  definePlugin,
  type AuthAttachment,
  type AuthContext,
  type CollectContext,
  type ConfigOf
} from '@butinapp/sdk'
import { addSections, table, type CapabilityResult } from '@butinapp/sdk/data'
import {
  billing,
  members,
  usage,
  type BillingInvoiceInput,
  type MemberInput,
  type MembersInput,
  type UsageMetricInput
} from '@butinapp/sdk/presets'
import { byDayAsc, byDayDesc, epochMsDay, fullName, isoDay, normalizeCurrency, round2 } from '@butinapp/sdk/util'

import { sampleHubspotBilling, sampleHubspotMembers, sampleHubspotUsage } from './sample.js'

// HubSpot Account & Billing: cookie-csrf auth over Node TLS. Reads the dashboard-internal
// account-and-billing API (`app.hubspot.com/api/{transactions-experience,subscription-experience,…}` — the
// JSON the Billing/Usage SPA calls), not HubSpot's public CRM API (that's a Private App token, a different
// surface). The session is the httpOnly `hubspotapi` cookie; every billing XHR additionally double-submits
// the `hubspotapi-csrf` cookie value as the `x-hubspot-csrf-hubspotapi` header (parsed in resolve() below).
//
// Transport: app.hubspot.com is Cloudflare-fronted, but the XHRs are same-origin — they send `Origin` +
// `Sec-Fetch-*`, both forbidden on Electron net.request — so this stays on plain Node axios (the JSON is
// served dynamically, so the edge accepts a plain client). Money is in dollars already (10230.760000), no cents
// conversion; amounts are only rounded to cents to shed trailing-zero float noise. Usage values are plain
// counts.
const HUBSPOT_ORIGIN = 'https://app.hubspot.com'

// ── auth: cookie-csrf double-submit ───────────────────────────────────────────────────
// The session cookie is replayed verbatim; the CSRF header is the `hubspotapi-csrf` cookie value echoed
// back. Pull it out of the stored cookie string and return BOTH (supplying resolve() overrides core's
// default cookie attachment, so we re-attach the cookie ourselves alongside the header).

// Parse the `hubspotapi-csrf` cookie value out of a cookie string — HubSpot double-submits it as the
// `x-hubspot-csrf-hubspotapi` header. Missing → undefined (the header is then omitted).
export const extractHubspotCsrf = (cookie: string | undefined): string | undefined => {
  const match = cookie?.match(/(?:^|;\s*)hubspotapi-csrf=([^;]+)/)

  return match?.[1]
}

export const resolveHubspotAuth = async (ctx: AuthContext): Promise<AuthAttachment> => {
  const cookie = ctx.creds.get('cookie') ?? ''
  const csrf = extractHubspotCsrf(cookie)

  return { cookie, headers: csrf ? { 'x-hubspot-csrf-hubspotapi': csrf } : {} }
}

// The portal (hub) id — stable per account, sent as a `portalId` query param on every billing endpoint and
// embedded in the seat-info path. Auto-captured from the settled dashboard URL at Magic Login (creds),
// overridable via the optional config field.
const portalOf = (ctx: AuthContext | CollectContext): string => {
  const id = (ctx.config.portalId as string | undefined)?.trim() || ctx.creds.get('portalId')

  if (!id) {
    throw new Error('No HubSpot portal (hub) id — re-run Magic Login, or set it in Settings.')
  }

  return id
}

// ── types: raw wire shapes (only the fields we use) ───────────────────────────────────

export interface RawHubspotTransaction {
  type?: string
  issued?: string
  issuedTimestamp?: number
  pdfUrl?: string
  status?: string
  products?: string[]
  invoiceAmount?: number // dollars
  balanceDue?: number
  dueDate?: string
  currencyCode?: string
  id?: string
}

export interface RawHubspotTransactionsResponse {
  transactions?: RawHubspotTransaction[]
}

export interface RawUpcomingPayment {
  issueDate?: number[] // [year, month, day]
  billingPeriodStart?: number[]
  billingPeriodEnd?: number[]
  amount?: number // dollars
  currencyCode?: string
  paymentMethodType?: string
  isProcessing?: boolean
}

export interface RawUpcomingPaymentsResponse {
  upcomingPayments?: RawUpcomingPayment[]
}

export interface RawHubspotPaymentMethod {
  paymentMethodType?: string
  lastFour?: string
  creditCardVariant?: string
  cardHolderName?: string
  creditCardExpirationMonth?: number
  creditCardExpirationYear?: number
  expired?: boolean
}

export interface RawHubspotPaymentMethodsResponse {
  paymentMethods?: RawHubspotPaymentMethod[]
}

export interface RawPaidProduct {
  name?: string
  type?: string
  productTier?: string
  quantity?: number
  limits?: RawProductLimit[]
  quantityPacks?: RawPaidProduct[]
}

export interface RawPaidProductsResponse {
  subscriptionId?: number
  paidProducts?: RawPaidProduct[]
}

export interface RawDelinquency {
  customerDelinquencyStatus?: boolean
  customerDelinquentInvoiceIds?: Array<string | number>
}

interface RawProductLimit {
  name?: string
  limit?: number
  used?: number
}

export interface RawSeatInfo {
  maxAssignableSeats?: number
  currentAssignedSeats?: number
  seatName?: string
}

interface RawMarketableCount {
  date?: string
  marketableContactsCount?: number
  marketableContactsLimit?: number
}

export interface RawMarketableContactsResponse {
  contactsTier?: number
  latestCountForBilling?: RawMarketableCount
  realTimeCount?: RawMarketableCount
  usageByResolution?: { resolution?: string; usage?: RawMarketableCount[] }
}

export interface RawCreditsResponse {
  type?: string
  data?: {
    startDate?: string
    endDate?: string
    creditsUsed?: number
    totalCredits?: number
    grantedCredits?: number
    overages?: number
    percentageOfTotalCreditsUsed?: number
  }
}

// ── billing ───────────────────────────────────────────────────────────────────────────
// invoice history (date · amount · status) → the monthly-spend chart + currentMtd headline, plus product
// summary, payment method, upcoming payment, and a delinquency flag as extra stats.

// `issued` ISO string wins; else the epoch-ms `issuedTimestamp` → 'YYYY-MM-DD'; else undefined.
const txDate = (tx: RawHubspotTransaction): string | undefined => {
  if (tx.issued) {
    return isoDay(tx.issued)
  }

  return epochMsDay(tx.issuedTimestamp)
}

// [year, month, day] → 'YYYY-MM-DD' (HubSpot uses 1-based months).
const ymdToDate = (ymd?: number[]): string | undefined => {
  if (!ymd || ymd.length < 3) {
    return undefined
  }

  const [y, m, d] = ymd

  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

export interface HubspotProductSummary {
  name: string
  tier?: string
  quantity: number
}

export interface HubspotUpcomingPayment {
  amount: number
  date?: string
  periodStart?: string
  periodEnd?: string
}

export interface HubspotPaymentMethod {
  brand?: string
  last4?: string
  expMonth?: number
  expYear?: number
}

export interface HubspotBilling {
  invoices: BillingInvoiceInput[]
  currentMtd: number // current-calendar-month invoiced spend, dollars
  totalBilled: number
  currency: string
  products: HubspotProductSummary[]
  upcomingPayment: HubspotUpcomingPayment | null
  paymentMethod: HubspotPaymentMethod | null
  delinquent: boolean
}

// Normalizes invoices to the SDK BillingInvoiceInput shape (dollars), newest-first; derives
// MTD/total/products/payment-method/upcoming/delinquency.
export const buildHubspotBilling = (
  invoiceList: RawHubspotTransactionsResponse | null | undefined,
  upcoming: RawUpcomingPaymentsResponse | null | undefined,
  paymentMethods: RawHubspotPaymentMethodsResponse | null | undefined,
  paidProducts: RawPaidProductsResponse[] | null | undefined,
  delinquency: RawDelinquency | null | undefined
): HubspotBilling => {
  const invoices: BillingInvoiceInput[] = (invoiceList?.transactions ?? [])
    .map((tx) => ({
      date: txDate(tx),
      amount: round2(tx.invoiceAmount ?? 0),
      status: (tx.status ?? 'unknown').toLowerCase(),
      pdfUrl: tx.pdfUrl || null
    }))
    .sort(byDayDesc)

  const currency = normalizeCurrency(invoiceList?.transactions?.[0]?.currencyCode)
  const currentMtd = billing.invoicedMtd(invoices)

  const up = upcoming?.upcomingPayments?.[0]
  const upcomingPayment: HubspotUpcomingPayment | null = up
    ? {
        amount: round2(up.amount ?? 0),
        date: ymdToDate(up.issueDate),
        periodStart: ymdToDate(up.billingPeriodStart),
        periodEnd: ymdToDate(up.billingPeriodEnd)
      }
    : null

  const pm = paymentMethods?.paymentMethods?.[0]
  const paymentMethod: HubspotPaymentMethod | null = pm
    ? {
        brand: pm.creditCardVariant || undefined,
        last4: pm.lastFour || undefined,
        expMonth: pm.creditCardExpirationMonth,
        expYear: pm.creditCardExpirationYear
      }
    : null

  // paid-products comes back as one entry per subscription; flatten the products.
  const products: HubspotProductSummary[] = (paidProducts ?? [])
    .flatMap((s) => s.paidProducts ?? [])
    .map((p) => ({ name: p.name ?? 'Unknown product', tier: p.productTier || undefined, quantity: p.quantity ?? 0 }))

  return {
    invoices,
    currentMtd,
    totalBilled: round2(invoices.reduce((sum, i) => sum + i.amount, 0)),
    currency,
    products,
    upcomingPayment,
    paymentMethod,
    delinquent: delinquency?.customerDelinquencyStatus ?? false
  }
}

// Compose the Summary result (its spend.mtd is what the cross-service Overview rolls up): currentMtd headline + monthly-spend chart + extra stats (products, total billed, next charge, delinquency).
// billing.summary emits the spend.mtd summary whenever currentMtd is a number.
export const buildHubspotBillingResult = (
  invoiceList: RawHubspotTransactionsResponse | null | undefined,
  upcoming: RawUpcomingPaymentsResponse | null | undefined,
  paymentMethods: RawHubspotPaymentMethodsResponse | null | undefined,
  paidProducts: RawPaidProductsResponse[] | null | undefined,
  delinquency: RawDelinquency | null | undefined
): CapabilityResult => {
  const b = buildHubspotBilling(invoiceList, upcoming, paymentMethods, paidProducts, delinquency)

  return billing.summary({
    currentMtd: b.currentMtd,
    currency: b.currency,
    // currentMtd is this calendar month's invoiced spend (basis 'invoiced'). The paid-products feed carries no
    // per-product price, so no recurring baseFee can be split out — the next-charge stat stands in for it.
    mtdBasis: 'invoiced',
    invoices: b.invoices,
    stats: [
      { key: 'totalBilled', label: 'Total billed', role: 'money', value: b.totalBilled, currency: b.currency },
      { key: 'products', label: 'Products', role: 'count', value: b.products.length },
      {
        key: 'nextCharge',
        label: 'Next charge',
        role: 'money',
        value: b.upcomingPayment?.amount ?? null,
        currency: b.currency
      },
      {
        key: 'delinquent',
        label: 'Payment',
        role: 'status',
        value: b.delinquent ? 'delinquent' : 'current'
      }
    ]
  })
}

// The raw bundle the Billing tab fetches — one field per dashboard endpoint, fed verbatim to buildHubspotBillingResult.
export interface RawHubspotBillingBundle {
  invoices: RawHubspotTransactionsResponse | null
  upcoming: RawUpcomingPaymentsResponse | null
  paymentMethods: RawHubspotPaymentMethodsResponse | null
  paidProducts: RawPaidProductsResponse[] | null
  delinquency: RawDelinquency | null
}

const fetchHubspotBilling = async (ctx: CollectContext): Promise<RawHubspotBillingBundle> => {
  const portalId = portalOf(ctx)
  const tx = '/api/transactions-experience/v1'
  const q = `?portalId=${encodeURIComponent(portalId)}`
  const [invoices, upcoming, paymentMethods, paidProducts, delinquency] = await Promise.all([
    ctx.client.get<RawHubspotTransactionsResponse>(`${tx}/transactions${q}&limit=100&offset=0&transactionType=INVOICE`),
    ctx.client.get<RawUpcomingPaymentsResponse>(`${tx}/upcoming-payments${q}`).catch(() => null),
    ctx.client.get<RawHubspotPaymentMethodsResponse>(`${tx}/payment-methods${q}`).catch(() => null),
    ctx.client
      .get<RawPaidProductsResponse[]>(`/api/subscription-experience/v1/paid-products${q}&locale=en-us`)
      .catch(() => null),
    ctx.client.get<RawDelinquency>(`${tx}/customer/is-delinquent${q}`).catch(() => null)
  ])

  return { invoices, upcoming, paymentMethods, paidProducts, delinquency }
}

const buildHubspotBillingBundle = (raw: RawHubspotBillingBundle): CapabilityResult =>
  buildHubspotBillingResult(raw.invoices, raw.upcoming, raw.paymentMethods, raw.paidProducts, raw.delinquency)

// ── usage ───────────────────────────────────────────────────────────────────────────
// per-product limits (contacts, email sends, seats) + seat assignments + marketable-contacts trend +
// HubSpot Credits — all plain COUNTS, no money. Each metric carries its limit; a daily marketable-contacts
// timeseries renders below the metric cards.

export interface HubspotDailyPoint {
  date: string
  count: number
}

// Pull the daily marketable-contacts series (oldest-first 'YYYY-MM-DD' points).
export const buildHubspotDaily = (marketable: RawMarketableContactsResponse | null | undefined): HubspotDailyPoint[] =>
  (marketable?.usageByResolution?.usage ?? [])
    .map((u) => ({ date: isoDay(u.date) ?? '', count: u.marketableContactsCount ?? 0 }))
    .filter((p) => p.date !== '')
    .sort(byDayAsc)

// Flattens product limits (incl. nested quantity packs) + seats + marketable contacts + credits into a flat
// metric list (label · value · limit), all counts.
export const buildHubspotUsageMetrics = (
  paidProducts: RawPaidProductsResponse[] | null | undefined,
  seatInfo: RawSeatInfo[] | null | undefined,
  marketable: RawMarketableContactsResponse | null | undefined,
  credits: RawCreditsResponse | null | undefined
): UsageMetricInput[] => {
  const metrics: UsageMetricInput[] = []

  // Product limits, including limits nested under quantity packs.
  const flatProducts = (paidProducts ?? [])
    .flatMap((s) => s.paidProducts ?? [])
    .flatMap((p) => [p, ...(p.quantityPacks ?? [])])

  for (const p of flatProducts) {
    for (const l of p.limits ?? []) {
      metrics.push({
        label: `${p.name ?? 'Product'} · ${l.name ?? 'limit'}`,
        value: l.used ?? 0,
        limit: l.limit ?? null
      })
    }
  }

  for (const s of seatInfo ?? []) {
    metrics.push({
      label: `Seats · ${s.seatName ?? 'core'}`,
      value: s.currentAssignedSeats ?? 0,
      limit: s.maxAssignableSeats ?? null,
      unit: 'seats'
    })
  }

  const latest = marketable?.latestCountForBilling ?? marketable?.realTimeCount

  if (marketable) {
    metrics.push({
      label: 'Marketable contacts',
      value: latest?.marketableContactsCount ?? 0,
      limit: latest?.marketableContactsLimit ?? marketable.contactsTier ?? null,
      unit: 'contacts'
    })
  }

  const c = credits?.data

  if (c) {
    metrics.push({
      label: 'HubSpot credits',
      value: c.creditsUsed ?? 0,
      limit: c.totalCredits ?? null,
      unit: 'credits'
    })
  }

  return metrics
}

// Compose the usage result: the metric cards/table + an optional daily marketable-contacts timeseries.
export const buildHubspotUsageResult = (
  paidProducts: RawPaidProductsResponse[] | null | undefined,
  seatInfo: RawSeatInfo[] | null | undefined,
  marketable: RawMarketableContactsResponse | null | undefined,
  credits: RawCreditsResponse | null | undefined
): CapabilityResult => {
  const result = usage.result({
    periodStart: credits?.data?.startDate,
    periodEnd: credits?.data?.endDate,
    metrics: buildHubspotUsageMetrics(paidProducts, seatInfo, marketable, credits)
  })
  const points = buildHubspotDaily(marketable)
  const series = points.length
    ? table<HubspotDailyPoint>({
        id: 'daily',
        columns: [
          { key: 'date', label: 'Date', role: 'timestamp' },
          { key: 'count', label: 'Marketable contacts', role: 'count' }
        ],
        rows: points,
        // One point per day → keyed by date so the marketable-contacts trend accumulates past the fetch window.
        key: 'date'
      }).timeseries({ x: 'date', y: 'count', granularity: 'daily', title: 'Marketable contacts' })
    : null

  return addSections(result, series)
}

const CREDITS_RPC =
  '/api/chirp-frontend-app/v1/gateway/com.hubspot.usagebasedbilling.experience.rpc.UsageBasedBillingExperienceRpc/getUsagePeriodUsage'

// The raw bundle the Usage tab fetches — one field per dashboard endpoint, fed verbatim to buildHubspotUsageResult.
export interface RawHubspotUsageBundle {
  paidProducts: RawPaidProductsResponse[] | null
  seatInfo: RawSeatInfo[] | null
  marketable: RawMarketableContactsResponse | null
  credits: RawCreditsResponse | null
}

const fetchHubspotUsage = async (ctx: CollectContext): Promise<RawHubspotUsageBundle> => {
  const portalId = portalOf(ctx)
  const q = `?portalId=${encodeURIComponent(portalId)}`
  // Each surface degrades independently (a permission gap or the credits RPC must not sink the whole tab).
  const [paidProducts, seatInfo, marketable, credits] = await Promise.all([
    ctx.client
      .get<RawPaidProductsResponse[]>(`/api/subscription-experience/v1/paid-products${q}&locale=en-us`)
      .catch(() => null),
    ctx.client.get<RawSeatInfo[]>(`/api/app-users/v1/seat-assignments/${portalId}/seat-info${q}`).catch(() => null),
    ctx.client
      .get<RawMarketableContactsResponse>(
        `/api/edison/v1/marketable-contacts/usage-and-limits${q}&lookbackDays=30&resolution=DAILY`
      )
      .catch(() => null),
    ctx.client.post<RawCreditsResponse>(`${CREDITS_RPC}${q}`, { showBreakdown: false }).catch(() => null)
  ])

  return { paidProducts, seatInfo, marketable, credits }
}

const buildHubspotUsageBundle = (raw: RawHubspotUsageBundle): CapabilityResult =>
  buildHubspotUsageResult(raw.paidProducts, raw.seatInfo, raw.marketable, raw.credits)

// ── members ───────────────────────────────────────────────────────────────────────────
// The user roster, read with the SAME dashboard cookie the usage tab already replays — the app-users
// service (`/api/app-users/v1/app-users/<portalId>`) backs the Settings → Users page and is reachable with
// `hubspotapi` + the CSRF header (NOT the public CRM Private App token, a separate surface). Each app-user
// carries id + email + first/last name; the role label is the primary role name when the response inlines
// it, else the first roleId. No money, no counts — just who has access.

export interface RawHubspotUser {
  id?: string | number
  email?: string
  firstName?: string
  lastName?: string
  superAdmin?: boolean
  primaryRoleName?: string
  roleNames?: string[]
  roleIds?: Array<string | number>
}

export interface RawHubspotUsersResponse {
  results?: RawHubspotUser[]
}

// A users payload may arrive as the raw array or wrapped in `{ results }`; normalize to the list.
const usersOf = (raw: RawHubspotUsersResponse | RawHubspotUser[] | null | undefined): RawHubspotUser[] => {
  if (Array.isArray(raw)) {
    return raw
  }

  return raw?.results ?? []
}

// Map one app-user's role to a label: super-admin wins, else an inlined primary/first role name, else the
// first roleId stringified, else undefined.
const roleOf = (u: RawHubspotUser): string | undefined => {
  if (u.superAdmin) {
    return 'super_admin'
  }

  const named = u.primaryRoleName ?? u.roleNames?.[0]

  if (named) {
    return named
  }

  const firstId = u.roleIds?.[0]

  return firstId != null ? String(firstId) : undefined
}

// Maps app-users → id/name/email/role. Name is the joined first+last when present (empty → undefined so the
// renderer shows the email instead).
export const buildHubspotMembers = (
  raw: RawHubspotUsersResponse | RawHubspotUser[] | null | undefined
): MembersInput => ({
  members: usersOf(raw).map((u, i) => {
    const name = fullName(u.firstName, u.lastName)

    return {
      id: u.id != null ? String(u.id) : String(i),
      name: name || undefined,
      email: u.email,
      role: roleOf(u)
    }
  }) satisfies MemberInput[]
})

const fetchHubspotMembers = async (ctx: CollectContext): Promise<RawHubspotUsersResponse | RawHubspotUser[] | null> => {
  const portalId = portalOf(ctx)

  return ctx.client
    .get<RawHubspotUsersResponse | RawHubspotUser[]>(`/api/app-users/v1/app-users/${portalId}`)
    .catch(() => null)
}

// ── descriptor ──────────────────────────────────────────────────────────────────────
export const hubspotConfigSchema = defineConfigSchema([
  {
    key: 'portalId',
    label: 'Portal (hub) id',
    kind: 'text',
    required: false,
    help: 'Auto-captured at sign-in. Override only if wrong (app.hubspot.com/account-and-billing/<portalId>).'
  }
])

export type HubspotConfig = ConfigOf<typeof hubspotConfigSchema>

export const hubspotPlugin = definePlugin({
  reportingCurrency: 'USD',
  meta: {
    id: 'hubspot',
    name: 'HubSpot',
    vendor: 'HubSpot',
    category: 'productivity',
    color: '#ff7a59',
    description: 'HubSpot Account & Billing — invoice history, spend, and per-product usage limits.',
    homepage: 'https://www.hubspot.com',
    dashboardUrl: 'https://app.hubspot.com'
  },
  // Magic Login capture. HubSpot's session/CSRF cookies (`hubspotapi`, `hubspotapi-csrf`) can be present on
  // the login form itself (stale shared-partition jar / set pre-auth), so the markers must NOT be substrings
  // of `/login` — we gate on the post-auth app shell so capture only fires on an authenticated jar.
  session: {
    loginUrl: 'https://app.hubspot.com/login',
    dashboardMarkers: ['/account-and-billing/', '/reports-dashboard'],
    cookieDomains: ['hubspot.com'],
    requiredCookie: 'hubspotapi',
    // The portal (hub) id is the numeric segment after the app-shell section in the settled URL
    // (app.hubspot.com/{account-and-billing,reports-dashboard}/<portalId>) — auto-capture it so the
    // user never has to find/paste it.
    captureFromUrl: [{ pattern: '/(?:account-and-billing|reports-dashboard)/(\\d+)', storeAs: 'portalId' }]
  },
  // cookie-csrf: replay the `hubspotapi` session cookie + double-submit the `hubspotapi-csrf` cookie value as
  // the `x-hubspot-csrf-hubspotapi` header (see resolveHubspotAuth). Clears the cookie on 401 only (a 403 is
  // a per-endpoint permission denial, not a dead session — core's default).
  auth: { kind: 'cookie-csrf', resolve: resolveHubspotAuth },
  // app.hubspot.com is Cloudflare-fronted but the XHRs are same-origin → plain Node TLS (the core node client
  // injects the canonical browser UA + sec-ch-ua centrally; we add only the same-origin Origin + Sec-Fetch-*
  // markers, both forbidden on Electron net.request, which is why this stays on node transport).
  transport: {
    engine: 'node',
    baseUrl: HUBSPOT_ORIGIN,
    defaultHeaders: {
      Accept: '*/*',
      'Content-Type': 'application/json',
      Origin: HUBSPOT_ORIGIN,
      Referer: `${HUBSPOT_ORIGIN}/`,
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty'
    }
  },
  config: hubspotConfigSchema,
  capabilities: [
    defineCapability({
      id: 'billing',
      label: 'Billing',
      fetch: fetchHubspotBilling,
      build: buildHubspotBillingBundle,
      sample: sampleHubspotBilling
    }),
    defineCapability({
      id: 'usage',
      label: 'Usage',
      fetch: fetchHubspotUsage,
      build: buildHubspotUsageBundle,
      sample: sampleHubspotUsage
    }),
    defineCapability({
      id: 'members',
      label: 'Members',
      fetch: fetchHubspotMembers,
      build: (raw) => members.result(buildHubspotMembers(raw)),
      sample: sampleHubspotMembers
    })
  ],
  probe: async (ctx) => {
    // One tiny portal-scoped GET proves the session cookie + CSRF header + portal id all resolve.
    const q = `?portalId=${encodeURIComponent(portalOf(ctx))}`

    await ctx.client.get<RawDelinquency>(`/api/transactions-experience/v1/customer/is-delinquent${q}`)
  }
})
