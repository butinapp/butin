import { defineCapability, defineConfigSchema, definePlugin, type CollectContext, type ConfigOf } from '@butinapp/sdk'
import { capabilityResult, record, table, type CapabilityResult } from '@butinapp/sdk/data'
import {
  billing,
  usage,
  type BillingInvoiceInput,
  type BillingStat,
  type UsageMetricInput
} from '@butinapp/sdk/presets'
import { dayMinus, isoDay, monthStart, parseDecimalAmount, round2, utcDaysAgo } from '@butinapp/sdk/util'

import {
  Q_BILLING_ADDRESS,
  Q_BILLING_INSIGHTS,
  Q_BILLING_SUMMARY,
  Q_CREDITS,
  Q_DAILY_SPEND,
  Q_FACET_USAGE,
  Q_HISTORY,
  Q_INVOICE,
  Q_PAYMENT_METHODS,
  Q_PRODUCT_LIMITS,
  Q_TAX_STATUS,
  Q_TEAM,
  type SafelistedQuery
} from './queries.js'
import { sampleDigitalOceanBilling, sampleDigitalOceanUsage } from './sample.js'

// DigitalOcean's cloud control panel (cloud.digitalocean.com). Three read-only tabs over one cookie session:
//   1. Summary — the running month-to-date usage, the pace/projection DigitalOcean itself computes, and the
//      monthly-spend trend the cross-service Overview rolls up (spend.mtd).
//   2. Billing — the current (still-open) invoice's totals + its per-product charge breakdown, the billing
//      account (payment method, address, tax, credits), and the downloadable invoice/receipt history.
//   3. Usage — per-product resource usage against the team's account limits, plus the month's spend curve.
// Summary + Billing share one billing fetch (the query cache dedupes it).
//
// TRANSPORT: the panel is a React SPA over a single Rails-backed GraphQL endpoint. Its XHRs are same-origin and
// carry `Origin` + `Sec-Fetch-*`, both forbidden on Electron net.request — so this runs on node axios. The edge is
// Cloudflare but serves the API dynamically to a plain client (only a `__cf_bm` bot-management cookie, no
// challenge), so Node's TLS identity is accepted.
//
// AUTH is the Rails session cookie `_digitalocean2_session_v4` (HttpOnly), replayed verbatim. The reads are all
// queries, so the browser's CSRF token is not required.
//
// The endpoint SAFELISTS documents: a query it does not recognize is rejected with `PERSISTED_QUERY_NOT_FOUND`,
// so every read posts one of the panel's own documents verbatim (queries.ts) under the operation name and
// `apollographql-client-name` it was registered with.
//
// TEAM SCOPE rides on a `?i=<team id>` param the panel puts on every call. That id is the leading slice of the
// team uuid; Magic Login lifts it out of the settled dashboard URL into the `teamId` setting, so an account with
// one team needs no configuration and a multi-team account picks in Settings.

// ── constants ───────────────────────────────────────────────────────────────────────

const ORIGIN = 'https://cloud.digitalocean.com'
const GRAPHQL = `${ORIGIN}/graphql`
const HISTORY_PAGE_SIZE = 100
// A guard on the history walk, not an expected depth — 100 rows a page covers years of monthly invoices.
const HISTORY_MAX_PAGES = 20
const BYTES_PER_GIB = 1024 ** 3

// The account limits the panel meters. Each entry is one `{ product: FACET }` pair in the limits request and one
// row on the Usage tab; a facet DigitalOcean reports in bytes renders in GiB.
export const FACETS: { product: string; facet: string; label: string; unit?: string }[] = [
  { product: 'droplet', facet: 'DROPLET_COUNT', label: 'Droplets' },
  { product: 'droplet', facet: 'GPU_COUNT', label: 'GPUs' },
  { product: 'dbaas', facet: 'DBAAS_CLUSTER_COUNT', label: 'Database clusters' },
  { product: 'volume', facet: 'VOLUME_COUNT', label: 'Block-storage volumes' },
  { product: 'volume', facet: 'VOLUME_GLOBAL_CAPACITY_BYTES', label: 'Block-storage capacity', unit: 'GiB' },
  { product: 'lbaas', facet: 'LBAAS_GLOBAL_COUNT', label: 'Load balancers' },
  { product: 'domain', facet: 'DOMAIN_COUNT', label: 'Domains' },
  { product: 'floating_ip', facet: 'FLOATING_IP_COUNT', label: 'Reserved IPs' },
  { product: 'floating_ip', facet: 'FLOATING_IP_RESERVED_IP_V6_COUNT', label: 'Reserved IPv6 addresses' },
  { product: 'nfs', facet: 'NFS_SHARE_COUNT', label: 'NFS shares' },
  { product: 'autoscale_pool', facet: 'AUTOSCALE_POOL_COUNT', label: 'Autoscale pools' },
  { product: 'genai', facet: 'GEN_AI_AGENT_COUNT', label: 'GenAI agents' },
  { product: 'genai', facet: 'GEN_AI_KNOWLEDGE_BASE_COUNT', label: 'GenAI knowledge bases' },
  { product: 'genai', facet: 'GEN_AI_GUARDRAIL_COUNT', label: 'GenAI guardrails' },
  { product: 'dedicated_inference', facet: 'DEDICATED_INFERENCE_ENDPOINT_COUNT', label: 'Inference endpoints' },
  { product: 'hosted_agents', facet: 'HOSTED_AGENTS_SESSION_COUNT', label: 'Hosted agent sessions' }
]

// ── types ─────────────────────────────────────────────────────────────────────────
// Money crosses the wire as a decimal STRING in USD ('250.00', '-250.00'); the invoice summary formats its own
// ('$250.00'). Both normalize to major units at the edge — no cents anywhere.

export type RawMe = {
  current_context?: { uuid?: string | null; name?: string | null; subject_role?: { name?: string | null } | null }
}

export type RawBillingSummary = {
  payment_due_date?: string | null
  total_usage_amount?: string | null
  past_due_amount?: string | null
  estimated_due?: string | null
}

export type RawBillingInsights = {
  current_mtd_spend?: string | null
  projected_month_spend?: string | null
  daily_average_spend?: string | null
}

export type RawBillingHistoryEntry = {
  description?: string | null
  amount?: string | null
  date?: string | null
  type?: string | null
  invoice_uuid?: string | null
  receipt_id?: string | null
  account_urn?: string | null
}

// One line of the invoice summary — a product category, one of its resources, or a totals row. `amount` is
// pre-formatted ('$250.00'); `sub_items` nests down to a resource's individual charges.
export type RawDisplayEntry = {
  type?: string | null
  description?: string | null
  extra_detail?: string | null
  amount?: string | null
  sub_items?: RawDisplayEntry[] | null
}

export type RawInvoice = {
  billing_start?: string | null
  issue_date?: string | null
  invoice_generated_at?: string | null
  usage_items?: RawDisplayEntry[] | null
  subtotal?: RawDisplayEntry | null
  discounts?: RawDisplayEntry | null
  credits?: RawDisplayEntry | null
  taxes?: RawDisplayEntry | null
  total?: RawDisplayEntry | null
}

export type RawPaymentMethod = {
  id?: string | null
  description?: string | null
  type?: string | null
  expiration_date?: string | null
  is_default?: boolean | null
}

export type RawBillingAddress = {
  address_line1?: string | null
  address_line2?: string | null
  city?: string | null
  region?: string | null
  country_iso2_code?: string | null
  postal_code?: string | null
}

export type RawTaxStatus = {
  tax_name?: string | null
  tax_rate?: string | null
  tax_location_name?: string | null
}

export type RawFacetUsage = { facet?: string | null; usage?: string | null; error?: string | null }

export type RawFacetLimit = { facet?: string | null; limit?: string | null }

export type RawDailySpend = { date?: string | null; amount?: string | null }

// The signed-in team. `urn` ('do:team:<uuid>') addresses the customer in the invoice/receipt PDF paths.
export type DigitalOceanTeam = {
  uuid: string
  urn: string
  name: string | null
  role: string | null
}

// Everything the Summary + Billing tabs read, in one fetch. The secondary panels are best-effort: a service that
// drops one of them must not blank the tab.
export type RawDigitalOceanBilling = {
  team: DigitalOceanTeam
  summary: RawBillingSummary | null
  insights: RawBillingInsights | null
  credits: string | null
  history: RawBillingHistoryEntry[]
  invoice: RawInvoice | null
  paymentMethods: RawPaymentMethod[]
  address: RawBillingAddress | null
  tax: RawTaxStatus | null
}

export type RawDigitalOceanUsage = {
  facetUsage: RawFacetUsage[]
  limits: RawFacetLimit[]
  daily: RawDailySpend[]
}

// One settled row of the billing history — an issued invoice or a card payment (payments are negative).
export type DigitalOceanHistoryEntry = {
  id: string
  date: string | null
  description: string
  type: string
  amount: number
  pdfUrl: string | null
}

// ── shared: the GraphQL call + the team it runs against ──────────────────────────────

// Post one safelisted document under the identity it was registered with. The client unwraps `data` and raises on
// a GraphQL error, so a collector only ever sees a payload.
const gql = <T>(
  ctx: CollectContext<DigitalOceanConfig>,
  url: string,
  query: SafelistedQuery,
  variables: Record<string, unknown> = {}
): Promise<T> =>
  ctx.client.graphql<T>(url, {
    operationName: query.operationName,
    query: query.document,
    variables,
    headers: { 'apollographql-client-name': query.client }
  })

// The team-scoped GraphQL URL every read goes through. The id comes from Settings, which Magic Login prefills
// from the dashboard URL — so this only ever asks when the capture missed it.
const teamUrl = (ctx: CollectContext<DigitalOceanConfig>): string => {
  const id = ctx.config.teamId?.trim()

  if (!id) {
    throw new Error('digitalocean: set the Team ID in Settings — the `i=` value in your cloud.digitalocean.com URL.')
  }

  return `${GRAPHQL}?i=${encodeURIComponent(id)}`
}

const resolveTeam = async (ctx: CollectContext<DigitalOceanConfig>, url: string): Promise<DigitalOceanTeam> => {
  const { getMe } = await gql<{ getMe: RawMe | null }>(ctx, url, Q_TEAM)
  const context = getMe?.current_context

  if (!context?.uuid) {
    throw new Error('digitalocean: the session has no active team — reconnect the session.')
  }

  return {
    uuid: context.uuid,
    urn: `do:team:${context.uuid}`,
    name: context.name ?? null,
    role: context.subject_role?.name ?? null
  }
}

// ── Summary + Billing: the shared billing fetch ──────────────────────────────────────

const fetchBillingHistory = async (
  ctx: CollectContext<DigitalOceanConfig>,
  url: string
): Promise<RawBillingHistoryEntry[]> => {
  const rows: RawBillingHistoryEntry[] = []

  for (let page = 1; page <= HISTORY_MAX_PAGES; page++) {
    const res = await gql<{
      listBillingHistory: { billing_history?: RawBillingHistoryEntry[] | null; meta?: { total?: number | null } | null }
    }>(ctx, url, Q_HISTORY, { listBillingHistoryRequest: { page, per_page: HISTORY_PAGE_SIZE } })
    const batch = res.listBillingHistory?.billing_history ?? []

    rows.push(...batch)

    if (batch.length === 0 || rows.length >= (res.listBillingHistory?.meta?.total ?? rows.length)) {
      break
    }
  }

  return rows
}

const fetchDigitalOceanBilling = async (ctx: CollectContext<DigitalOceanConfig>): Promise<RawDigitalOceanBilling> => {
  const url = teamUrl(ctx)
  const [team, summary, history, insights, credits, invoice, paymentMethods, address, tax] = await Promise.all([
    resolveTeam(ctx, url),
    gql<{ getBillingSummary: RawBillingSummary | null }>(ctx, url, Q_BILLING_SUMMARY).then((d) => d.getBillingSummary),
    fetchBillingHistory(ctx, url),
    gql<{ getBillingInsightsSummary: RawBillingInsights | null }>(ctx, url, Q_BILLING_INSIGHTS)
      .then((d) => d.getBillingInsightsSummary)
      .catch(() => null),
    gql<{ getBillingCreditsPublic: { available_amount?: string | null } | null }>(ctx, url, Q_CREDITS)
      .then((d) => d.getBillingCreditsPublic?.available_amount ?? null)
      .catch(() => null),
    gql<{ getInvoiceCloudSummary: RawInvoice | null }>(ctx, url, Q_INVOICE, {
      getInvoiceCloudSummaryRequest: { invoice_uuid: 'preview' }
    })
      .then((d) => d.getInvoiceCloudSummary)
      .catch(() => null),
    gql<{ listPaymentMethods: { payment_methods?: RawPaymentMethod[] | null } | null }>(ctx, url, Q_PAYMENT_METHODS)
      .then((d) => d.listPaymentMethods?.payment_methods ?? [])
      .catch(() => []),
    gql<{ getBillingAddress: { billing_address?: RawBillingAddress | null } | null }>(ctx, url, Q_BILLING_ADDRESS)
      .then((d) => d.getBillingAddress?.billing_address ?? null)
      .catch(() => null),
    gql<{ getTaxStatus: RawTaxStatus | null }>(ctx, url, Q_TAX_STATUS)
      .then((d) => d.getTaxStatus)
      .catch(() => null)
  ])

  return { team, summary, insights, credits, history, invoice, paymentMethods, address, tax }
}

// ── billing transforms (pure, fixture-tested) ────────────────────────────────────────

// Money to major units, whichever nullable string form the wire used — the plain decimal the billing endpoints
// send, or the invoice summary's own pre-formatted one. Absent → 0.
const usd = (value?: string | null): number => parseDecimalAmount(value ?? undefined)

// The path each history row's document hangs off: an issued invoice by uuid, a card payment by receipt id.
const historyPdfUrl = (raw: RawBillingHistoryEntry, teamUrn: string): string | null => {
  const urn = raw.account_urn ?? teamUrn

  if (!urn) {
    return null
  }

  if (raw.invoice_uuid) {
    return `${ORIGIN}/v2/customers/${urn}/invoices/${raw.invoice_uuid}/pdf`
  }

  return raw.receipt_id ? `${ORIGIN}/v2/customers/${urn}/payment_receipt/${raw.receipt_id}/pdf` : null
}

// Normalize the billing history to major units, newest first. Rows with no document of their own still list —
// the table is the account's ledger, and only the downloadable ones carry a URL.
export const buildDigitalOceanHistory = (
  raw: RawBillingHistoryEntry[] | null | undefined,
  teamUrn: string
): DigitalOceanHistoryEntry[] =>
  (raw ?? [])
    .map((r) => {
      const date = isoDay(r.date) ?? null
      const amount = usd(r.amount)

      return {
        id: r.invoice_uuid ?? r.receipt_id ?? `${date ?? 'undated'}:${amount}`,
        date,
        description: r.description ?? '',
        type: r.type ?? 'Other',
        amount,
        pdfUrl: historyPdfUrl(r, teamUrn)
      }
    })
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))

// The monthly-spend series both the Summary chart and the Overview read. DigitalOcean issues a month's invoice
// on the FIRST of the following month, so the issue date is stepped back a day onto the period the spend was
// incurred — otherwise every bar sits one month late. Payments are the same money flowing back out, so only
// invoices count.
export const invoicesForChart = (history: DigitalOceanHistoryEntry[]): BillingInvoiceInput[] =>
  history.flatMap((h) =>
    h.type === 'Invoice' && h.date ? [{ id: h.id, date: dayMinus(h.date, 1), amount: h.amount, status: 'issued' }] : []
  )

// Summary tab — the running month, the pace DigitalOcean projects from it, and the monthly trend. The invoice
// detail, the account panel and the history live on Billing.
export const buildDigitalOceanSummary = (raw: RawDigitalOceanBilling): CapabilityResult => {
  const pastDue = usd(raw.summary?.past_due_amount)
  const dueDate = isoDay(raw.summary?.payment_due_date)
  const stats: BillingStat[] = [
    {
      key: 'projected',
      label: 'Projected',
      role: 'money',
      value: usd(raw.insights?.projected_month_spend),
      caption: 'full month at the current pace'
    },
    {
      key: 'dailyAverage',
      label: 'Daily average',
      role: 'money',
      value: usd(raw.insights?.daily_average_spend),
      unit: '/day'
    },
    {
      key: 'estimatedDue',
      label: 'Estimated due',
      role: 'money',
      value: usd(raw.summary?.estimated_due),
      caption: dueDate ? `due ${dueDate}` : undefined
    }
  ]

  // An unpaid balance is the one figure worth its own card, and only while it exists.
  if (pastDue > 0) {
    stats.push({ key: 'pastDue', label: 'Past due', role: 'money', value: pastDue, tone: 'negative' })
  }

  return billing.summary({
    currentMtd: usd(raw.summary?.total_usage_amount ?? raw.insights?.current_mtd_spend),
    // Usage accrued since the billing month opened — the invoice for it is issued on the 1st.
    mtdBasis: 'accrued',
    invoices: invoicesForChart(buildDigitalOceanHistory(raw.history, raw.team.urn)),
    stats
  })
}

// Billing tab — the open invoice's totals and charges, the account panel, and the document history.

// The charges a category actually bills: an entry's leaves, so a nested resource (a database cluster's nodes)
// contributes its parts and never its own already-summed total.
const chargeLeaves = (entry: RawDisplayEntry): RawDisplayEntry[] =>
  entry.sub_items?.length ? entry.sub_items.flatMap(chargeLeaves) : [entry]

type InvoiceRow = {
  period: string | null
  generated: string | null
  subtotal: number | null
  discounts: number | null
  credits: number | null
  taxes: number | null
  total: number | null
}

type ChargeRow = {
  category: string
  items: number
  amount: number
}

type ChargeItemRow = {
  category: string
  description: string
  detail: string | null
  amount: number
}

type AccountRow = {
  team: string | null
  role: string | null
  paymentMethod: string | null
  expires: string | null
  address: string | null
  tax: string | null
  credits: number | null
}

type HistoryRow = {
  date: string | null
  description: string
  type: string
  amount: number
  pdfUrl: string | null
  // Hidden — the ledger identity, and the name each downloaded document is saved under.
  id: string
  name: string
}

const entryAmount = (entry: RawDisplayEntry | null | undefined): number | null =>
  entry?.amount == null ? null : usd(entry.amount)

const formatAddress = (address: RawBillingAddress | null): string | null => {
  const parts = [
    address?.address_line1,
    address?.address_line2,
    address?.city,
    address?.region,
    address?.postal_code,
    address?.country_iso2_code
  ].filter((p): p is string => !!p)

  return parts.length ? parts.join(', ') : null
}

const formatTax = (tax: RawTaxStatus | null): string | null => {
  if (!tax?.tax_name) {
    return null
  }

  const rate = tax.tax_rate ? ` ${tax.tax_rate}%` : ''

  return `${tax.tax_name}${rate}${tax.tax_location_name ? ` · ${tax.tax_location_name}` : ''}`
}

export const buildDigitalOceanBillingTab = (raw: RawDigitalOceanBilling): CapabilityResult => {
  const history = buildDigitalOceanHistory(raw.history, raw.team.urn)
  const items = raw.invoice?.usage_items ?? []

  const invoice = raw.invoice
    ? record<InvoiceRow>({
        id: 'invoice',
        fields: [
          { key: 'period', label: 'Period', role: 'text' },
          { key: 'generated', label: 'Generated', role: 'timestamp' },
          { key: 'subtotal', label: 'Subtotal', role: 'money' },
          { key: 'discounts', label: 'Discounts', role: 'money' },
          { key: 'credits', label: 'Credits', role: 'money' },
          { key: 'taxes', label: 'Taxes', role: 'money' },
          { key: 'total', label: 'Total', role: 'money' }
        ],
        value: {
          period: [raw.invoice.billing_start, raw.invoice.issue_date].filter(Boolean).join(' → ') || null,
          generated: isoDay(raw.invoice.invoice_generated_at) ?? null,
          subtotal: entryAmount(raw.invoice.subtotal),
          discounts: entryAmount(raw.invoice.discounts),
          credits: entryAmount(raw.invoice.credits),
          taxes: entryAmount(raw.invoice.taxes),
          total: entryAmount(raw.invoice.total)
        }
      })
    : null

  const chargeItems = table<ChargeItemRow>({
    id: 'chargeItems',
    columns: [
      { key: 'description', label: 'Resource', role: 'label', truncate: true },
      { key: 'detail', label: 'Detail', role: 'text' },
      { key: 'amount', label: 'Amount', role: 'money' },
      { key: 'category', role: 'label', hidden: true }
    ],
    rows: items.flatMap((cat) =>
      chargeLeaves(cat).map((leaf) => ({
        category: cat.type ?? cat.description ?? 'Other',
        description: leaf.description ?? '',
        detail: leaf.extra_detail ?? null,
        amount: usd(leaf.amount)
      }))
    ),
    key: ['category', 'description']
  })

  const charges = table<ChargeRow>({
    id: 'charges',
    columns: [
      { key: 'category', label: 'Product', role: 'label' },
      { key: 'items', label: 'Resources', role: 'count' },
      { key: 'amount', label: 'Amount', role: 'money' }
    ],
    rows: items.map((cat) => ({
      category: cat.type ?? cat.description ?? 'Other',
      items: chargeLeaves(cat).length,
      amount: usd(cat.amount)
    })),
    key: 'category'
  })

  const card = raw.paymentMethods.find((p) => p.is_default) ?? raw.paymentMethods[0]
  const account = record<AccountRow>({
    id: 'account',
    fields: [
      { key: 'team', label: 'Team', role: 'label' },
      { key: 'role', label: 'Your role', role: 'label' },
      { key: 'paymentMethod', label: 'Payment method', role: 'label' },
      { key: 'expires', label: 'Card expires', role: 'label' },
      { key: 'address', label: 'Billing address', role: 'text' },
      { key: 'tax', label: 'Tax', role: 'text' },
      { key: 'credits', label: 'Credit balance', role: 'money' }
    ],
    value: {
      team: raw.team.name,
      role: raw.team.role,
      paymentMethod: card?.description ?? null,
      expires: card?.expiration_date ?? null,
      address: formatAddress(raw.address),
      tax: formatTax(raw.tax),
      credits: raw.credits == null ? null : usd(raw.credits)
    }
  })

  const documents = table<HistoryRow>({
    id: 'history',
    columns: [
      { key: 'date', label: 'Date', role: 'timestamp' },
      { key: 'description', label: 'Description', role: 'label' },
      { key: 'type', label: 'Type', role: 'category' },
      { key: 'amount', label: 'Amount', role: 'money' },
      { key: 'pdfUrl', label: 'PDF', role: 'url' },
      { key: 'id', role: 'identifier', hidden: true },
      { key: 'name', role: 'label', hidden: true }
    ],
    rows: history.map((h) => ({
      date: h.date,
      description: h.description,
      type: h.type,
      amount: h.amount,
      pdfUrl: h.pdfUrl,
      id: h.id,
      name: `${h.type} ${h.date ?? h.id}`
    })),
    key: 'id'
  })

  return capabilityResult({
    sections: [
      invoice?.keyvalue({ title: 'Current invoice' }),
      charges.dataset.rows.length > 0
        ? charges.table({ title: 'Charges this period', detail: { rows: chargeItems, on: 'category' } })
        : null,
      account.keyvalue({ title: 'Billing account' }),
      documents.fileTable({
        title: 'Billing history',
        name: 'name',
        source: { url: 'pdfUrl' },
        ext: 'pdf',
        category: 'Invoices'
      })
    ]
  })
}

// ── Usage: resource limits + the month's spend curve ─────────────────────────────────

const fetchDigitalOceanUsage = async (ctx: CollectContext<DigitalOceanConfig>): Promise<RawDigitalOceanUsage> => {
  const url = teamUrl(ctx)
  // The usage and limit calls meter the same facet set — one request object, asked of both.
  const request = { facets: FACETS.map((f) => ({ [f.product]: f.facet })) }
  const [facetUsage, limits, daily] = await Promise.all([
    gql<{ GetProductFacetUsage: { productUsage?: RawFacetUsage[] | null } | null }>(ctx, url, Q_FACET_USAGE, {
      getProductFacetUsageRequest: request
    }).then((d) => d.GetProductFacetUsage?.productUsage ?? []),
    gql<{ GetProductLimits: { productLimits?: RawFacetLimit[] | null } | null }>(ctx, url, Q_PRODUCT_LIMITS, {
      getProductLimitsRequest: request
    })
      .then((d) => d.GetProductLimits?.productLimits ?? [])
      .catch(() => []),
    gql<{ getBillingDailySpend: { daily_spend?: RawDailySpend[] | null } | null }>(ctx, url, Q_DAILY_SPEND, {
      getBillingDailySpendRequest: { start_date: monthStart(), end_date: utcDaysAgo(0) }
    })
      .then((d) => d.getBillingDailySpend?.daily_spend ?? [])
      .catch(() => [])
  ])

  return { facetUsage, limits, daily }
}

const facetNumber = (value: string | null | undefined, divisor: number): number | null => {
  const n = Number(value)

  return value == null || !Number.isFinite(n) ? null : round2(n / divisor)
}

// Usage tab — each metered product against the team's account limit, plus the month's spend curve.
// DigitalOcean reports a facet it can't meter with an `error`, and a product the plan doesn't offer as 0 of 0;
// both are dropped so the table lists only what this account actually has a limit on.
export const buildDigitalOceanUsage = (raw: RawDigitalOceanUsage): CapabilityResult => {
  const usedByFacet = new Map((raw.facetUsage ?? []).filter((u) => !u.error && u.facet).map((u) => [u.facet, u.usage]))
  const limitByFacet = new Map((raw.limits ?? []).filter((l) => l.facet).map((l) => [l.facet, l.limit]))

  const metrics: UsageMetricInput[] = FACETS.flatMap((f) => {
    const divisor = f.unit === 'GiB' ? BYTES_PER_GIB : 1
    const value = facetNumber(usedByFacet.get(f.facet), divisor)
    const limit = facetNumber(limitByFacet.get(f.facet), divisor)

    if (value == null || (value === 0 && !limit)) {
      return []
    }

    return [{ label: f.label, value, unit: f.unit, limit }]
  })

  const daily = (raw.daily ?? [])
    .filter((d) => !!d.date)
    .map((d) => ({ date: d.date as string, cost: usd(d.amount) }))
    .sort((a, b) => a.date.localeCompare(b.date))

  return usage.result({
    periodStart: daily[0]?.date,
    periodEnd: daily.at(-1)?.date,
    metrics,
    daily,
    // The series is the billing month's running total, not each day's own charge.
    dailyTitle: 'Spend so far this month'
  })
}

// ── descriptor ──────────────────────────────────────────────────────────────────────

export const digitaloceanConfigSchema = defineConfigSchema([
  {
    key: 'teamId',
    label: 'Team ID',
    kind: 'text',
    required: true,
    placeholder: 'a1b2c3',
    help: 'The `i=` value in your cloud.digitalocean.com URL — the team every read is scoped to. Captured at sign-in.'
  }
])

export type DigitalOceanConfig = ConfigOf<typeof digitaloceanConfigSchema>

export const digitaloceanPlugin = definePlugin({
  reportingCurrency: 'USD',
  meta: {
    id: 'digitalocean',
    name: 'DigitalOcean',
    vendor: 'DigitalOcean',
    category: 'cloud',
    color: '#0069ff',
    description: 'DigitalOcean team billing — the open invoice, charge breakdown, resource limits, and invoice PDFs.',
    homepage: 'https://www.digitalocean.com',
    dashboardUrl: 'https://cloud.digitalocean.com/account/billing'
  },
  session: {
    loginUrl: `${ORIGIN}/login`,
    dashboardMarkers: ['/projects', '/dashboard', '/account/billing'],
    cookieDomains: ['digitalocean.com'],
    requiredCookie: '_digitalocean2_session_v4',
    // Google sign-in is omniauth, which stashes the OAuth `state` in the Rails `_digitalocean2_session_v4` cookie.
    // A stale one left in the partition poisons that state on the callback, so the handshake fails and the browser
    // lands back on the login page. Drop it at the start of each capture; the authed cookie the callback sets is
    // what gets captured.
    clearCookiesBeforeCapture: ['_digitalocean2_session_v4'],
    // The panel appends `?i=<team id>` once it has a session, so the settled dashboard URL carries the id every
    // read needs — lifted here so a single-team account never has to fill the setting in.
    captureFromUrl: [{ pattern: '[?&]i=([0-9a-z]+)', storeAs: 'teamId' }]
  },
  auth: { kind: 'cookie' },
  // node (axios): the panel's XHRs are same-origin and set Origin + Sec-Fetch-*, both forbidden on Electron
  // net.request. The node client injects the canonical UA + sec-ch-ua centrally.
  transport: {
    engine: 'node',
    defaultHeaders: {
      Accept: '*/*',
      Origin: ORIGIN,
      Referer: `${ORIGIN}/account/billing`,
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty'
    }
  },
  config: digitaloceanConfigSchema,
  capabilities: [
    defineCapability({
      id: 'summary',
      label: 'Summary',
      fetch: fetchDigitalOceanBilling,
      build: buildDigitalOceanSummary,
      sample: sampleDigitalOceanBilling
    }),
    defineCapability({
      id: 'billing',
      label: 'Billing',
      fetch: fetchDigitalOceanBilling,
      build: buildDigitalOceanBillingTab,
      sample: sampleDigitalOceanBilling
    }),
    defineCapability({
      id: 'usage',
      label: 'Usage',
      fetch: fetchDigitalOceanUsage,
      build: buildDigitalOceanUsage,
      sample: sampleDigitalOceanUsage
    })
  ],
  probe: async (ctx) => {
    // The team header is the cheapest authed read — it answering proves the session cookie is live.
    await resolveTeam(ctx, teamUrl(ctx))
  }
})
