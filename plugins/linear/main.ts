import {
  defineCapability,
  defineConfigSchema,
  definePlugin,
  type AuthAttachment,
  type AuthContext,
  type CollectContext,
  type ConfigOf
} from '@butinapp/sdk'
import { capabilityResult, record, table, type CapabilityResult } from '@butinapp/sdk/data'
import { billing, members, type BillingInvoiceInput, type MembersInput } from '@butinapp/sdk/presets'
import { byDayDesc, centsToMajor, currentMonthKey, isoDay, round2 } from '@butinapp/sdk/util'

import { sampleLinearBilling, sampleLinearMembers } from './sample.js'

// Linear: a cookie session over Node TLS. The dashboard (linear.app) is backed by the internal GraphQL API
// on the sibling host client-api.linear.app — which is Cloudflare-fronted BUT validates a same-origin browser
// XHR (`Origin: https://linear.app` + `Sec-Fetch-Site: same-site`). Those headers are forbidden on Electron
// net.request, so this stays on node axios (the JSON endpoint accepts a plain client). The durable
// credential is the dashboard session cookie, replayed with three workspace-scoping headers (see resolveLinearAuth).
// Money is CENTS (Stripe) → centsToMajor; invoice `created` is an ISO timestamp → isoDay; invoice `url` is a
// Stripe-hosted invoice page.
const GQL = 'https://client-api.linear.app/graphql'

// Two operations: CachedBillingDetails (contact / tax id / payment method + the first invoice page) and
// CachedBillingInvoices (the full invoice history). We prefer the full list and fall back to the page.
const BILLING_DETAILS_QUERY = `query CachedBillingDetails {
  billingDetails {
    success
    name
    email
    taxId { type value }
    paymentMethod { type country brand last4 }
    invoices { created dueDate status total url kind }
    invoicesPageInfo { hasNextPage hasPreviousPage }
  }
}`

const BILLING_INVOICES_QUERY = `query CachedBillingInvoices {
  billingInvoices {
    success
    invoices { created dueDate status total url kind }
  }
}`

// The workspace roster via the `users` connection, fetched with the dashboard cookie. The first page (50)
// covers the member-overview read; pagination is not wired.
const MEMBERS_QUERY = `query Members {
  users(first: 50) {
    nodes { id name email admin guest active }
  }
}`

// ── auth: cookie + workspace-scoping headers ──────────────────────────────────────────
// client-api.linear.app authenticates the dashboard cookie AND three lowercase request headers the web client
// always sends; without them it replies 401 "Authentication required, no user context":
//   useraccount — which account the session is for (the suffix of the `session:<id>` cookie name, so it's
//                 derived from the cookie and needs no capture)
//   organization / user — which workspace + membership. No URL segment or cookie carries these, so they're
//                 captured off the SPA's own request headers during Magic Login (captureFromHeader) and are
//                 overridable in Settings.
// Supplying resolve() overrides core's default cookie attachment, so we re-attach the cookie alongside the headers.

// The captured `session:<userAccountId>` cookie name carries the account id `useraccount` scopes to.
export const useraccountFromCookie = (cookie: string | undefined): string | undefined =>
  cookie?.match(/(?:^|;\s*)session:([0-9a-f-]+)=/i)?.[1]

export const resolveLinearAuth = async (ctx: AuthContext): Promise<AuthAttachment> => {
  const cookie = ctx.creds.get('cookie') ?? ''
  const useraccount = ctx.creds.get('useraccount') || useraccountFromCookie(cookie)
  const organization = (ctx.config.organizationId as string | undefined)?.trim() || ctx.creds.get('organizationId')
  const user = (ctx.config.userId as string | undefined)?.trim() || ctx.creds.get('userId')

  const headers: Record<string, string> = {}

  if (useraccount) {
    headers.useraccount = useraccount
  }

  if (organization) {
    headers.organization = organization
  }

  if (user) {
    headers.user = user
  }

  return { cookie, headers }
}

// ── types (the data dictionary) ──────────────────────────────────────────────────────

export interface RawLinearInvoice {
  created?: string // ISO timestamp, e.g. "2026-05-19T16:55:43.000Z"
  dueDate?: string | null
  status?: string
  total?: number // cents
  url?: string
  kind?: string
}

export interface RawLinearPaymentMethod {
  type?: string
  country?: string
  brand?: string
  last4?: string
}

export interface RawBillingDetails {
  success?: boolean
  name?: string | null
  email?: string | null
  taxId?: { type?: string; value?: string } | null
  paymentMethod?: RawLinearPaymentMethod | null
  invoices?: RawLinearInvoice[]
}

export interface RawBillingDetailsResponse {
  billingDetails?: RawBillingDetails
}

export interface RawBillingInvoicesResponse {
  billingInvoices?: { success?: boolean; invoices?: RawLinearInvoice[] }
}

// Summary + Billing both read the same two GraphQL operations; the raw bundle their fetch returns. build runs
// buildLinearBilling over it, so the demo sample is a raw GraphQL shape that exercises the real transform.
export interface RawLinearBilling {
  details: RawBillingDetailsResponse | null
  invoiceList: RawBillingInvoicesResponse | null
}

// The dashboard `users` query returns the workspace roster — id / name / email plus the admin / guest /
// active flags. `admin` → 'admin', `guest` → 'guest', otherwise 'member'; suspended (inactive) members are
// surfaced with a 'suspended' role so they're visibly distinct.
export interface RawLinearUser {
  id?: string
  name?: string | null
  email?: string | null
  admin?: boolean
  guest?: boolean
  active?: boolean
}

export interface RawUsersResponse {
  users?: { nodes?: RawLinearUser[] }
}

// Normalized invoice (dollars). `kind` (subscription / one-off …) is Linear-specific, surfaced as a column.
export interface LinearInvoice extends BillingInvoiceInput {
  date?: string
  amount: number
  status: string
  kind: string
}

export interface LinearPaymentMethod {
  type: string
  brand?: string
  last4?: string
  country?: string
}

export interface LinearBillingReport {
  invoices: LinearInvoice[]
  latestAmount: number
  plan?: string
  paymentMethod: LinearPaymentMethod | null
  billingContact: { name?: string; email?: string } | null
  taxId?: string // e.g. "ca_qst: 1234567890TQ0001"
}

// ── domain logic ─────────────────────────────────────────────────────────────────────

const normalizeInvoice = (inv: RawLinearInvoice): LinearInvoice => ({
  date: isoDay(inv.created),
  amount: centsToMajor(inv.total),
  status: inv.status ?? 'unknown',
  kind: inv.kind ?? 'unknown',
  hostedUrl: inv.url || null
})

// Linear's invoice `url` is the Stripe HOSTED invoice page (HTML); downloading it yields a stub, not a PDF.
// The downloadable PDF is the same URL with `/pdf` inserted before the query string
// (`invoice.stripe.com/i/<acct>/<inv>?s=ap` → `…/<inv>/pdf?s=ap`). Only Stripe hosted-invoice URLs are
// rewritten; anything else (or an already-`/pdf` URL) is returned unchanged.
export const stripeInvoicePdfUrl = (url: string | null | undefined): string | null => {
  if (!url) {
    return null
  }

  const [base, query] = url.split('?')

  if (!base.includes('stripe.com') || base.endsWith('/pdf')) {
    return url
  }

  return query ? `${base}/pdf?${query}` : `${base}/pdf`
}

// Pure transform — fixture-tested. Money is cents → dollars; invoices sort newest-first. Contact / tax id /
// payment method come from billingDetails; the invoice list prefers billingInvoices, falling back to the
// (first-page) list embedded in billingDetails when the dedicated query returns nothing.
export const buildLinearBilling = (
  details: RawBillingDetailsResponse | null | undefined,
  invoiceList: RawBillingInvoicesResponse | null | undefined
): LinearBillingReport => {
  const d = details?.billingDetails ?? {}
  const rawInvoices = invoiceList?.billingInvoices?.invoices?.length
    ? invoiceList.billingInvoices.invoices
    : (d.invoices ?? [])

  const invoices = rawInvoices.map(normalizeInvoice).sort(byDayDesc)

  const pm = d.paymentMethod
  const paymentMethod: LinearPaymentMethod | null = pm?.type
    ? { type: pm.type, brand: pm.brand || undefined, last4: pm.last4 || undefined, country: pm.country || undefined }
    : null

  const billingContact = d.name || d.email ? { name: d.name || undefined, email: d.email || undefined } : null

  const taxId = d.taxId?.value ? `${d.taxId.type ? `${d.taxId.type}: ` : ''}${d.taxId.value}` : undefined

  return {
    invoices,
    latestAmount: invoices[0]?.amount ?? 0,
    plan: invoices[0]?.kind, // Linear has no plan field; the latest invoice's kind is the closest signal.
    paymentMethod,
    billingContact,
    taxId
  }
}

// Spend incurred in the current calendar month — the running MTD figure the Overview rollup reads.
export const currentMonthSpend = (invoices: LinearInvoice[], now = new Date()): number => {
  const ym = currentMonthKey(now)

  return round2(invoices.filter((i) => (i.date ?? '').startsWith(ym)).reduce((sum, i) => sum + i.amount, 0))
}

// --- Summary tab (its spend.mtd summary is what the cross-service Overview rolls up) ---
// The billing.summary preset (account stat + monthly-spend chart + spend.mtd summary), plus plan /
// latest-invoice / invoice-count stats. currentMtd is the spend invoiced in the current month.
export const buildLinearSummaryResult = (report: LinearBillingReport): CapabilityResult => {
  const currentMtd = currentMonthSpend(report.invoices)

  return billing.summary({
    currentMtd,
    // Spend invoiced in the current calendar month.
    mtdBasis: 'invoiced',
    plan: report.plan,
    invoices: report.invoices,
    stats: [
      { key: 'latest', label: 'Latest invoice', role: 'money', value: report.latestAmount },
      { key: 'invoiceCount', label: 'Invoices', role: 'count', value: report.invoices.length }
    ]
  })
}

// --- Billing tab (renders via the generic renderer; emits no summary, so it's NOT the Overview rollup) ---
// The full invoice history as a downloadable table (each row downloads the Stripe invoice PDF; the visible
// link opens the hosted invoice page), plus the payment method, billing contact, and tax id as a keyvalue record.

interface LinearInvoiceRow {
  date: string | null
  amount: number
  status: string
  kind: string
  // The Stripe hosted invoice page — the clickable "View" link.
  url: string | null
  // Hidden — the Stripe PDF link (the download byte-source) + the download filename, declared not smuggled.
  pdfUrl: string | null
  name: string
}

interface LinearAccountRow {
  contact: string | null
  email: string | null
  card: string | null
  taxId: string | null
}

export const buildLinearBillingResult = (report: LinearBillingReport): CapabilityResult => {
  const { invoices } = report

  const invoiceHandle = table<LinearInvoiceRow>({
    id: 'invoices',
    columns: [
      { key: 'date', label: 'Date', role: 'timestamp' },
      { key: 'amount', label: 'Amount', role: 'money' },
      { key: 'status', label: 'Status', role: 'status' },
      { key: 'kind', label: 'Kind', role: 'label' },
      { key: 'url', label: 'Invoice', role: 'url' },
      { key: 'pdfUrl', role: 'url', hidden: true },
      { key: 'name', role: 'label', hidden: true }
    ],
    rows: invoices.map((i) => ({
      date: i.date ?? null,
      amount: i.amount,
      status: i.status,
      kind: i.kind,
      url: i.hostedUrl ?? null,
      pdfUrl: stripeInvoicePdfUrl(i.hostedUrl),
      name: `Invoice ${i.date ?? 'unknown'}`
    })),
    // Linear posts one subscription invoice per billing month (no invoice id in the payload) → the invoice
    // date is the stable unique identity, keyed so each invoice's status/amount accumulates in the ledger.
    key: 'date'
  })

  let accountSpec = null

  if (report.paymentMethod || report.billingContact || report.taxId) {
    const pm = report.paymentMethod
    const card = pm ? [pm.brand, pm.last4 ? `••${pm.last4}` : null].filter(Boolean).join(' ') || pm.type : null

    accountSpec = record<LinearAccountRow>({
      id: 'account',
      fields: [
        { key: 'contact', label: 'Billing contact', role: 'label' },
        { key: 'email', label: 'Email', role: 'label' },
        { key: 'card', label: 'Payment method', role: 'label' },
        { key: 'taxId', label: 'Tax ID', role: 'label' }
      ],
      value: {
        contact: report.billingContact?.name ?? null,
        email: report.billingContact?.email ?? null,
        card: card ?? null,
        taxId: report.taxId ?? null
      }
    })
  }

  return capabilityResult({
    sections: [
      invoiceHandle.fileTable({
        title: 'Invoices',
        name: 'name',
        source: { url: 'pdfUrl' },
        ext: 'pdf',
        category: 'Invoices'
      }),
      accountSpec?.keyvalue({ title: 'Billing account' })
    ]
  })
}

// --- Members tab ---
// Pure transform — fixture-tested. Maps the `users.nodes` roster onto MembersInput: role from the admin /
// guest flags (admin → 'admin', guest → 'guest', else 'member'), with suspended (inactive) members marked
// 'suspended' so they read as distinct. Members without an id are skipped (the id is the stable key).
const roleFor = (u: RawLinearUser): string => {
  if (u.active === false) {
    return 'suspended'
  }

  if (u.admin) {
    return 'admin'
  }

  if (u.guest) {
    return 'guest'
  }

  return 'member'
}

export const buildLinearMembers = (raw: RawUsersResponse | null | undefined): MembersInput => {
  const nodes = raw?.users?.nodes ?? []

  return {
    members: nodes
      .filter((u): u is RawLinearUser & { id: string } => Boolean(u.id))
      .map((u) => ({ id: u.id, name: u.name || undefined, email: u.email || undefined, role: roleFor(u) }))
  }
}

// ── fetch ──────────────────────────────────────────────────────────────────────────
// Summary + Billing both need the same two GraphQL operations; both reference this one fetch. The core query
// cache dedupes the underlying reads across the two runs. CachedBillingInvoices is best-effort — if it errors,
// buildLinearBilling falls back to the invoice page embedded in CachedBillingDetails.
const fetchLinearBilling = async (ctx: CollectContext): Promise<RawLinearBilling> => {
  const [details, invoiceList] = await Promise.all([
    ctx.client.graphql<RawBillingDetailsResponse>(GQL, { query: BILLING_DETAILS_QUERY }),
    ctx.client.graphql<RawBillingInvoicesResponse>(GQL, { query: BILLING_INVOICES_QUERY }).catch(() => null)
  ])

  return { details: details ?? null, invoiceList: invoiceList ?? null }
}

const fetchLinearMembers = async (ctx: CollectContext): Promise<RawUsersResponse> => {
  return (await ctx.client.graphql<RawUsersResponse>(GQL, { query: MEMBERS_QUERY })) ?? {}
}

// ── descriptor ──────────────────────────────────────────────────────────────────────
export const linearConfigSchema = defineConfigSchema([
  {
    key: 'organizationId',
    label: 'Organization ID',
    kind: 'text',
    help: 'Workspace id sent as the `organization` header. Auto-detected at sign-in; set it only to override.'
  },
  {
    key: 'userId',
    label: 'User ID',
    kind: 'text',
    help: 'Membership id sent as the `user` header. Auto-detected at sign-in; set it only to override.'
  }
])

export type LinearConfig = ConfigOf<typeof linearConfigSchema>

export const linearPlugin = definePlugin({
  reportingCurrency: 'USD',
  meta: {
    id: 'linear',
    name: 'Linear',
    vendor: 'Linear',
    category: 'devtools',
    color: '#5e6ad2',
    description: 'Linear subscription billing — invoice history, payment method, and tax details.',
    homepage: 'https://linear.app',
    dashboardUrl: 'https://linear.app/settings/billing'
  },
  session: {
    loginUrl: 'https://linear.app/login',
    dashboardMarkers: ['/team/', '/settings/', '/inbox', '/my-issues'],
    cookieDomains: ['linear.app'],
    // The workspace-scoping headers the SPA sends on its own client-api.linear.app requests — captured off
    // the wire at sign-in to prefill the config (useraccount is derived from the cookie, so it's not a field).
    captureFromHeader: [
      { header: 'organization', storeAs: 'organizationId', on: 'request' },
      { header: 'user', storeAs: 'userId', on: 'request' },
      { header: 'useraccount', storeAs: 'useraccount', on: 'request' }
    ]
  },
  auth: { kind: 'cookie-csrf', resolve: resolveLinearAuth },
  config: linearConfigSchema,
  // node client injects the browser UA + sec-ch-ua centrally; we add the same-origin (linear.app →
  // client-api.linear.app) Origin + same-site XHR markers — both forbidden on Electron net.request, which is
  // why this stays on node transport.
  transport: {
    defaultHeaders: {
      Accept: '*/*',
      Origin: 'https://linear.app',
      Referer: 'https://linear.app/',
      'Sec-Fetch-Site': 'same-site',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty'
    }
  },
  capabilities: [
    // Invoice PDFs aren't a separate documents tab — the Billing invoices table is downloadable (its url column).
    defineCapability({
      id: 'summary',
      label: 'Summary',
      fetch: fetchLinearBilling,
      build: (raw) => buildLinearSummaryResult(buildLinearBilling(raw.details, raw.invoiceList)),
      sample: sampleLinearBilling
    }),
    defineCapability({
      id: 'billing',
      label: 'Billing',
      fetch: fetchLinearBilling,
      build: (raw) => buildLinearBillingResult(buildLinearBilling(raw.details, raw.invoiceList)),
      sample: sampleLinearBilling
    }),
    defineCapability({
      id: 'members',
      label: 'Members',
      fetch: fetchLinearMembers,
      build: (raw) => members.result(buildLinearMembers(raw)),
      sample: sampleLinearMembers
    })
  ],
  probe: async (ctx) => {
    // CachedBillingDetails is the cheapest authed call — a 200 (no GraphQL errors) proves the session is live.
    await ctx.client.graphql(GQL, { query: BILLING_DETAILS_QUERY })
  }
})
