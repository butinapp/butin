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
import { billing, members, usage, type BillingInvoiceInput, type MembersInput } from '@butinapp/sdk/presets'
import { centsToMajor, currentMonthKey, epochSecDay, round2, startCase } from '@butinapp/sdk/util'

import { sampleInfisicalBilling, sampleInfisicalMembers, sampleInfisicalUsage } from './sample.js'

// Infisical (app.infisical.com secret manager) — read-only billing + usage off the dashboard's own REST
// API. The billing routes `/organizations/<org>/{invoices,plan/billing,billing-details}` are gated to a
// user JWT (a machine-identity access token 403s even for an org admin), so this replays the dashboard
// session: the durable credential is the `jid` refresh cookie (HttpOnly, Path=/api, 90-day, org-scoped).
// Per fetch it's exchanged at POST /api/v1/auth/token for a ~10-day Bearer and a freshly rotated `jid`,
// then the rotated cookie is written back — Infisical rotates the refresh cookie on every mint, so skipping
// the write-back trips refresh-reuse detection on the next fetch. app.infisical.com is AWS-fronted (not
// Cloudflare), so plain Node axios is accepted.
const BASE_URL = 'https://app.infisical.com'

// ── types: Raw* wire shapes + normalized domain types (the data dictionary) ────────────

interface RawInvoice {
  id?: string
  _id?: string
  created?: number // unix seconds
  paid?: boolean
  number?: string
  invoice_pdf?: string // Stripe-hosted PDF
  total?: number // grand total, CENTS
}

interface RawPlanBilling {
  currentPeriodStart?: number // unix seconds
  currentPeriodEnd?: number // unix seconds
  interval?: string
  amount?: number // per-seat unit price, CENTS
  quantity?: number // billed seats (users + identities)
  users?: number
  identities?: number
}

interface RawPlanWrapper {
  plan?: { slug?: string; status?: string }
}

interface RawBillingDetails {
  email?: string
  name?: string
}

interface RawPaymentMethod {
  brand?: string
  funding?: string
  exp_month?: number
  exp_year?: number
  last4?: string
}

export interface InfisicalBillingInput {
  invoices: RawInvoice[]
  planBilling?: RawPlanBilling
  plan?: RawPlanWrapper
  billingDetails?: RawBillingDetails
  paymentMethods?: RawPaymentMethod[]
}

interface RawUsagePlan {
  plan?: {
    slug?: string
    status?: string
    membersUsed?: number
    identitiesUsed?: number
    workspacesUsed?: number
    memberLimit?: number | null
    auditLogsRetentionDays?: number
  }
}

// product-stats: each product group is a record of `<thing>Count` numbers.
type RawProductStats = Record<string, Record<string, number> | undefined>

interface RawPlanTableRow {
  name?: string
  allowed?: boolean
  used?: string // display string, e.g. "29" or "-"
}

interface RawPlanTable {
  rows?: RawPlanTableRow[]
}

export interface InfisicalUsageInput {
  plan?: RawUsagePlan
  productStats?: RawProductStats
  planTable?: RawPlanTable
}

// ── auth: rotating-refresh over the `jid` refresh cookie ────────────────────────────────
// The token response carries no body refresh token — the rotated `jid` arrives in Set-Cookie, so we read
// response headers via client.request (client.post only returns the body) and patch the stored cookie.

interface TokenResponse {
  token?: string
}

// Replace (or append) `name`'s value in a `Cookie:`-header string, preserving every other pair.
export const setCookieValue = (cookieStr: string, name: string, value: string): string => {
  const pairs = cookieStr.split(/;\s*/).filter(Boolean)
  let found = false

  const next = pairs.map((p) => {
    const eq = p.indexOf('=')
    const key = eq === -1 ? p : p.slice(0, eq)

    if (key === name) {
      found = true

      return `${name}=${value}`
    }

    return p
  })

  if (!found) {
    next.push(`${name}=${value}`)
  }

  return next.join('; ')
}

// Pull the rotated `jid` value out of a Set-Cookie header (a single string or an array of lines).
export const jidFromSetCookie = (setCookie: string | string[] | undefined): string | undefined => {
  const lines = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []

  for (const line of lines) {
    const m = /(?:^|,\s*)jid=([^;]+)/.exec(line)

    if (m) {
      return m[1]
    }
  }

  return undefined
}

// resolve(): exchange the durable `jid` refresh cookie for a ~10-day Bearer; persist the rotated `jid`
// back to creds. Never memoized (auth.kind === 'rotating-refresh'), so it runs every request — Infisical
// rotates the refresh cookie on every mint, so skipping the write-back breaks the next fetch.
export const resolveInfisicalToken = async ({ client, creds }: AuthContext): Promise<AuthAttachment> => {
  const cookie = creds.get('cookie')

  if (!cookie) {
    throw new Error('No Infisical dashboard session captured — sign in again.')
  }

  const res = await client.request<TokenResponse>({
    url: `${BASE_URL}/api/v1/auth/token`,
    method: 'POST',
    headers: { Cookie: cookie }
  })

  const token = res.data?.token

  if (!token) {
    throw new Error('[infisical] /auth/token returned no access token')
  }

  // Rotating refresh: the new `jid` lands in Set-Cookie — patch the stored cookie or the next mint fails.
  const newJid = jidFromSetCookie(res.headers['set-cookie'])
  const nextCookie = newJid ? setCookieValue(cookie, 'jid', newJid) : cookie

  if (newJid) {
    creds.set('cookie', nextCookie)
  }

  // Bearer authorizes; we also replay the (rotated) cookie verbatim — harmless and matches the dashboard XHR.
  return { headers: { Authorization: `Bearer ${token}` }, cookie: nextCookie }
}

// The org in every billing path. Auto-extracted from the dashboard URL at capture time (creds), overridable
// via config. Must be the org the captured `jid` is scoped to (a non-org `jid` mints a non-org token that
// 403s the org routes).
const orgIdOf = (ctx: CollectContext<InfisicalConfig>): string => {
  const id = ctx.config.organizationId?.trim() || ctx.creds.get('organizationId')

  if (!id) {
    throw new Error('Sign in to Infisical via Magic Login to capture your organization, or set it in Settings.')
  }

  return id
}

// ── billing: Stripe-backed invoice history + current subscription + contact + card ──────

export interface InfisicalSubscription {
  planSlug: string
  status: string
  interval: string
  unitAmount: number // per-seat, dollars
  quantity: number
  users: number
  identities: number
  monthlySubtotal: number // unitAmount * quantity, dollars
  currentPeriodStart?: string
  currentPeriodEnd?: string
}

export interface InfisicalInvoice extends BillingInvoiceInput {
  id: string
  number: string
}

export interface InfisicalBillingReport {
  subscription: InfisicalSubscription
  invoices: InfisicalInvoice[]
  contact: { name: string; email: string }
  paymentMethod: { brand: string; funding: string; last4: string; expMonth: number; expYear: number } | null
  currentMtd: number // invoice spend dated to the current calendar month, dollars
}

// Cents → USD dollars on both money endpoints; unix-seconds dates → day keys; invoices newest-first. The
// card list repeats the same card, so it's deduped to the first.
export const buildInfisicalBilling = (input: InfisicalBillingInput): InfisicalBillingReport => {
  const pb = input.planBilling
  const unitAmount = centsToMajor(pb?.amount)
  const quantity = pb?.quantity ?? 0

  const subscription: InfisicalSubscription = {
    planSlug: input.plan?.plan?.slug ?? 'unknown',
    status: input.plan?.plan?.status ?? 'unknown',
    interval: pb?.interval ?? 'month',
    unitAmount,
    quantity,
    users: pb?.users ?? 0,
    identities: pb?.identities ?? 0,
    monthlySubtotal: round2(unitAmount * quantity),
    currentPeriodStart: epochSecDay(pb?.currentPeriodStart),
    currentPeriodEnd: epochSecDay(pb?.currentPeriodEnd)
  }

  const invoices = (input.invoices ?? [])
    .map((inv): InfisicalInvoice => {
      const paid = inv.paid ?? false

      return {
        id: inv.id ?? inv._id ?? 'unknown',
        number: inv.number ?? '—',
        date: epochSecDay(inv.created),
        status: paid ? 'paid' : 'open',
        amount: centsToMajor(inv.total),
        pdfUrl: inv.invoice_pdf ?? null,
        hostedUrl: inv.invoice_pdf ?? null
      }
    })
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))

  const ym = currentMonthKey()
  const currentMtd = round2(invoices.filter((i) => i.date?.startsWith(ym)).reduce((sum, i) => sum + i.amount, 0))

  const card = (input.paymentMethods ?? [])[0]
  const paymentMethod = card
    ? {
        brand: card.brand ?? 'card',
        funding: card.funding ?? '',
        last4: card.last4 ?? '••••',
        expMonth: card.exp_month ?? 0,
        expYear: card.exp_year ?? 0
      }
    : null

  return {
    subscription,
    invoices,
    contact: { name: input.billingDetails?.name ?? 'unknown', email: input.billingDetails?.email ?? 'unknown' },
    paymentMethod,
    currentMtd
  }
}

// Summary (its spend.mtd is what the cross-service Overview rolls up): the headline account
// stat (MTD + plan + seat/subtotal stats) + the monthly-spend chart synthesized from the invoice history.
export const buildInfisicalSummary = (input: InfisicalBillingInput): CapabilityResult => {
  const { subscription, invoices, currentMtd } = buildInfisicalBilling(input)

  return billing.summary({
    currentMtd,
    // The recurring per-seat subtotal is the plan's monthly floor → baseFee. currentMtd is invoiced spend this
    // month (basis 'invoiced'), so there's no meaningful metered overage to split out.
    baseFee: subscription.monthlySubtotal,
    mtdBasis: 'invoiced',
    plan: subscription.planSlug,
    invoices,
    stats: [{ key: 'seats', label: 'Seats', role: 'count', value: subscription.quantity }]
  })
}

// The Billing tab: the subscription record, the downloadable invoice table (each row's Stripe PDF), the
// billing contact + the card on file. The headline + monthly chart live on Summary.

interface InfisicalSubscriptionRow {
  planSlug: string
  status: string
  unitAmount: number
  quantity: number
  users: number
  identities: number
  monthlySubtotal: number
  currentPeriodStart: string | null
  currentPeriodEnd: string | null
}

interface InfisicalContactRow {
  name: string
  email: string
}

interface InfisicalPaymentMethodRow {
  brand: string | null
  last4: string | null
  funding: string | null
  expiry: string | null
}

interface InfisicalInvoiceRow {
  date: string | null
  number: string
  amount: number
  status: string
  pdfUrl: string | null
  // Hidden — carried for the download filename, declared not smuggled.
  name: string
}

export const buildInfisicalBillingResult = (input: InfisicalBillingInput): CapabilityResult => {
  const { subscription, invoices, contact, paymentMethod } = buildInfisicalBilling(input)

  const subscriptionView = record<InfisicalSubscriptionRow>({
    id: 'subscription',
    fields: [
      { key: 'planSlug', label: 'Plan', role: 'label' },
      { key: 'status', label: 'Status', role: 'status' },
      { key: 'unitAmount', label: 'Per seat', role: 'money' },
      { key: 'quantity', label: 'Seats', role: 'count' },
      { key: 'users', label: 'Users', role: 'count' },
      { key: 'identities', label: 'Machine identities', role: 'count' },
      { key: 'monthlySubtotal', label: 'Subtotal', role: 'money' },
      { key: 'currentPeriodStart', label: 'Period start', role: 'timestamp' },
      { key: 'currentPeriodEnd', label: 'Period end', role: 'timestamp' }
    ],
    value: {
      planSlug: subscription.planSlug,
      status: subscription.status,
      unitAmount: subscription.unitAmount,
      quantity: subscription.quantity,
      users: subscription.users,
      identities: subscription.identities,
      monthlySubtotal: subscription.monthlySubtotal,
      currentPeriodStart: subscription.currentPeriodStart ?? null,
      currentPeriodEnd: subscription.currentPeriodEnd ?? null
    }
  })

  const contactView = record<InfisicalContactRow>({
    id: 'contact',
    fields: [
      { key: 'name', label: 'Name', role: 'label' },
      { key: 'email', label: 'Email', role: 'label' }
    ],
    value: { name: contact.name, email: contact.email }
  })

  const cardView = paymentMethod
    ? record<InfisicalPaymentMethodRow>({
        id: 'paymentMethod',
        fields: [
          { key: 'brand', label: 'Card', role: 'label' },
          { key: 'last4', label: 'Last 4', role: 'label' },
          { key: 'funding', label: 'Type', role: 'label' },
          { key: 'expiry', label: 'Expires', role: 'label' }
        ],
        value: {
          brand: paymentMethod.brand,
          last4: paymentMethod.last4,
          funding: paymentMethod.funding || null,
          expiry: paymentMethod.expMonth ? `${paymentMethod.expMonth}/${paymentMethod.expYear}` : null
        }
      })
    : null

  // Compact context panels first; the long invoices table renders last.
  const invoicesView = table<InfisicalInvoiceRow>({
    id: 'invoices',
    columns: [
      { key: 'date', label: 'Date', role: 'timestamp' },
      { key: 'number', label: 'Number', role: 'identifier' },
      { key: 'amount', label: 'Amount', role: 'money' },
      { key: 'status', label: 'Status', role: 'status' },
      { key: 'pdfUrl', label: 'Invoice', role: 'url' },
      { key: 'name', role: 'label', hidden: true }
    ],
    rows: invoices.map((i) => ({
      date: i.date ?? null,
      number: i.number,
      amount: i.amount,
      status: i.status,
      pdfUrl: i.pdfUrl ?? null,
      name: `Invoice ${i.number}`
    }))
  })

  return capabilityResult({
    sections: [
      subscriptionView.keyvalue({ title: 'Subscription' }),
      contactView.keyvalue({ title: 'Billing contact' }),
      cardView?.keyvalue({ title: 'Payment method' }),
      invoicesView.fileTable({
        title: 'Invoices',
        name: 'name',
        source: { url: 'pdfUrl' },
        ext: 'pdf',
        category: 'Invoices'
      })
    ]
  })
}

// Summary + Billing both read the same core routes (invoices + plan/billing + plan) plus the peripheral
// contact/card. Both collects call loadInfisicalBilling; the core query cache dedupes the underlying reads
// (keyed by org id via the call site). The peripheral calls degrade independently: a single 403 there must
// not blank the tab.
const loadInfisicalBilling = async (
  ctx: CollectContext<InfisicalConfig>,
  org: string
): Promise<InfisicalBillingInput> => {
  const api = `${BASE_URL}/api/v1/organizations/${org}`
  const [invoices, planBilling, plan, billingDetails, paymentMethods] = await Promise.all([
    ctx.client.get<RawInvoice[]>(`${api}/invoices`).catch(() => []),
    ctx.client.get<RawPlanBilling>(`${api}/plan/billing`).catch(() => undefined),
    ctx.client.get<RawPlanWrapper>(`${api}/plan`).catch(() => undefined),
    ctx.client.get<RawBillingDetails>(`${api}/billing-details`).catch(() => undefined),
    ctx.client.get<RawPaymentMethod[]>(`${api}/billing-details/payment-methods`).catch(() => undefined)
  ])

  return { invoices: invoices ?? [], planBilling, plan, billingDetails, paymentMethods }
}

const fetchInfisicalBilling = (ctx: CollectContext<InfisicalConfig>): Promise<InfisicalBillingInput> =>
  loadInfisicalBilling(ctx, orgIdOf(ctx))

// ── usage: seat consumption + per-product resource counts + the plan feature matrix ────

// product-stats group key → display name; everything else is camelCase-humanized.
const PRODUCT_LABELS: Record<string, string> = {
  secretManager: 'Secret Manager',
  certificateManager: 'Certificate Manager',
  kms: 'KMS',
  secretScanning: 'Secret Scanning',
  pam: 'PAM'
}

// `<thing>Count` → 'Thing' (drop the Count suffix, then title-case the camelCase head).
export const humanizeMetric = (field: string): string => startCase(field.replace(/Count$/, ''))

// Seats render as the usage metrics (members / identities / projects), per-product counts join into a
// resource table, and the plan feature/limit matrix into its own table.

interface InfisicalProductRow {
  product: string
  metric: string
  count: number
}

interface InfisicalFeatureRow {
  name: string
  allowed: string
  used: string
}

export const buildInfisicalUsage = (input: InfisicalUsageInput): CapabilityResult => {
  const plan = input.plan?.plan

  const result = usage.result({
    metrics: [
      { label: 'Members', value: plan?.membersUsed ?? 0, unit: 'seats', limit: plan?.memberLimit ?? null },
      { label: 'Machine identities', value: plan?.identitiesUsed ?? 0, unit: 'seats' },
      { label: 'Projects', value: plan?.workspacesUsed ?? 0, unit: 'projects' }
    ]
  })

  const productRows: InfisicalProductRow[] = []

  for (const [group, counts] of Object.entries(input.productStats ?? {})) {
    if (!counts) {
      continue
    }

    const product = PRODUCT_LABELS[group] ?? humanizeMetric(group)

    for (const [field, value] of Object.entries(counts)) {
      productRows.push({ product, metric: humanizeMetric(field), count: typeof value === 'number' ? value : 0 })
    }
  }

  if (productRows.length) {
    const products = table<InfisicalProductRow>({
      id: 'products',
      columns: [
        { key: 'product', label: 'Product', role: 'label' },
        { key: 'metric', label: 'Resource', role: 'label' },
        { key: 'count', label: 'Count', role: 'count' }
      ],
      rows: productRows
    })

    result.datasets.push(products.dataset)
    result.views = [...(result.views ?? []), products.table({ title: 'Resources' }).view]
  }

  const featureRows: InfisicalFeatureRow[] = (input.planTable?.rows ?? []).map((row) => ({
    name: row.name ?? 'unknown',
    allowed: row.allowed ? 'Yes' : 'No',
    used: row.used && row.used !== '-' ? row.used : '—'
  }))

  if (featureRows.length) {
    const features = table<InfisicalFeatureRow>({
      id: 'features',
      columns: [
        { key: 'name', label: 'Feature', role: 'label' },
        { key: 'allowed', label: 'Allowed', role: 'label' },
        { key: 'used', label: 'Used', role: 'label' }
      ],
      rows: featureRows
    })

    result.datasets.push(features.dataset)
    result.views = [...(result.views ?? []), features.table({ title: 'Plan limits' }).view]
  }

  return result
}

const fetchInfisicalUsage = async (ctx: CollectContext<InfisicalConfig>): Promise<InfisicalUsageInput> => {
  const org = orgIdOf(ctx)
  const api = `${BASE_URL}/api/v1`
  const [plan, productStats, planTable] = await Promise.all([
    ctx.client.get<RawUsagePlan>(`${api}/organizations/${org}/plan`).catch(() => undefined),
    // product-stats has no org in the path — it reads the token context.
    ctx.client.get<RawProductStats>(`${api}/organization/product-stats`).catch(() => undefined),
    ctx.client.get<RawPlanTable>(`${api}/organizations/${org}/plan/table`).catch(() => undefined)
  ])

  return { plan, productStats, planTable }
}

// ── members: org roster off the same user-JWT org route family ──────────────────────────
// GET /api/v2/organizations/<org>/memberships → { users: [...] }. The membership nests the person under
// `user: { id, firstName, lastName, email }` with the org `role` at the top level. Same org route family
// as the billing routes above, so it's reachable with the very same minted user JWT.

interface RawMembership {
  id?: string
  role?: string
  user?: {
    id?: string
    firstName?: string | null
    lastName?: string | null
    email?: string | null
  } | null
}

export interface RawMemberships {
  users?: RawMembership[]
}

// One membership → one MemberInput (id = membership id, name = joined first/last, email, role). Memberships
// with no usable id/email are dropped.
export const buildInfisicalMembers = (raw: RawMemberships | undefined): MembersInput => {
  const members = (raw?.users ?? [])
    .map((m) => {
      const first = m.user?.firstName ?? ''
      const last = m.user?.lastName ?? ''
      const name = [first, last].filter(Boolean).join(' ').trim()

      return {
        id: m.id ?? m.user?.id ?? '',
        name: name || undefined,
        email: m.user?.email ?? undefined,
        role: m.role ?? undefined
      }
    })
    .filter((m) => m.id !== '' || m.email !== undefined)

  return { members }
}

const fetchInfisicalMembers = (ctx: CollectContext<InfisicalConfig>): Promise<RawMemberships> =>
  ctx.client.get<RawMemberships>(`${BASE_URL}/api/v2/organizations/${orgIdOf(ctx)}/memberships`)

export const buildInfisicalMembersResult = (raw: RawMemberships | undefined): CapabilityResult =>
  members.result(buildInfisicalMembers(raw))

// ── descriptor ──────────────────────────────────────────────────────────────────────
export const infisicalConfigSchema = defineConfigSchema([
  {
    key: 'organizationId',
    label: 'Organization ID',
    kind: 'text',
    help: 'Auto-filled from the dashboard URL when you sign in. Override only to read a different org (it must match the org you signed into).'
  }
])

export type InfisicalConfig = ConfigOf<typeof infisicalConfigSchema>

export const infisicalPlugin = definePlugin({
  reportingCurrency: 'USD',
  meta: {
    id: 'infisical',
    name: 'Infisical',
    vendor: 'Infisical',
    category: 'devtools',
    color: '#ffc700',
    description: 'Infisical billing, subscription, and resource usage.',
    homepage: 'https://infisical.com',
    dashboardUrl: 'https://app.infisical.com'
  },
  // Magic Login lands on the org-scoped billing page so SAML/SSO selects the org and the minted `jid` is
  // org-scoped (a non-org `jid` → non-org access token → 403 on the org billing routes).
  session: {
    loginUrl: 'https://app.infisical.com/login',
    dashboardMarkers: ['/organization', '/projects', '/billing'],
    cookieDomains: ['infisical.com'],
    requiredCookie: 'jid',
    // The org id is the UUID in the dashboard URL (/organizations/<uuid>/…) — capture it so the user needn't
    // paste it. It's the org the captured jid is scoped to, which is exactly what the billing routes need.
    captureFromUrl: [{ pattern: '/organizations/([0-9a-fA-F-]{36})', storeAs: 'organizationId' }]
  },
  // rotating-refresh: the `jid` refresh cookie mints a ~10-day Bearer per fetch and rotates itself; the
  // resolve() above writes the rotated cookie back. app.infisical.com is AWS-fronted → plain node axios.
  auth: { kind: 'rotating-refresh', resolve: resolveInfisicalToken },
  transport: {
    defaultHeaders: {
      Accept: 'application/json, text/plain, */*',
      Origin: BASE_URL,
      Referer: `${BASE_URL}/`,
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty'
    }
  },
  config: infisicalConfigSchema,
  capabilities: [
    // Summary + Billing share one billing fetch (the core query cache dedupes the underlying reads) and the
    // same synthetic bundle; each draws its own build off it.
    defineCapability({
      id: 'summary',
      label: 'Summary',
      fetch: fetchInfisicalBilling,
      build: buildInfisicalSummary,
      sample: sampleInfisicalBilling
    }),
    defineCapability({
      id: 'billing',
      label: 'Billing',
      fetch: fetchInfisicalBilling,
      build: buildInfisicalBillingResult,
      sample: sampleInfisicalBilling
    }),
    defineCapability({
      id: 'usage',
      label: 'Usage',
      fetch: fetchInfisicalUsage,
      build: buildInfisicalUsage,
      sample: sampleInfisicalUsage
    }),
    defineCapability({
      id: 'members',
      label: 'Members',
      fetch: fetchInfisicalMembers,
      build: buildInfisicalMembersResult,
      sample: sampleInfisicalMembers
    })
  ],
  probe: async (ctx) => {
    // /plan is the cheapest authed org route — a 200 proves the rotating-refresh mint produced a valid
    // user Bearer (and wrote the rotated `jid` back) without pulling the whole invoice history.
    await ctx.client.get(`${BASE_URL}/api/v1/organizations/${orgIdOf(ctx)}/plan`)
  }
})
