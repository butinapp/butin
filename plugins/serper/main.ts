import { defineCapability, definePlugin, type CollectContext } from '@butinapp/sdk'
import { addSections, capabilityResult, record, table, type CapabilityResult } from '@butinapp/sdk/data'
import { billing, keys, usage, type ApiKeysInput, type BillingInput } from '@butinapp/sdk/presets'
import { byDayAsc, byDayDesc, isoDay, normalizeCurrency, parseDecimalAmount, utcDaysAgo } from '@butinapp/sdk/util'

import { sampleSerperBilling, sampleSerperKeys, sampleSerperUsage } from './sample.js'

// Serper signs in with username/password (no SSO — you type email + password in the capture
// window). The dashboard is serper.dev but the data lives on the sibling host api.serper.dev, so the XHRs are
// cross-subdomain: the browser sends `Origin: https://serper.dev` + `Sec-Fetch-Site: same-site`, both forbidden
// on Electron net.request, so this runs on Node axios (api.serper.dev is Cloudflare-fronted but serves JSON
// dynamically, so the edge accepts a plain client). The durable credential is the Express `connect.sid` cookie (HttpOnly, set
// on api.serper.dev, matched by the serper.dev domain substring).
const API = 'https://api.serper.dev'

// --- billing: Paddle payment history (recurring credit top-ups), `/billing/payments` ---
// Money is a USD dollar STRING ("57.49"), NOT cents → parseDecimalAmount, no /100. Payments carry no
// per-row status, so they normalize to 'paid'. currentMtd = money charged in the current calendar month.

export interface RawSerperPayment {
  amount?: string // USD dollar string, e.g. "57.49"
  currency?: string
  date?: string // ISO timestamp
  receiptUrl?: string | null // Paddle-hosted
}

// Pure transform — fixture-tested.
export const buildSerperBilling = (rawPayments: RawSerperPayment[] | undefined | null): BillingInput => {
  const list = Array.isArray(rawPayments) ? rawPayments : []
  const invoices = list
    .map((p) => ({
      date: isoDay(p.date) ?? '',
      amount: parseDecimalAmount(p.amount),
      status: 'paid',
      hostedUrl: p.receiptUrl ?? null
    }))
    .sort(byDayDesc)

  return {
    currentMtd: billing.invoicedMtd(invoices),
    currency: normalizeCurrency(list[0]?.currency),
    invoices
  }
}

export interface RawSerperPaymentDetails {
  paymentMethod?: string | null
  cardType?: string | null
  lastFourDigits?: string | null
  expiryDate?: string | null
}

export interface SerperPaymentMethod {
  method: string | null
  cardType: string | null
  lastFour: string | null
  expiry: string | null
}

// Pure transform — fixture-tested. Returns null when no card is on file (paymentMethod absent).
export const buildSerperPaymentMethod = (d: RawSerperPaymentDetails | undefined | null): SerperPaymentMethod | null => {
  if (!d || !d.paymentMethod) {
    return null
  }

  return {
    method: d.paymentMethod ?? null,
    cardType: d.cardType ?? null,
    lastFour: d.lastFourDigits ?? null,
    expiry: d.expiryDate ?? null
  }
}

// --- Summary tab (its spend.mtd summary is what the cross-service Overview rolls up) ---
// The shared billing.summary preset (account stat + monthly-spend chart + spend.mtd summary), plus a
// free payment-count stat (off the payment list already fetched for the chart).
export const buildSerperSummaryResult = (rawPayments: RawSerperPayment[] | undefined | null): CapabilityResult => {
  const billingData = buildSerperBilling(rawPayments)

  return billing.summary({
    currentMtd: billingData.currentMtd,
    // Money charged in the current calendar month.
    mtdBasis: 'invoiced',
    currency: billingData.currency,
    invoices: billingData.invoices,
    stats: [{ key: 'invoiceCount', label: 'Payments', role: 'count', value: billingData.invoices.length }]
  })
}

// --- Billing tab (renders via the generic renderer but is NOT the Overview rollup) ---
// The payment/receipt history as a downloadable table (each row's Paddle receipt is the file URL; the host
// adds selection + Download all/selected + per-row Open + on-disk size), plus an optional payment-method
// record/keyvalue. The headline (MTD / monthly chart) lives on Summary.
interface SerperInvoiceRow {
  date: string | null
  amount: number
  status: string
  receiptUrl: string | null
  // Hidden — carried for the download filename, declared not smuggled.
  name: string
}

interface SerperPaymentMethodRow {
  cardType: string | null
  lastFour: string | null
  expiry: string | null
}

export const buildSerperBillingResult = (
  rawPayments: RawSerperPayment[] | undefined | null,
  rawDetails?: RawSerperPaymentDetails | null
): CapabilityResult => {
  const billing = buildSerperBilling(rawPayments)
  const invoices = table<SerperInvoiceRow>({
    id: 'invoices',
    columns: [
      { key: 'date', label: 'Date', role: 'timestamp' },
      { key: 'amount', label: 'Amount', role: 'money', currency: billing.currency },
      { key: 'status', label: 'Status', role: 'status' },
      { key: 'receiptUrl', label: 'Receipt', role: 'url' },
      { key: 'name', role: 'label', hidden: true }
    ],
    rows: billing.invoices.map((i) => ({
      date: i.date || null,
      amount: i.amount,
      status: i.status,
      receiptUrl: i.hostedUrl ?? null,
      name: `Invoice ${i.date || 'unknown'}`
    })),
    // Payments carry no id — the payment date is the stable identity (renewals are ~monthly), keyed so each
    // payment accumulates in the ledger past the fetch window.
    key: 'date'
  })
  const pm = buildSerperPaymentMethod(rawDetails)
  const card = pm
    ? record<SerperPaymentMethodRow>({
        id: 'paymentMethod',
        fields: [
          { key: 'cardType', label: 'Card', role: 'label' },
          { key: 'lastFour', label: 'Last 4', role: 'label' },
          { key: 'expiry', label: 'Expires', role: 'label' }
        ],
        value: { cardType: pm.cardType, lastFour: pm.lastFour, expiry: pm.expiry }
      })
    : null

  return capabilityResult({
    sections: [
      invoices.fileTable({
        title: 'Invoices',
        name: 'name',
        source: { url: 'receiptUrl' },
        ext: 'pdf',
        category: 'Invoices'
      }),
      card?.keyvalue({ title: 'Payment method' })
    ]
  })
}

// Summary + Billing both need the payments list (Billing also the payment-method card). Both collects
// call loadSerperBilling; the core query cache dedupes the underlying reads.
// payment-details is best-effort: a missing/erroring card must not blank the whole billing tab.
interface SerperBillingData {
  payments: RawSerperPayment[]
  details: RawSerperPaymentDetails | null
}

const loadSerperBilling = async (ctx: CollectContext): Promise<SerperBillingData> => {
  const [payments, details] = await Promise.all([
    ctx.client.get<RawSerperPayment[]>(`${API}/billing/payments`),
    ctx.client.get<RawSerperPaymentDetails>(`${API}/billing/payment-details`).catch(() => null)
  ])

  return { payments: payments ?? [], details }
}

// --- usage: credit balance + today / last-month consumption, `/stats/dashboard` ---
// Units are CREDITS, not money (Serper sells prepaid packs, no exposed credit→USD rate), so these
// render as plain counts and emit no money summary.

export interface RawSerperDashboard {
  usageToday?: number
  usageLastMonth?: number
  creditBalance?: number
}

// Pure transform — fixture-tested.
export const buildSerperUsageMetrics = (dashboard: RawSerperDashboard | undefined | null) => [
  { label: 'Credit balance', value: dashboard?.creditBalance ?? 0, unit: 'credits' },
  { label: 'Used today', value: dashboard?.usageToday ?? 0, unit: 'credits' },
  { label: 'Used last month', value: dashboard?.usageLastMonth ?? 0, unit: 'credits' }
]

export interface RawSerperDailyUsage {
  data?: Array<{ start?: string; count?: number }>
}

export interface SerperDailyPoint {
  date: string
  credits: number
}

// Pure transform — fixture-tested. ISO bucket starts → 'YYYY-MM-DD' credit points, oldest first.
export const buildSerperDaily = (daily: RawSerperDailyUsage | undefined | null): SerperDailyPoint[] =>
  (Array.isArray(daily?.data) ? daily.data : [])
    .map((b) => ({ date: isoDay(b.start) ?? '', credits: b.count ?? 0 }))
    .filter((p) => p.date !== '')
    .sort(byDayAsc)

// Compose the usage result: the 3 credit stat metrics + an optional daily-credits timeseries.
export const buildSerperUsageResult = (
  dashboard: RawSerperDashboard | undefined | null,
  daily?: RawSerperDailyUsage | null
): CapabilityResult => {
  const result = usage.result({ metrics: buildSerperUsageMetrics(dashboard) })
  const points = buildSerperDaily(daily)

  const series = points.length
    ? table<SerperDailyPoint>({
        id: 'daily',
        columns: [
          { key: 'date', label: 'Date', role: 'timestamp' },
          { key: 'credits', label: 'Credits', role: 'count' }
        ],
        rows: points,
        // Keyed by day so each day's credit total accumulates in the ledger past the trailing fetch window.
        key: 'date'
      }).timeseries({ x: 'date', y: 'credits', granularity: 'daily', title: 'Daily credits' })
    : null

  return addSections(result, series)
}

// Fetch the dashboard balance + the trailing-30-day daily-credits window. The trend is secondary to the
// balance/usage cards: if the window errors, still render the cards.
const fetchSerperUsage = async (ctx: CollectContext): Promise<SerperUsageData> => {
  const start = utcDaysAgo(29)
  const end = utcDaysAgo(0)
  const dailyPath = `${API}/stats/daily-usage?start=${start}&end=${end}&timezone=${encodeURIComponent('UTC')}&metric=credits`
  const [dashboard, daily] = await Promise.all([
    ctx.client.get<RawSerperDashboard>(`${API}/stats/dashboard`),
    ctx.client.get<RawSerperDailyUsage>(dailyPath).catch(() => null)
  ])

  return { dashboard, daily }
}

interface SerperUsageData {
  dashboard: RawSerperDashboard | null
  daily: RawSerperDailyUsage | null
}

// --- apiKeys: the account's keys, `/users/api-keys` ---
// The endpoint returns the FULL secret, so maskKey reduces it to a `…last4` hint before it leaves here.

export interface RawSerperApiKey {
  id?: string
  key?: string // full secret — masked here
  name?: string
  revokedAt?: string | null
  createdAt?: string | null
}

// `a3874ba30b…3b20` → `…3b20` (last 4); short/empty keys degrade to '—'.
export const maskKey = (key?: string): string => (key ? `…${key.slice(-4)}` : '—')

// Pure transform — fixture-tested.
export const buildSerperKeys = (raw: RawSerperApiKey[] | undefined | null): ApiKeysInput => ({
  keys: (Array.isArray(raw) ? raw : []).map((k) => ({
    id: String(k.id ?? ''),
    name: k.name || '(unnamed)',
    masked: maskKey(k.key),
    createdAt: k.createdAt ?? undefined,
    revoked: !!k.revokedAt
  }))
})

export const serperPlugin = definePlugin({
  reportingCurrency: 'USD',
  meta: {
    id: 'serper',
    name: 'Serper',
    vendor: 'Serper',
    category: 'devtools',
    color: '#8ac7f0',
    description: 'Serper search-API billing, usage, keys, and receipt PDFs.',
    homepage: 'https://serper.dev',
    dashboardUrl: 'https://serper.dev/dashboard'
  },
  session: {
    loginUrl: 'https://serper.dev/login',
    dashboardMarkers: ['/dashboard', '/api-key', '/playground'],
    cookieDomains: ['serper.dev'],
    requiredCookie: 'connect.sid'
  },
  auth: { kind: 'cookie' },
  // node client injects the browser UA + sec-ch-ua centrally; we add the cross-subdomain (serper.dev →
  // api.serper.dev) Origin + same-site XHR markers — both forbidden on Electron net.request, which is why
  // this stays on node transport.
  transport: {
    defaultHeaders: {
      Accept: 'application/json, text/plain, */*',
      Origin: 'https://serper.dev',
      Referer: 'https://serper.dev/',
      'Sec-Fetch-Site': 'same-site',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty'
    }
  },
  capabilities: [
    // Invoice PDFs aren't a separate documents tab — the Billing invoices table is downloadable (its receiptUrl column).
    defineCapability({
      id: 'summary',
      label: 'Summary',
      fetch: loadSerperBilling,
      build: (raw) => buildSerperSummaryResult(raw.payments),
      sample: sampleSerperBilling
    }),
    defineCapability({
      id: 'billing',
      label: 'Billing',
      fetch: loadSerperBilling,
      build: (raw) => buildSerperBillingResult(raw.payments, raw.details),
      sample: sampleSerperBilling
    }),
    defineCapability({
      id: 'usage',
      label: 'Usage',
      fetch: fetchSerperUsage,
      build: (raw) => buildSerperUsageResult(raw.dashboard, raw.daily),
      sample: sampleSerperUsage
    }),
    defineCapability({
      id: 'apiKeys',
      label: 'API Keys',
      fetch: async (ctx) => ({ keys: await ctx.client.get<RawSerperApiKey[]>(`${API}/users/api-keys`) }),
      build: (raw) => keys.result(buildSerperKeys(raw.keys)),
      sample: sampleSerperKeys
    })
  ],
  probe: async (ctx) => {
    // /stats/dashboard is the cheapest authed call — a 200 proves the connect.sid session is live.
    await ctx.client.get('https://api.serper.dev/stats/dashboard')
  }
})
