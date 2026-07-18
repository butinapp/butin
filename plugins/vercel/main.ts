import { defineCapability, defineConfigSchema, definePlugin, type CollectContext, type ConfigOf } from '@butinapp/sdk'
import { capabilityResult, record, table, type CapabilityResult, type MonthPoint } from '@butinapp/sdk/data'
import { members, type MembersInput } from '@butinapp/sdk/presets'
import { epochMsDay, isoDay, monthMinus, parseDecimalAmount, round2 } from '@butinapp/sdk/util'

import { sampleVercelData, sampleVercelMembers } from './sample.js'

// Vercel reads from vercel.com's internal dashboard "front API" (the `vercel.com/api/...` endpoints the
// dashboard SPA calls, not the public api.vercel.com REST API). Billing/invoices/members all live here and
// are served against the captured dashboard session cookie (the `authorization=Bearer vcp_…` cookie + jar),
// which the public personal-access token cannot reach. vercel.com is served by Vercel's own edge (not
// Cloudflare) so Node's TLS is accepted → axios (`node` transport). The dashboard XHR's browser header set
// (UA + sec-ch-ua + Sec-Fetch-Site: same-origin) is mirrored so the front API treats the request like the SPA.
//
// ALL Vercel money is in DOLLARS, never cents — `onDemandCharges`/`usage[].value` are plain dollar numbers,
// invoice/unit amounts are decimal strings ("540.00") — so there is NO /100 normalization here.
const ORIGIN = 'https://vercel.com'

// Fetch the most recent N invoices; the front API paginates with an opaque cursor we don't follow.
const INVOICE_LIMIT = 30

export const vercelConfigSchema = defineConfigSchema([
  {
    key: 'teamSlug',
    label: 'Team slug',
    kind: 'text',
    required: true,
    placeholder: 'your-team',
    help: 'The team identifier in your dashboard URL (vercel.com/<team>). The front API accepts it as teamId.'
  }
])

export type VercelConfig = ConfigOf<typeof vercelConfigSchema>

// The team slug (from the dashboard URL `vercel.com/<team>`) the front API accepts as `teamId`. Required —
// a Vercel session can belong to several teams and there's no reliable post-login URL to auto-extract it.
const resolveTeamSlug = (ctx: CollectContext<VercelConfig>): string => {
  const slug = ctx.config.teamSlug?.trim()

  if (!slug) {
    throw new Error('Set your Vercel team slug in Settings (the `<team>` in your vercel.com/<team> dashboard URL).')
  }

  return slug
}

const query = (params: Record<string, string | number>): string =>
  new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString()

// --- raw front-API shapes (only the fields we use) ---

interface RawPrice {
  type?: 'licensed' | 'metered'
  billableItemSlug?: string
  quantity?: number
  maxQuantity?: number
}

interface RawProduct {
  slug?: string
  prices?: RawPrice[]
}

interface RawBillingAddress {
  line1?: string
  line2?: string
  city?: string
  state?: string
  country?: string
  postalCode?: string
}

export interface RawSubscription {
  plan?: string
  account?: { billingName?: string; billingAddress?: RawBillingAddress; createdAt?: number; stripeCustomerId?: string }
  payment?: { status?: string; openInvoices?: unknown[] }
  products?: RawProduct[]
}

interface RawUsageProject {
  id?: string
  name?: string
  value?: number // dollars
  percent?: number // 0..1
}

export interface RawUsageSummary {
  data?: { onDemandCharges?: number; usage?: RawUsageProject[] }
  plan?: string
  cycle?: { start?: number; end?: number } // epoch ms
}

interface RawCard {
  brand?: string
  display_brand?: string
  last4?: string
  exp_month?: number
  exp_year?: number
}

interface RawPaymentSource {
  id?: string
  card?: RawCard
  billing_details?: { email?: string | null }
}

export interface RawPaymentMethods {
  defaultSource?: string
  sources?: RawPaymentSource[]
}

interface RawGroup {
  id?: string
  total?: string
}

interface RawInvoice {
  id?: string
  invoiceNumber?: string
  status?: string
  total?: string // dollar string
  createdAt?: string
  issuedAt?: string
  dueDate?: string | null
  pdfDownloadUrl?: string | null
  groups?: RawGroup[]
}

export interface RawInvoiceList {
  data?: RawInvoice[]
}

interface RawMember {
  uid?: string
  email?: string
  role?: string
  name?: string
  username?: string
}

export interface RawMembersList {
  members?: RawMember[]
}

// --- billing: subscription + current-period usage + payment method + invoice history ---
// `currentMtd` is the open cycle's accruing on-demand metered spend (`onDemandCharges`); null when the usage
// summary couldn't be fetched, so the Overview skips Vercel rather than showing a misleading 0. The
// enterprise licensed/committed base fee is NOT exposed as a dollar amount anywhere in the front API (licensed
// prices carry quantity only), so MTD reflects only the variable spend that actually accrues this cycle.

const formatAddress = (addr?: RawBillingAddress): string | null => {
  const parts = [addr?.line1, addr?.line2, addr?.city, addr?.state, addr?.postalCode, addr?.country].filter(
    (p): p is string => Boolean(p)
  )

  return parts.length ? parts.join(', ') : null
}

const pickPaymentMethod = (
  payment?: RawPaymentMethods | null
): { brand: string; last4: string | null; expiry: string | null; email: string | null } | null => {
  const sources = payment?.sources ?? []

  if (!sources.length) {
    return null
  }

  const def = sources.find((s) => s.id === payment?.defaultSource) ?? sources[0]
  const card = def.card

  if (!card) {
    return null
  }

  return {
    brand: card.display_brand ?? card.brand ?? 'card',
    last4: card.last4 ?? null,
    expiry: card.exp_month && card.exp_year ? `${String(card.exp_month).padStart(2, '0')}/${card.exp_year}` : null,
    email: def.billing_details?.email ?? null
  }
}

export interface VercelLicensedItem {
  slug: string
  quantity: number
  maxQuantity: number | null
}

// Split products into licensed line items (seats + entitlements) and pull out the teamSeats count.
const buildLicensedItems = (subscription: RawSubscription): { items: VercelLicensedItem[]; teamSeats: number } => {
  const items: VercelLicensedItem[] = []
  let teamSeats = 0

  for (const product of subscription.products ?? []) {
    for (const price of product.prices ?? []) {
      if (price.type !== 'licensed') {
        continue
      }

      const slug = price.billableItemSlug ?? product.slug ?? 'unknown'
      const quantity = price.quantity ?? 0

      items.push({ slug, quantity, maxQuantity: price.maxQuantity ?? null })

      if (slug === 'teamSeats') {
        teamSeats = quantity
      }
    }
  }

  items.sort((a, b) => b.quantity - a.quantity || a.slug.localeCompare(b.slug))

  return { items, teamSeats }
}

export interface VercelBillingInputs {
  subscription: RawSubscription
  usage?: RawUsageSummary | null
  payment?: RawPaymentMethods | null
  invoices?: RawInvoiceList | null
}

// Bucket invoice totals (dollar strings) by calendar month → the monthly-spend series the Summary tab's
// chart + the cross-service Overview spark both read. Rounded once per month to avoid IEEE-754 drift.
export const buildMonthly = (invoices: RawInvoice[]): MonthPoint[] => {
  const byMonth = new Map<string, number>()

  for (const inv of invoices) {
    const issued = isoDay(inv.issuedAt) ?? isoDay(inv.createdAt) ?? isoDay(inv.dueDate)

    if (!issued) {
      continue
    }

    // Vercel issues each cycle's invoice at period close (early the following month), billing the prior month
    // in arrears, so bucket by the incurred month — one back from the issue date — so June's bill lands under
    // June and the open month is left for the live on-demand accrual (seeded via backfill).
    const month = monthMinus(issued, 1).slice(0, 7)

    byMonth.set(month, (byMonth.get(month) ?? 0) + parseDecimalAmount(inv.total))
  }

  return [...byMonth.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, amount]) => ({ month, amount: round2(amount) }))
}

// --- Summary tab (its spend.mtd summary is what the cross-service Overview rolls up) ---
// The headline: this-month on-demand spend, plan, team seats, the monthly-spend chart, and the top
// on-demand projects. `currentMtd` is null when the usage summary couldn't be fetched, so the Overview
// skips Vercel rather than reading a misleading 0. The enterprise licensed/committed base fee is NOT
// exposed as a dollar amount anywhere in the front API, so MTD reflects only the variable spend that accrues.

export interface VercelSummaryInputs {
  subscription: RawSubscription
  usage?: RawUsageSummary | null
  invoices?: RawInvoiceList | null
}

interface VercelAccountRow {
  currentMtd: number | null
  plan: string
  teamSeats: number
  invoiceCount: number | null
}

interface VercelTopProjectRow {
  name: string
  value: number
  percent: number
}

// Pure transform — fixture-tested. `percent` is the front API's raw 0..1 share (the renderer's percent
// role expects a fraction and formats it via Intl percent style).
export const buildVercelSummaryResult = (inputs: VercelSummaryInputs): CapabilityResult => {
  const { subscription, usage, invoices } = inputs
  const { teamSeats } = buildLicensedItems(subscription)
  const plan = subscription.plan ?? usage?.plan ?? 'unknown'
  const currentMtd = usage ? (usage.data?.onDemandCharges ?? 0) : null
  const monthly = buildMonthly(invoices?.data ?? [])
  // The invoice list is already fetched for the monthly chart, so its count is a free headline stat. null
  // (em-dash) when the list couldn't be fetched, rather than a misleading 0.
  const invoiceCount = invoices ? (invoices.data?.length ?? 0) : null

  const topProjects = (usage?.data?.usage ?? [])
    .map((p, i) => ({ name: p.name ?? `project-${i}`, value: p.value ?? 0, percent: p.percent ?? 0 }))
    .sort((a, b) => b.value - a.value)

  const account = record<VercelAccountRow>({
    id: 'account',
    fields: [
      { key: 'currentMtd', label: 'This month', role: 'money' },
      { key: 'plan', label: 'Plan', role: 'label' },
      { key: 'teamSeats', label: 'Team seats', role: 'count' },
      { key: 'invoiceCount', label: 'Invoices', role: 'count' }
    ],
    value: { currentMtd, plan, teamSeats, invoiceCount }
  })
  const monthlyTable = table<MonthPoint>({
    id: 'monthly',
    columns: [
      { key: 'month', label: 'Month', role: 'timestamp' },
      { key: 'amount', label: 'Spend', role: 'money' }
    ],
    // Key by month so the chart accumulates in the ledger — months below the fetched invoice window persist so
    // the accrual backfill has the full spend series. `rollup` makes each fetch authoritative for the range it
    // covers, so a re-dated bucket is corrected in place rather than leaving a stale orphan month.
    key: 'month',
    rollup: true,
    rows: monthly
  })
  const projects = topProjects.length
    ? table<VercelTopProjectRow>({
        id: 'topProjects',
        columns: [
          { key: 'name', label: 'Project', role: 'label' },
          { key: 'value', label: 'On-demand spend', role: 'money' },
          { key: 'percent', label: 'Share', role: 'percent' }
        ],
        rows: topProjects,
        // The project name is the stable identity (unique per project, always present via the per-index fallback),
        // so each project's on-demand spend accumulates in the ledger past the current fetch window.
        key: 'name'
      })
    : null

  return capabilityResult({
    sections: [
      account.stat(),
      // Spend bucketed per calendar month → monthly cadence.
      monthlyTable.timeseries({ x: 'month', y: 'amount', granularity: 'monthly', title: 'Monthly spend' }),
      projects?.table({ title: 'Top projects (on-demand)' })
    ],
    summaries:
      currentMtd != null
        ? [
            monthlyTable.summary({
              section: 'spend',
              label: 'This month',
              value: currentMtd,
              role: 'money',
              // On-demand metered charges accruing live this cycle (the licensed base fee isn't exposed by the API).
              basis: 'accrued',
              x: 'month',
              y: 'amount'
            })
          ]
        : undefined
  })
}

// --- Billing tab (renders via the generic renderer but is NOT the Overview rollup) ---
// The financial detail: the invoice history, account/billing identity, the payment card, and licensed
// line items. The two keyvalue panels (account details + payment method) are ordered adjacently so the
// renderer's 2-column grid pairs them side by side.

export interface VercelBillingInputs {
  subscription: RawSubscription
  usage?: RawUsageSummary | null
  payment?: RawPaymentMethods | null
  invoices?: RawInvoiceList | null
}

interface VercelInvoiceRow {
  // The invoice number — hidden, the ledger key so an invoice accumulates its status/amount past the fetch window.
  invoiceNumber: string
  date: string | null
  amount: number
  status: string
  pdfUrl: string | null
  // Hidden — carried for the download filename, declared not smuggled.
  name: string
}

interface VercelDetailsRow {
  billingName: string | null
  billingEmail: string | null
  address: string | null
  paymentStatus: string | null
  openInvoices: number
  customerSince: string | null
  cycle: string | null
}

interface VercelPaymentMethodRow {
  brand: string
  last4: string | null
  expiry: string | null
}

interface VercelLicensedRow {
  slug: string
  quantity: number
  maxQuantity: number | null
}

// Pure transform — fixture-tested.
export const buildVercelBillingResult = (inputs: VercelBillingInputs): CapabilityResult => {
  const { subscription, usage, payment, invoices } = inputs
  const { items: licensed } = buildLicensedItems(subscription)
  const pm = pickPaymentMethod(payment)
  const cycleStart = epochMsDay(usage?.cycle?.start)
  const cycleEnd = epochMsDay(usage?.cycle?.end)

  const invoicesTable = table<VercelInvoiceRow>({
    id: 'invoices',
    columns: [
      { key: 'date', label: 'Date', role: 'timestamp' },
      { key: 'amount', label: 'Amount', role: 'money' },
      { key: 'status', label: 'Status', role: 'status' },
      { key: 'pdfUrl', label: 'PDF', role: 'url' },
      { key: 'name', role: 'label', hidden: true },
      { key: 'invoiceNumber', role: 'identifier', hidden: true }
    ],
    rows: (invoices?.data ?? []).map((inv, i) => {
      const date = isoDay(inv.issuedAt) ?? isoDay(inv.createdAt) ?? isoDay(inv.dueDate) ?? null

      return {
        // The human invoice number is present on every invoice and unique; a per-row synthetic id backs the rare
        // gap so the key can never collapse to a shared constant (which would drop rows from the ledger projection).
        invoiceNumber: inv.invoiceNumber ?? `inv-${i}`,
        date,
        amount: parseDecimalAmount(inv.total),
        status: inv.status ?? 'unknown',
        pdfUrl: inv.pdfDownloadUrl ?? null,
        name: `Invoice ${inv.invoiceNumber ?? date ?? 'unknown'}`
      }
    }),
    key: 'invoiceNumber'
  })
  const details = record<VercelDetailsRow>({
    id: 'details',
    fields: [
      { key: 'billingName', label: 'Billing name', role: 'label' },
      { key: 'billingEmail', label: 'Billing email', role: 'identifier' },
      { key: 'address', label: 'Address', role: 'text' },
      { key: 'paymentStatus', label: 'Payment status', role: 'status' },
      { key: 'openInvoices', label: 'Open invoices', role: 'count' },
      // teamSeats is deliberately NOT here — it's a Summary headline stat + a row in the Licensed items
      // table below, so repeating it in this record would be the third copy.
      { key: 'customerSince', label: 'Customer since', role: 'timestamp' },
      { key: 'cycle', label: 'Current cycle', role: 'text' }
    ],
    value: {
      billingName: subscription.account?.billingName ?? null,
      billingEmail: pm?.email ?? null,
      address: formatAddress(subscription.account?.billingAddress),
      paymentStatus: subscription.payment?.status ?? null,
      openInvoices: subscription.payment?.openInvoices?.length ?? 0,
      customerSince: epochMsDay(subscription.account?.createdAt) ?? null,
      cycle: cycleStart && cycleEnd ? `${cycleStart} → ${cycleEnd}` : null
    }
  })
  const card = pm
    ? record<VercelPaymentMethodRow>({
        id: 'paymentMethod',
        fields: [
          { key: 'brand', label: 'Card', role: 'label' },
          { key: 'last4', label: 'Last 4', role: 'label' },
          { key: 'expiry', label: 'Expires', role: 'label' }
        ],
        value: { brand: pm.brand, last4: pm.last4, expiry: pm.expiry }
      })
    : null
  const licensedTable = licensed.length
    ? table<VercelLicensedRow>({
        id: 'licensed',
        columns: [
          { key: 'slug', label: 'Item', role: 'label' },
          { key: 'quantity', label: 'Quantity', role: 'count' },
          { key: 'maxQuantity', label: 'Max', role: 'count' }
        ],
        rows: licensed.map((l) => ({ slug: l.slug, quantity: l.quantity, maxQuantity: l.maxQuantity })),
        // Each licensed line is one billable item — its slug is the stable key.
        key: 'slug'
      })
    : null

  return capabilityResult({
    sections: [
      // The invoices table doubles as the downloadable invoice-PDF list: each row's `pdfUrl` is the file URL;
      // the host adds selection + Download all/selected + per-row Open + on-disk size. No separate documents tab.
      invoicesTable.fileTable({
        title: 'Invoices',
        name: 'name',
        source: { url: 'pdfUrl' },
        ext: 'pdf',
        category: 'Invoices'
      }),
      // The two keyvalue panels (account details + payment method) are adjacent so the renderer's 2-column
      // grid pairs them side by side.
      details.keyvalue({ title: 'Account' }),
      card?.keyvalue({ title: 'Payment method' }),
      licensedTable?.table({ title: 'Licensed items' })
    ]
  })
}

// The Summary and Billing tabs overlap heavily (both need subscription + usage + invoices; Billing also
// needs payment). Both collects call loadVercelData; the core query cache dedupes the underlying reads
// (keyed by team id via the call site). Subscription is load-bearing; the rest are best-effort (a failing
// one degrades its section rather than blanking the tab).
export interface VercelData {
  subscription: RawSubscription
  usage: RawUsageSummary | null
  payment: RawPaymentMethods | null
  invoices: RawInvoiceList | null
}

const loadVercelData = async (ctx: CollectContext, teamId: string): Promise<VercelData> => {
  const [subscription, usage, payment, invoices] = await Promise.all([
    ctx.client.get<RawSubscription>(`${ORIGIN}/api/v1/billing/subscription?${query({ business: 'vercel', teamId })}`),
    ctx.client.get<RawUsageSummary>(`${ORIGIN}/api/usage-summary?${query({ teamId })}`).catch(() => null),
    ctx.client
      .get<RawPaymentMethods>(`${ORIGIN}/api/stripe/sources/payment-method?${query({ teamId })}`)
      .catch(() => null),
    ctx.client
      .get<RawInvoiceList>(`${ORIGIN}/api/v1/invoices?${query({ limit: INVOICE_LIMIT, teamId })}`)
      .catch(() => null)
  ])

  return { subscription, usage, payment, invoices }
}

// Summary + Billing share one fetch of the data bundle; each build* selects the slice it renders.
const fetchVercelData = (ctx: CollectContext<VercelConfig>): Promise<VercelData> =>
  loadVercelData(ctx, resolveTeamSlug(ctx))

// --- members: the team roster (front-API `/api/v2/teams/<slug>/members`) ---
// Roles come back uppercase (OWNER / MEMBER / DEVELOPER / BILLING / …); the members preset renders role as a
// category badge whose hue the renderer assigns case-insensitively, so OWNER and owner share a color.

// Pure transform — fixture-tested.
export const buildVercelMembers = (raw: RawMembersList | undefined | null): MembersInput => ({
  members: (raw?.members ?? []).map((m) => ({
    id: m.uid ?? m.email ?? 'unknown',
    name: m.name || m.username || undefined,
    email: m.email,
    role: m.role
  }))
})

const fetchVercelMembers = (ctx: CollectContext<VercelConfig>): Promise<RawMembersList> =>
  ctx.client.get<RawMembersList>(`${ORIGIN}/api/v2/teams/${resolveTeamSlug(ctx)}/members?${query({ limit: 200 })}`)

// Invoice PDFs aren't a separate documents capability — the Billing invoices table is downloadable (its
// `pdfUrl` column carries the file URL; the host downloads via the shared engine). Below: the per-invoice
// infra/platform split (managed-infra vs devex group totals), exported + fixture-tested for a future view.
const groupTotal = (groups: RawGroup[] | undefined, id: string): number =>
  parseDecimalAmount(groups?.find((g) => g.id === id)?.total)

export const invoiceSplit = (inv: RawInvoice): { infra: number; platform: number } => ({
  infra: groupTotal(inv.groups, 'managed-infra'),
  platform: groupTotal(inv.groups, 'devex')
})

export const vercelPlugin = definePlugin({
  reportingCurrency: 'USD',
  meta: {
    id: 'vercel',
    name: 'Vercel',
    vendor: 'Vercel',
    category: 'devtools',
    color: '#000000',
    description: 'Vercel team billing, current-period spend, members, and invoice PDFs.',
    homepage: 'https://vercel.com',
    dashboardUrl: 'https://vercel.com/dashboard'
  },
  session: {
    loginUrl: 'https://vercel.com/dashboard',
    dashboardMarkers: ['/dashboard', '/~/settings'],
    cookieDomains: ['vercel.com'],
    // The dashboard bearer (authorization=Bearer vcp_…) lands a beat after the SPA routes to an authed page;
    // wait for it so capture doesn't grab only the pre-auth analytics cookies (the front API would then 401).
    requiredCookie: 'authorization'
  },
  auth: { kind: 'cookie' },
  // node client injects the browser UA + sec-ch-ua centrally; we add the SPA's same-origin XHR markers so
  // Vercel's front API treats us like the dashboard.
  transport: {
    defaultHeaders: {
      Accept: '*/*',
      Referer: 'https://vercel.com/',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty'
    }
  },
  config: vercelConfigSchema,
  capabilities: [
    defineCapability({
      id: 'summary',
      label: 'Summary',
      fetch: fetchVercelData,
      build: ({ subscription, usage, invoices }) => buildVercelSummaryResult({ subscription, usage, invoices }),
      sample: sampleVercelData
    }),
    defineCapability({
      id: 'billing',
      label: 'Billing',
      fetch: fetchVercelData,
      build: (raw) => buildVercelBillingResult(raw),
      sample: sampleVercelData
    }),
    defineCapability({
      id: 'members',
      label: 'Members',
      fetch: fetchVercelMembers,
      build: (raw) => members.result(buildVercelMembers(raw)),
      sample: sampleVercelMembers
    })
  ],
  probe: async (ctx) => {
    // The subscription endpoint is the cheapest authed front-API call — a 200 proves the dashboard cookie is live.
    const teamId = resolveTeamSlug(ctx)

    await ctx.client.get(`${ORIGIN}/api/v1/billing/subscription?${query({ business: 'vercel', teamId })}`)
  }
})
