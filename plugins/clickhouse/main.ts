import { defineCapability, defineConfigSchema, definePlugin, type CollectContext, type ConfigOf } from '@butinapp/sdk'
import { capabilityResult, record, table, type CapabilityResult } from '@butinapp/sdk/data'
import {
  billing,
  blocks,
  members,
  usage,
  type BillingStat,
  type MemberInput,
  type MembersInput,
  type UsageMetricInput
} from '@butinapp/sdk/presets'
import { epochMsDay, round2 } from '@butinapp/sdk/util'

import { sampleClickhouseBilling, sampleClickhouseOrg, sampleClickhouseUsage } from './sample.js'

// ClickHouse Cloud — read through the captured CONSOLE session (the Auth0 SPA), not a typed API key.
// The console SPA mints a short-lived (5-min) Bearer via Auth0 silent-renew off the durable
// `auth.clickhouse.cloud` session cookie, then calls its own control-plane RPC. That Bearer is never
// replayable headless, so this is a `spa-bearer` plugin: core boots the console offscreen, captures the
// Bearer off the control-plane XHRs, caches it, and re-mints on 401. The organization is auto-discovered
// from the session (no config needed); an optional override picks a specific org on multi-org accounts.
//
// Control-plane RPC: POST control-plane-internal.clickhouse.cloud/api/<service> with a JSON body
// `{ rpcAction, organizationId?, … }` sent as text/plain (mirroring the SPA). Four tabs over one session:
//   SUMMARY — the open bill period's accrued spend (the spend.mtd the Overview rolls up) + the monthly-spend
//             trend + a tight next-invoice / trial-credit / invoice-count stat row.
//   BILLING — the account record (card, next invoice, contact) + trial-credit balances + the downloadable
//             invoice history (real Stripe PDFs from `invoicePdfDownloadLink`).
//   USAGE   — the current bill period's metered consumption (compute hours, storage TB-months, data transfer)
//             with the on-demand cost per metric.
//   MEMBERS — the org roster (the session payload already carries it).
//
// MONEY: every console amount is already in DOLLARS (USD) — surfaced as-is (round only). Dates are epoch ms.

// ── constants ─────────────────────────────────────────────────────────────────────────

const CONTROL_PLANE = 'https://control-plane-internal.clickhouse.cloud'
const CONSOLE = 'https://console.clickhouse.cloud'

// ── config ──────────────────────────────────────────────────────────────────────────────
// The org is auto-discovered from the session; the one OPTIONAL field overrides it on multi-org accounts.
// `defineConfigSchema` is the single source of truth: the descriptor's `config` AND the `ClickhouseConfig` type
// `ctx.config` reads both derive from it (no parallel hand-written type).
export const clickhouseConfigSchema = defineConfigSchema([
  {
    key: 'organizationId',
    label: 'Organization ID',
    kind: 'text',
    required: false,
    placeholder: 'auto-detected',
    help: 'Optional. Leave blank to use the active organization; set a specific org UUID on multi-org accounts.'
  }
])

export type ClickhouseConfig = ConfigOf<typeof clickhouseConfigSchema>

// ── types ───────────────────────────────────────────────────────────────────────────────

// account / org roster (POST /api/account {rpcAction:'initializeUserSession'})
interface RawOrgUser {
  userId?: string
  name?: string
  email?: string
  role?: string
}

export interface RawOrg {
  id?: string
  name?: string
  tier?: string
  billingStatus?: string
  // Keyed by userId.
  users?: Record<string, RawOrgUser>
}

export interface RawAccount {
  organizations?: RawOrg[]
}

// billing details (POST /api/billing {rpcAction:'getOrganizationBillingDetails', organizationId})
interface RawInvoice {
  invoiceNumber?: string
  currency?: string
  amount?: number
  subtotal?: number
  status?: string
  invoicePdfDownloadLink?: string
  invoicePaymentLink?: string
  // Epoch ms.
  createdDate?: number
  periodStartDate?: number
  periodEndDate?: number
}

interface RawPaymentMethod {
  brand?: string
  last4?: string
  expMonth?: number
  expYear?: number
}

// One bill cycle's running/finalized total; the single `locked:false` statement is the open (current) period.
interface RawBillStatement {
  billNetTotal?: number
  billGrossTotal?: number
  // Epoch ms.
  periodStartDate?: number
  periodEndDate?: number
  locked?: boolean
}

interface RawCreditBalance {
  amountSpent?: number
  amountRemaining?: number
  amountTotal?: number
  creditType?: string
}

export interface RawBillingDetails {
  invoices?: RawInvoice[]
  paymentMethod?: RawPaymentMethod
  billUsageStatements?: RawBillStatement[]
  creditBalances?: RawCreditBalance[]
  billingContact?: string
  companyName?: string
  // Epoch ms.
  nextInvoiceDate?: number
}

// usage report (POST /api/billing {rpcAction:'getUsageReport', organizationId, usagePeriod:{type:'BILL_DATE'}})
interface RawMetric {
  metricValue?: number
  cost?: number
}

export interface RawUsageReport {
  report?: {
    startDate?: string
    endDateInclusive?: string
    totalUsageReport?: Record<string, RawMetric>
  }
}

// normalized billing report (USD dollars)
export interface ClickhouseInvoice {
  number: string
  // 'YYYY-MM-DD'.
  date?: string
  status: string
  amount: number
  pdfUrl?: string | null
  hostedUrl?: string | null
}

export interface ClickhouseMonthRow {
  // 'YYYY-MM'.
  month: string
  amount: number
}

export interface ClickhouseBillingReport {
  invoices: ClickhouseInvoice[]
  byMonth: ClickhouseMonthRow[]
  // The open (unlocked) bill period's accrued total — the live MTD. null when no open period.
  currentMtd: number | null
  // 'YYYY-MM-DD' next invoice date.
  nextInvoice?: string
  card?: { brand: string; last4: string; exp: string }
  contact?: string
  company?: string
  // Trial/granted credit, summed across balances.
  credit: { granted: number; used: number; remaining: number }
  currency: string
}

// ── shared: org resolution ────────────────────────────────────────────────────────────

// Pick the org to report on: an explicit config override by id, else the active one (a selected, paid org
// wins over an UNSELECTED pre-trial placeholder), else the first. Pure — fixture-tested.
export const pickOrganization = (account: RawAccount | undefined | null, overrideId?: string): RawOrg | undefined => {
  const orgs = account?.organizations ?? []

  if (overrideId) {
    return orgs.find((o) => o.id === overrideId) ?? orgs[0]
  }

  return orgs.find((o) => o.billingStatus === 'PAID') ?? orgs.find((o) => o.tier && o.tier !== 'UNSELECTED') ?? orgs[0]
}

// POST a control-plane RPC. The body is sent as text/plain (mirroring the SPA); spa-bearer attaches the
// Bearer and the transport defaults carry the console Origin/Referer.
const rpc = async <T>(
  ctx: CollectContext<ClickhouseConfig>,
  service: string,
  body: Record<string, unknown>
): Promise<T> =>
  (
    await ctx.client.request<T>({
      url: `${CONTROL_PLANE}/api/${service}`,
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' }
    })
  ).data

const resolveOrg = async (ctx: CollectContext<ClickhouseConfig>): Promise<RawOrg> => {
  const account = await rpc<RawAccount>(ctx, 'account', { rpcAction: 'initializeUserSession' })
  const org = pickOrganization(account, ctx.config.organizationId)

  if (!org?.id) {
    throw new Error('ClickHouse: no organization found on this session — re-run Magic Login for ClickHouse.')
  }

  return org
}

// ── billing ─────────────────────────────────────────────────────────────────────────────

// Pure transform — fixture-tested. Normalizes the console billing-details payload (already USD dollars) into
// invoices, the per-period spend trend, the open-period MTD, the card, and summed trial credit.
export const buildClickhouseBilling = (raw: RawBillingDetails | undefined | null): ClickhouseBillingReport => {
  const d = raw ?? {}

  const invoices: ClickhouseInvoice[] = (d.invoices ?? []).map((inv) => ({
    number: inv.invoiceNumber ?? '—',
    date: epochMsDay(inv.createdDate ?? inv.periodEndDate),
    status: inv.status ?? 'unknown',
    amount: round2(inv.amount ?? 0),
    pdfUrl: inv.invoicePdfDownloadLink ?? null,
    hostedUrl: inv.invoicePaymentLink ?? null
  }))

  const statements = d.billUsageStatements ?? []
  const byMonth: ClickhouseMonthRow[] = statements
    .map((s) => ({ month: (epochMsDay(s.periodStartDate) ?? '').slice(0, 7), amount: round2(s.billNetTotal ?? 0) }))
    .filter((m) => m.month)
    .sort((a, b) => a.month.localeCompare(b.month))

  const open = statements.find((s) => s.locked === false)
  const pm = d.paymentMethod
  const credit = (d.creditBalances ?? []).reduce(
    (acc, c) => ({
      granted: acc.granted + (c.amountTotal ?? 0),
      used: acc.used + (c.amountSpent ?? 0),
      remaining: acc.remaining + (c.amountRemaining ?? 0)
    }),
    { granted: 0, used: 0, remaining: 0 }
  )

  return {
    invoices,
    byMonth,
    currentMtd: open ? round2(open.billNetTotal ?? open.billGrossTotal ?? 0) : null,
    nextInvoice: epochMsDay(d.nextInvoiceDate),
    card:
      pm?.brand && pm.last4
        ? { brand: pm.brand, last4: pm.last4, exp: pm.expMonth && pm.expYear ? `${pm.expMonth}/${pm.expYear}` : '' }
        : undefined,
    contact: d.billingContact,
    company: d.companyName,
    credit: { granted: round2(credit.granted), used: round2(credit.used), remaining: round2(credit.remaining) },
    currency: d.invoices?.[0]?.currency ?? 'USD'
  }
}

// Summary tab — the open period's accrued spend (the spend.mtd rollup), the monthly-spend trend, and a tight
// next-invoice / trial-credit / invoice-count stat row. Fed synthetic one-per-period invoices so the chart
// bars are the real bill-cycle totals; mtdBasis 'accrued' (the open bill grows with usage through the period).
export const buildClickhouseSummaryResult = (r: ClickhouseBillingReport): CapabilityResult => {
  const stats: BillingStat[] = [
    { key: 'nextInvoice', label: 'Next invoice', role: 'timestamp', value: r.nextInvoice ?? null },
    { key: 'invoices', label: 'Invoices', role: 'count', value: r.invoices.length }
  ]

  if (r.credit.remaining > 0) {
    stats.splice(1, 0, {
      key: 'credit',
      label: 'Trial credit left',
      role: 'money',
      value: r.credit.remaining,
      currency: r.currency
    })
  }

  return billing.summary({
    currentMtd: r.currentMtd,
    currentMtdLabel: 'This period',
    mtdBasis: 'accrued',
    currency: r.currency,
    invoices: r.byMonth.map((m) => ({ date: `${m.month}-01`, amount: m.amount, status: 'paid' })),
    stats
  })
}

// Billing tab — the account record (card, next invoice, contact, company), trial-credit balances, and the
// downloadable invoice history. No chart, no spend headline (Summary owns those).
interface AccountRow {
  card: string | null
  nextInvoice: string | null
  contact: string | null
  company: string | null
}

interface InvoiceRow {
  date: string | null
  number: string
  amount: number
  status: string
  hostedUrl: string | null
  pdfUrl: string | null
  name: string
}

export const buildClickhouseBillingTab = (r: ClickhouseBillingReport): CapabilityResult => {
  const card = r.card ? `${r.card.brand} •••• ${r.card.last4}${r.card.exp ? ` (exp ${r.card.exp})` : ''}` : null

  const account = record<AccountRow>({
    id: 'account',
    fields: [
      { key: 'card', label: 'Card', role: 'label' },
      { key: 'nextInvoice', label: 'Next invoice', role: 'timestamp' },
      { key: 'contact', label: 'Billing contact', role: 'label' },
      { key: 'company', label: 'Company', role: 'label' }
    ],
    value: { card, nextInvoice: r.nextInvoice ?? null, contact: r.contact ?? null, company: r.company ?? null }
  })

  const invoices = table<InvoiceRow>({
    id: 'invoices',
    columns: [
      { key: 'date', label: 'Date', role: 'timestamp' },
      { key: 'number', label: 'Invoice', role: 'label' },
      { key: 'amount', label: 'Amount', role: 'money', currency: r.currency },
      { key: 'status', label: 'Status', role: 'status' },
      { key: 'hostedUrl', label: 'Receipt', role: 'url' },
      { key: 'pdfUrl', role: 'url', hidden: true },
      { key: 'name', role: 'label', hidden: true }
    ],
    rows: r.invoices.map((i) => ({
      date: i.date ?? null,
      number: i.number,
      amount: i.amount,
      status: i.status,
      hostedUrl: i.hostedUrl ?? null,
      pdfUrl: i.pdfUrl ?? i.hostedUrl ?? null,
      name: `Invoice ${i.number}`
    })),
    // Keyed by invoice number so invoices accumulate history (a status flips over time) past the fetch window.
    key: 'number'
  })

  return capabilityResult({
    sections: [
      account.keyvalue({ title: 'Account' }),
      r.credit.granted > 0
        ? blocks.credits(
            { granted: r.credit.granted, used: r.credit.used, balance: r.credit.remaining, currency: r.currency },
            { title: 'Trial credit' }
          )
        : null,
      r.invoices.length
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

// fetch returns the raw billing-details RPC payload (Summary + Billing both build off it; the core query cache
// dedupes the underlying read across the two tabs).
const fetchClickhouseBilling = async (ctx: CollectContext<ClickhouseConfig>): Promise<RawBillingDetails> => {
  const org = await resolveOrg(ctx)

  return rpc<RawBillingDetails>(ctx, 'billing', { rpcAction: 'getOrganizationBillingDetails', organizationId: org.id })
}

// ── usage ─────────────────────────────────────────────────────────────────────────────

// The metered metrics worth surfacing, in display order, with a human label + unit. Zero-on-both metrics are
// dropped so the table shows what the account actually consumed.
const USAGE_METRICS: { key: string; label: string; unit: string }[] = [
  { key: 'instanceComputeUnitHours', label: 'Compute', unit: 'CU·h' },
  { key: 'clickpipeComputeUnitHours', label: 'ClickPipes compute', unit: 'CU·h' },
  { key: 'datawarehouseStorageTBMonthsTables', label: 'Storage — tables', unit: 'TB·mo' },
  { key: 'datawarehouseStorageTBMonthsBackups', label: 'Storage — backups', unit: 'TB·mo' },
  { key: 'instancePublicDataTransferGB', label: 'Data transfer — public', unit: 'GB' },
  { key: 'instanceInterRegionTier1DataTransferGB', label: 'Data transfer — inter-region T1', unit: 'GB' },
  { key: 'instanceInterRegionTier2DataTransferGB', label: 'Data transfer — inter-region T2', unit: 'GB' },
  { key: 'instanceInterRegionTier3DataTransferGB', label: 'Data transfer — inter-region T3', unit: 'GB' },
  { key: 'clickpipeDataTransferGB', label: 'ClickPipes transfer', unit: 'GB' },
  { key: 'clickpipeInitialDataTransferGB', label: 'ClickPipes initial transfer', unit: 'GB' }
]

// Pure transform — fixture-tested. The current bill period's metered consumption + on-demand cost per metric.
export const buildClickhouseUsage = (raw: RawUsageReport | undefined | null): UsageMetricInput[] => {
  const total = raw?.report?.totalUsageReport ?? {}

  return USAGE_METRICS.flatMap(({ key, label, unit }) => {
    const m = total[key]

    if (!m || ((m.metricValue ?? 0) === 0 && (m.cost ?? 0) === 0)) {
      return []
    }

    return [{ label, value: Math.round((m.metricValue ?? 0) * 10000) / 10000, unit, cost: round2(m.cost ?? 0) }]
  })
}

// Compose the usage result from the raw report: period start + the curated metered metrics.
export const buildClickhouseUsageResult = (raw: RawUsageReport | undefined | null): CapabilityResult =>
  usage.result({ periodStart: raw?.report?.startDate, metrics: buildClickhouseUsage(raw) })

const fetchClickhouseUsage = async (ctx: CollectContext<ClickhouseConfig>): Promise<RawUsageReport> => {
  const org = await resolveOrg(ctx)

  return rpc<RawUsageReport>(ctx, 'billing', {
    rpcAction: 'getUsageReport',
    organizationId: org.id,
    usagePeriod: { type: 'BILL_DATE' }
  })
}

// ── members ─────────────────────────────────────────────────────────────────────────────

// Pure transform — fixture-tested. The org's user roster (keyed by userId in the session payload).
export const buildClickhouseMembers = (org: RawOrg | undefined | null): MembersInput => {
  const users = Object.values(org?.users ?? {})

  return {
    members: users.map((u, i) => ({
      id: u.userId ?? String(i),
      name: u.name,
      email: u.email,
      role: u.role
    })) satisfies MemberInput[]
  }
}

export const buildClickhouseMembersResult = (org: RawOrg | undefined | null): CapabilityResult =>
  members.result(buildClickhouseMembers(org))

// ── descriptor ──────────────────────────────────────────────────────────────────────

export const clickhousePlugin = definePlugin({
  reportingCurrency: 'USD',
  meta: {
    id: 'clickhouse',
    name: 'ClickHouse',
    vendor: 'ClickHouse',
    category: 'devtools',
    description: 'ClickHouse Cloud spend, invoices, usage, and members from the console session.',
    color: '#FAFF69',
    homepage: 'https://clickhouse.com',
    dashboardUrl: 'https://console.clickhouse.cloud'
  },
  session: {
    loginUrl: CONSOLE,
    // Any settled console page; the Auth0 session cookie gates capture so the pre-auth /signIn page doesn't.
    dashboardMarkers: ['console.clickhouse.cloud'],
    cookieDomains: ['clickhouse.cloud'],
    // The durable Auth0 session cookie on auth.clickhouse.cloud that drives the SPA's silent token renew.
    requiredCookie: 'auth0',
    // Start every sign-in from a clean session cookie. The /signIn page lives under the console marker, so a
    // STALE 'auth0' cookie left from an expired session satisfies marker+requiredCookie before you've logged
    // in and snaps a dead session. Dropping it first lands you on a real login, and the fresh cookie is what
    // gets captured. (Cleared only at sign-in start — the captured cookie still persists for headless replay.)
    clearCookiesBeforeCapture: ['auth0']
  },
  // spa-bearer: the console SPA mints a 5-min Bearer via Auth0 silent-renew; core boots it offscreen, captures
  // the Bearer off the control-plane XHRs, caches it, and re-mints on 401.
  auth: {
    kind: 'spa-bearer',
    bootUrl: CONSOLE,
    authCaptureUrlPatterns: ['https://control-plane-internal.clickhouse.cloud/*'],
    clearOnStatuses: [401]
  },
  // node client injects the browser UA + sec-ch-ua centrally; add the cross-origin (console → control-plane)
  // Origin/Referer/Sec-Fetch the SPA sends. control-plane-internal doesn't need the browser engine.
  transport: {
    baseUrl: CONTROL_PLANE,
    defaultHeaders: {
      Accept: '*/*',
      Origin: CONSOLE,
      Referer: `${CONSOLE}/`,
      'Sec-Fetch-Site': 'same-site',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty'
    }
  },
  config: clickhouseConfigSchema,
  capabilities: [
    // Invoice PDFs aren't a separate documents tab — the Billing invoices table is downloadable (its pdfUrl column).
    defineCapability({
      id: 'summary',
      label: 'Summary',
      fetch: fetchClickhouseBilling,
      build: (raw) => buildClickhouseSummaryResult(buildClickhouseBilling(raw)),
      sample: sampleClickhouseBilling
    }),
    defineCapability({
      id: 'billing',
      label: 'Billing',
      fetch: fetchClickhouseBilling,
      build: (raw) => buildClickhouseBillingTab(buildClickhouseBilling(raw)),
      sample: sampleClickhouseBilling
    }),
    defineCapability({
      id: 'usage',
      label: 'Usage',
      fetch: fetchClickhouseUsage,
      build: buildClickhouseUsageResult,
      sample: sampleClickhouseUsage
    }),
    defineCapability({
      id: 'members',
      label: 'Members',
      fetch: resolveOrg,
      build: buildClickhouseMembersResult,
      sample: sampleClickhouseOrg
    })
  ],
  probe: async (ctx) => {
    // initializeUserSession is the cheapest authed RPC — a 200 proves the minted Bearer reaches control-plane.
    await rpc(ctx, 'account', { rpcAction: 'initializeUserSession' })
  }
})
