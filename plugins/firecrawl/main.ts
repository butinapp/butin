import { defineCapability, definePlugin, type CollectContext } from '@butinapp/sdk'
import { addSections, table, type CapabilityResult } from '@butinapp/sdk/data'
import { billing, keys, type ApiKeysInput, type BillingInvoiceInput, type BillingStat } from '@butinapp/sdk/presets'
import { asArray, byDayDesc, centsToMajor, epochSecDay, normalizeCurrency } from '@butinapp/sdk/util'

import { sampleFirecrawlInvoices, sampleFirecrawlTeam } from './sample.js'

// Firecrawl (firecrawl.dev) — the web-scraping API dashboard. Two read-only tabs: Billing (Stripe invoice
// history + current plan + payment method, with a current-month spend headline) and API Keys (the team's
// keys, masked to an `fc-…suffix` hint — never a usable secret). Both are driven by plain JSON GETs on the
// dashboard origin under the captured session cookie. The dashboard is Vercel-fronted (not Cloudflare), so
// Node's TLS fingerprint is accepted → plain `node` transport. `/api/user/team` both drives the API Keys
// tab AND supplies the `teamId` the invoices call needs, so a small coalescing loader fetches it once.

// ── constants ───────────────────────────────────────────────────────────────────────
const API = 'https://www.firecrawl.dev'

// ── types ─────────────────────────────────────────────────────────────────────────
// Firecrawl proxies Stripe invoices verbatim, so money is in CENTS and `created` is unix seconds.

export interface RawStripePrice {
  nickname?: string | null
}

export interface RawStripeLine {
  description?: string | null
  amount?: number
  plan?: { nickname?: string | null } | null
  price?: RawStripePrice | null
}

export interface RawStripeCard {
  brand?: string
  last4?: string
}

export interface RawStripeCharge {
  payment_method_details?: { type?: string; card?: RawStripeCard | null } | null
}

export interface RawFirecrawlInvoice {
  id?: string
  created?: number // unix seconds
  total?: number // grand total, cents
  amount_due?: number // cents
  amount_paid?: number // cents
  status?: string
  billing_reason?: string
  number?: string | null
  currency?: string
  hosted_invoice_url?: string | null
  invoice_pdf?: string | null
  charge?: RawStripeCharge | null
  lines?: { data?: RawStripeLine[] }
}

export interface RawFirecrawlTeam {
  teamId?: string
  apiKey?: string
  apiKeys?: Array<{ id?: number; name?: string; key?: string }>
}

// Normalized invoice — USD dollars, dated 'YYYY-MM-DD'. Shape-compatible with the SDK's BillingInvoiceInput.
export interface FirecrawlInvoice extends BillingInvoiceInput {
  /** Stripe invoice id — the stable ledger key (number is nullable, and a month can carry several invoices). */
  id: string
  date?: string
  status: string
  amount: number // dollars
  number?: string
  reason: string
  hostedUrl?: string | null
  pdfUrl?: string | null
}

export interface FirecrawlBilling {
  invoices: FirecrawlInvoice[]
  currentMtd: number // USD spend in the current calendar month
  plan?: string
  paymentMethod?: string
  currency: string
}

// ── domain logic ────────────────────────────────────────────────────────────────────

const normalizeInvoice = (inv: RawFirecrawlInvoice, i: number): FirecrawlInvoice => ({
  id: inv.id ?? `inv-${i}`,
  date: epochSecDay(inv.created),
  status: inv.status ?? 'unknown',
  amount: centsToMajor(inv.total ?? inv.amount_due),
  number: inv.number ?? undefined,
  reason: inv.billing_reason ?? 'unknown',
  hostedUrl: inv.hosted_invoice_url ?? null,
  pdfUrl: inv.invoice_pdf ?? null
})

// The subscription plan label from an invoice's line items (nickname first, else first line's description).
const planOf = (inv?: RawFirecrawlInvoice): string | undefined => {
  const lines = inv?.lines?.data ?? []

  for (const l of lines) {
    const nick = l.plan?.nickname ?? l.price?.nickname

    if (nick) {
      return nick
    }
  }

  return lines[0]?.description ?? undefined
}

// Human-readable payment method from an invoice's charge ('visa •••• 4242' / 'link').
const paymentMethodOf = (inv?: RawFirecrawlInvoice): string | undefined => {
  const pm = inv?.charge?.payment_method_details

  if (!pm?.type) {
    return undefined
  }

  if (pm.type === 'card' && pm.card) {
    return [pm.card.brand, pm.card.last4 ? `•••• ${pm.card.last4}` : null].filter(Boolean).join(' ') || 'card'
  }

  return pm.type
}

// Pure transform — fixture-tested. Normalizes the raw Stripe invoice array (cents → dollars, newest-first)
// and derives plan / payment method / currency from the newest invoice + the current-month spend headline.
export const buildFirecrawlBilling = (raw: RawFirecrawlInvoice[] | undefined | null): FirecrawlBilling => {
  const list = asArray<RawFirecrawlInvoice>(raw)
  const invoices = list.map(normalizeInvoice).sort(byDayDesc)
  const newest = list.slice().sort((a, b) => (b.created ?? 0) - (a.created ?? 0))[0]

  return {
    invoices,
    currentMtd: billing.invoicedMtd(invoices),
    plan: planOf(newest),
    paymentMethod: paymentMethodOf(newest),
    currency: normalizeCurrency(newest?.currency)
  }
}

// Row type for the downloadable invoice history table. `name` carries the download filename — not rendered;
// `id` (Stripe invoice id) rides hidden as the ledger key.
interface FirecrawlInvoiceRow {
  id: string
  date: string | null
  number: string | null
  amount: number
  status: string
  pdfUrl: string | null
  name: string
}

// Compose the billing result: the shared summary preset (currentMtd headline + plan + payment-method stat +
// monthly-spend chart + spend.mtd summary) plus a downloadable invoice-history table (Stripe PDF per row).
export const buildFirecrawlBillingResult = (raw: RawFirecrawlInvoice[] | undefined | null): CapabilityResult => {
  const billingData = buildFirecrawlBilling(raw)

  const stats: BillingStat[] = []

  if (billingData.paymentMethod) {
    stats.push({ key: 'paymentMethod', label: 'Payment method', role: 'label', value: billingData.paymentMethod })
  }

  stats.push({ key: 'invoiceCount', label: 'Invoices', role: 'count', value: billingData.invoices.length })

  const result = billing.summary({
    currentMtd: billingData.currentMtd,
    // Sum of the current calendar month's issued invoices.
    mtdBasis: 'invoiced',
    currency: billingData.currency,
    plan: billingData.plan,
    invoices: billingData.invoices,
    stats
  })

  const invoices = table<FirecrawlInvoiceRow>({
    id: 'invoices',
    columns: [
      { key: 'date', label: 'Date', role: 'timestamp' },
      { key: 'number', label: 'Number', role: 'identifier' },
      { key: 'amount', label: 'Amount', role: 'money', currency: billingData.currency },
      { key: 'status', label: 'Status', role: 'status' },
      { key: 'pdfUrl', label: 'PDF', role: 'url' },
      { key: 'name', role: 'label', hidden: true },
      { key: 'id', role: 'identifier', hidden: true }
    ],
    rows: billingData.invoices.map((i) => ({
      id: i.id,
      date: i.date ?? null,
      number: i.number ?? null,
      amount: i.amount,
      status: i.status,
      pdfUrl: i.pdfUrl ?? i.hostedUrl ?? null,
      name: `Invoice ${i.number ?? i.date ?? 'unknown'}`
    })),
    key: 'id'
  })

  const section = invoices.fileTable({
    title: 'Invoices',
    name: 'name',
    source: { url: 'pdfUrl' },
    ext: 'pdf',
    category: 'Invoices'
  })

  return addSections(result, section)
}

// --- apiKeys: the team's keys, from `/api/user/team` ---
// The endpoint returns the FULL secret, so maskKey reduces it to an `fc-…last4` hint before it leaves here.

// `fc-79c2…927fe0` → `fc-…7fe0` (prefix + last 4); non-fc keys keep just `…last4`; short/empty → '—'.
export const maskKey = (key?: string): string => {
  if (!key) {
    return '—'
  }

  const prefix = key.startsWith('fc-') ? 'fc-' : ''

  return `${prefix}…${key.slice(-4)}`
}

// Pure transform — fixture-tested.
export const buildFirecrawlKeys = (team: RawFirecrawlTeam | undefined | null): ApiKeysInput => ({
  keys: (team?.apiKeys ?? []).map((k) => ({
    id: String(k.id ?? ''),
    name: k.name || '(unnamed)',
    masked: maskKey(k.key)
  }))
})

// --- shared loader: /api/user/team supplies both the keys AND the teamId the invoices call needs ---
// Both fetches call this; the core query cache dedupes the underlying read across the two runs.

const loadTeam = (ctx: CollectContext): Promise<RawFirecrawlTeam> =>
  ctx.client.get<RawFirecrawlTeam>(`${API}/api/user/team`)

// Resolve the team to get its teamId, then pull the Stripe invoice history it scopes.
const fetchFirecrawlInvoices = async (ctx: CollectContext): Promise<RawFirecrawlInvoice[]> => {
  const team = await loadTeam(ctx)

  if (!team.teamId) {
    throw new Error('Firecrawl /api/user/team returned no teamId')
  }

  return ctx.client.get<RawFirecrawlInvoice[]>(`${API}/api/invoices?teamId=${encodeURIComponent(team.teamId)}`)
}

// ── descriptor ──────────────────────────────────────────────────────────────────────
export const firecrawlPlugin = definePlugin({
  reportingCurrency: 'USD',
  meta: {
    id: 'firecrawl',
    name: 'Firecrawl',
    vendor: 'Firecrawl',
    category: 'devtools',
    color: '#fb6c0a',
    description: 'Firecrawl billing history (Stripe invoices, current plan) and the team’s API keys.',
    homepage: 'https://firecrawl.dev',
    dashboardUrl: 'https://www.firecrawl.dev/app'
  },
  session: {
    loginUrl: 'https://www.firecrawl.dev/signin',
    dashboardMarkers: ['/app', '/settings'],
    cookieDomains: ['firecrawl.dev']
  },
  // The dashboard /api/* routes replay verbatim under the captured session cookie. Vercel-fronted (not
  // Cloudflare), so Node's TLS is accepted → plain node transport, the edge accepts a plain client.
  auth: { kind: 'cookie' },
  capabilities: [
    defineCapability({
      id: 'billing',
      label: 'Billing',
      fetch: fetchFirecrawlInvoices,
      build: buildFirecrawlBillingResult,
      sample: sampleFirecrawlInvoices
    }),
    defineCapability({
      id: 'apiKeys',
      label: 'API Keys',
      fetch: loadTeam,
      build: (team) => keys.result(buildFirecrawlKeys(team)),
      sample: sampleFirecrawlTeam
    })
  ],
  probe: async (ctx) => {
    // /api/user/team is the cheapest authed call — a 200 proves the session cookie is live.
    await ctx.client.get(`${API}/api/user/team`)
  }
})
