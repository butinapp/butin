import { defineCapability, defineConfigSchema, definePlugin, type CollectContext, type ConfigOf } from '@butinapp/sdk'
import { capabilityResult, table, type CapabilityResult } from '@butinapp/sdk/data'
import {
  billing,
  members,
  usage,
  type BillingInvoiceInput,
  type MemberInput,
  type UsageMetricInput
} from '@butinapp/sdk/presets'
import { centsToMajor, isoDay } from '@butinapp/sdk/util'

import { sampleSentryBilling, sampleSentryMembers, sampleSentryUsage } from './sample.js'

// Sentry: a plain cookie session over Node TLS (sentry.io is fronted by nginx, not Cloudflare — no CF
// gating). The dashboard is a React SPA backed by the JSON API on the regional silo host us.sentry.io;
// money is CENTS on every endpoint. Three capabilities (billing/usage/members) share one cookie session.
const REGION_HOST = 'https://us.sentry.io'

// Every endpoint wants a sentry.io Referer; the org-scoped calls want the org subdomain.
const get =
  (ctx: CollectContext<SentryConfig>) =>
  <T>(url: string) =>
    ctx.client.get<T>(url, { Referer: 'https://sentry.io/' })

// --- types: all Raw* wire shapes + normalized domain types (the data dictionary) ---
interface RawOrg {
  slug?: string
}

interface RawReceipt {
  url?: string | null
}

export interface RawInvoice {
  id?: string
  amount?: number
  amountBilled?: number
  amountRefunded?: number
  isPaid?: boolean
  dateCreated?: string
  receipt?: RawReceipt | null
}

export interface RawCustomer {
  plan?: string
  planDetails?: { name?: string }
  onDemandSpendUsed?: number
}

export interface SentryBillingData {
  invoices: RawInvoice[]
  customer: RawCustomer
}

interface RawUsageTotal {
  accepted?: number
}

export interface RawUsage {
  totals?: Record<string, RawUsageTotal>
}
interface RawHistoryCategory {
  category?: string
  reserved?: number | null
  onDemandSpendUsed?: number
}

export interface RawHistory {
  // /history/current/ may key categories by name (a dict) or as a list — both are accepted.
  categories?: RawHistoryCategory[] | Record<string, RawHistoryCategory>
  periodStart?: string
  periodEnd?: string
}

// Usage joins two endpoints (/usage/ accepted counts + /history/current/ reserved quota & on-demand spend).
export interface SentryUsageData {
  usage: RawUsage
  history: RawHistory
}

export interface RawMember {
  id?: string
  email?: string
  name?: string
  role?: string
  user?: { email?: string; name?: string }
}

export const pickOrgSlug = (orgs: RawOrg[]): string | undefined => orgs.find((o) => !!o.slug)?.slug

export const discoverOrgSlug = async (get: <T>(url: string) => Promise<T>): Promise<string | undefined> => {
  const orgs = await get<RawOrg[]>(`${REGION_HOST}/api/0/organizations/`)

  return Array.isArray(orgs) ? pickOrgSlug(orgs) : undefined
}

// Resolve the org slug once per collect: the pinned config value, else discovered from the session's
// first org. Throws the shared "set it in Settings" error when neither is available.
const resolveOrgSlug = async (ctx: CollectContext<SentryConfig>): Promise<string> => {
  const orgSlug = ctx.config.orgSlug?.trim() || (await discoverOrgSlug(get(ctx)))

  if (!orgSlug) {
    throw new Error('Could not determine your Sentry organization slug — set it in Settings.')
  }

  return orgSlug
}

// --- billing: invoice history + subscription, on the regional silo (us.sentry.io) ---
//   GET /api/0/customers/<org>/invoices/ → invoice history
//   GET /api/0/customers/<org>/          → subscription (plan, on-demand spend)
// Pure transform — fixture-tested. Net billed = amountBilled (or amount) minus refunds, cents → USD.
export const buildSentryBillingReport = (invoicesRaw: RawInvoice[], customer: RawCustomer) => {
  const invoices: BillingInvoiceInput[] = invoicesRaw.map((inv) => ({
    id: inv.id,
    date: isoDay(inv.dateCreated),
    status: inv.isPaid ? 'paid' : 'open',
    amount: centsToMajor(inv.amountBilled ?? inv.amount) - centsToMajor(inv.amountRefunded),
    pdfUrl: inv.receipt?.url ?? null,
    hostedUrl: null
  }))

  invoices.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))

  return {
    currentMtd: customer.onDemandSpendUsed != null ? centsToMajor(customer.onDemandSpendUsed) : null,
    plan: customer.planDetails?.name ?? customer.plan,
    invoices
  }
}

export type SentryBillingReport = ReturnType<typeof buildSentryBillingReport>

// --- Summary tab (its spend.mtd summary is what the cross-service Overview rolls up) ---
// The headline (account stat + monthly-spend chart + spend.mtd summary) is the shared billing.summary
// preset; we add the invoice count as a free stat (off the invoice list already fetched for the chart).
// currentMtd is null when the subscription couldn't be read, so the Overview skips Sentry rather than 0.
export const buildSentrySummaryResult = (report: SentryBillingReport): CapabilityResult =>
  billing.summary({
    currentMtd: report.currentMtd,
    // On-demand (pay-as-you-go) spend accruing live over the open period; the plan's reserved fee is separate.
    mtdBasis: 'accrued',
    plan: report.plan,
    invoices: report.invoices,
    stats: [{ key: 'invoiceCount', label: 'Invoices', role: 'count', value: report.invoices.length }]
  })

// --- Billing tab (renders via the generic renderer; emits no summary, so it's NOT the Overview rollup) ---
// The invoice history. The headline (MTD / plan / monthly chart) lives on Summary; this is the detail.
interface SentryInvoiceRow {
  // The Sentry invoice id — hidden, the ledger key so an invoice accumulates its status/amount past the fetch window.
  id: string
  date: string | null
  amount: number
  status: string
  pdfUrl: string | null
  // Hidden — carried for the download filename, declared not smuggled.
  name: string
}

export const buildSentryBillingResult = (report: SentryBillingReport): CapabilityResult => {
  const { invoices } = report

  // The invoices table is downloadable: each row's receipt PDF (pdfUrl) becomes a selectable file the host
  // downloads via the shared engine (selection + Download all/selected + per-row Open + on-disk size).
  const invoiceTable = table<SentryInvoiceRow>({
    id: 'invoices',
    columns: [
      { key: 'date', label: 'Date', role: 'timestamp' },
      { key: 'amount', label: 'Amount', role: 'money' },
      { key: 'status', label: 'Status', role: 'status' },
      { key: 'pdfUrl', label: 'PDF', role: 'url' },
      { key: 'name', role: 'label', hidden: true },
      { key: 'id', role: 'identifier', hidden: true }
    ],
    rows: invoices.map((i, idx) => ({
      id: i.id ?? `inv-${idx}`,
      date: i.date ?? null,
      amount: i.amount,
      status: i.status,
      pdfUrl: i.pdfUrl ?? i.hostedUrl ?? null,
      name: `Invoice ${i.date ?? 'unknown'}`
    })),
    key: 'id'
  })

  return capabilityResult({
    sections: [
      invoiceTable.fileTable({
        title: 'Invoices',
        name: 'name',
        source: { url: 'pdfUrl' },
        ext: 'pdf',
        category: 'Invoices'
      })
    ]
  })
}

// Summary + Billing both need the same two endpoints (invoices + subscription). Both capabilities share
// fetchSentryBilling; the core query cache dedupes the underlying reads (keyed by org slug via the call site).
const fetchSentryBilling = async (ctx: CollectContext<SentryConfig>): Promise<SentryBillingData> => {
  const orgSlug = await resolveOrgSlug(ctx)
  const base = `${REGION_HOST}/api/0/customers/${orgSlug}`
  const referer = { Referer: `https://${orgSlug}.sentry.io/` }
  const [invoices, customer] = await Promise.all([
    ctx.client.get<RawInvoice[]>(`${base}/invoices/`, referer),
    ctx.client.get<RawCustomer>(`${base}/`, referer)
  ])

  return { invoices: invoices ?? [], customer: customer ?? {} }
}

// --- usage: per data-category consumption for the current billing period ---
//   GET /usage/           → accepted counts per category
//   GET /history/current/ → reserved quota + on-demand spend (CENTS)
const CATEGORY_LABELS: Record<string, string> = {
  errors: 'Errors',
  transactions: 'Transactions',
  replays: 'Replays',
  attachments: 'Attachments',
  spans: 'Spans',
  profiles: 'Profiles',
  profileDuration: 'Profile Hours',
  monitorSeats: 'Cron Monitors',
  uptime: 'Uptime Monitors',
  logBytes: 'Logs'
}

const UNITS: Record<string, string> = { attachments: 'GB', profileDuration: 'hours' }

const prettify = (key: string): string =>
  CATEGORY_LABELS[key] ?? key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())

// Pure transform — fixture-tested. accepted = value, reserved = limit, onDemandSpendUsed (cents) = cost.
export const buildSentryUsageReport = (usage: RawUsage, history: RawHistory) => {
  const reserved = new Map<string, number | null>()
  const onDemand = new Map<string, number>()

  // Normalize to a list whether `categories` arrives as an array or a name-keyed dict — `?? []` only
  // catches null/undefined, so a dict would otherwise make the `for...of` below throw "not iterable".
  const categoryList = Array.isArray(history.categories)
    ? history.categories
    : Object.entries(history.categories ?? {}).map(([category, c]) => ({ category, ...c }))

  for (const c of categoryList) {
    if (!c.category) {
      continue
    }

    reserved.set(c.category, c.reserved ?? null)

    if (c.onDemandSpendUsed != null) {
      onDemand.set(c.category, c.onDemandSpendUsed)
    }
  }

  const categories = new Set<string>([...Object.keys(usage.totals ?? {}), ...reserved.keys()])
  const metrics: UsageMetricInput[] = []

  for (const cat of categories) {
    const cost = onDemand.get(cat)

    metrics.push({
      label: prettify(cat),
      value: usage.totals?.[cat]?.accepted ?? 0,
      unit: UNITS[cat],
      limit: reserved.get(cat) ?? null,
      cost: cost != null ? centsToMajor(cost) : null
    })
  }

  metrics.sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0) || b.value - a.value)

  return { periodStart: history.periodStart, periodEnd: history.periodEnd, metrics }
}

const fetchSentryUsage = async (ctx: CollectContext<SentryConfig>): Promise<SentryUsageData> => {
  const orgSlug = await resolveOrgSlug(ctx)
  const base = `${REGION_HOST}/api/0/customers/${orgSlug}`
  const referer = { Referer: `https://${orgSlug}.sentry.io/` }
  const [usage, history] = await Promise.all([
    ctx.client.get<RawUsage>(`${base}/usage/`, referer),
    ctx.client.get<RawHistory>(`${base}/history/current/`, referer)
  ])

  return { usage: usage ?? {}, history: history ?? {} }
}

// Pure transform — fixture-tested via buildSentryUsageReport.
export const buildSentryUsageResult = ({ usage: usageData, history }: SentryUsageData): CapabilityResult =>
  usage.result(buildSentryUsageReport(usageData, history))

// --- members: the org member roster ---
// Pure transform — fixture-tested. Sentry nests name/email under `user` for accepted members.
export const buildSentryMembers = (raw: RawMember[]) => ({
  members: raw.map((m, i) => ({
    id: m.id ?? String(i),
    email: m.email ?? m.user?.email,
    name: m.name ?? m.user?.name,
    role: m.role
  })) satisfies MemberInput[]
})

const fetchSentryMembers = async (ctx: CollectContext<SentryConfig>): Promise<RawMember[]> => {
  const orgSlug = await resolveOrgSlug(ctx)
  const members = await ctx.client.get<RawMember[]>(`${REGION_HOST}/api/0/organizations/${orgSlug}/members/`, {
    Referer: `https://${orgSlug}.sentry.io/`
  })

  return members ?? []
}

// Pure transform — fixture-tested via buildSentryMembers.
export const buildSentryMembersResult = (raw: RawMember[]): CapabilityResult => members.result(buildSentryMembers(raw))

export const sentryConfigSchema = defineConfigSchema([
  {
    key: 'orgSlug',
    label: 'Organization slug',
    kind: 'text',
    help: 'Auto-detected from your account if left blank (US region). Pin it to choose a specific org.'
  }
])

export type SentryConfig = ConfigOf<typeof sentryConfigSchema>

export const sentryPlugin = definePlugin({
  reportingCurrency: 'USD',
  meta: {
    id: 'sentry',
    name: 'Sentry',
    vendor: 'Sentry',
    category: 'devtools',
    color: '#6a5fc1',
    description: 'Sentry org billing, event usage, and the member roster.',
    homepage: 'https://sentry.io',
    dashboardUrl: 'https://sentry.io',
    troubleshooting: {
      'config-invalid': {
        hint: 'A 404 usually means the Organization slug in Settings does not match your account. It is the part after sentry.io/ in your dashboard URL (e.g. "acme" in acme.sentry.io) — or leave it blank to auto-detect.'
      }
    }
  },
  session: {
    loginUrl: 'https://sentry.io/auth/login/',
    dashboardMarkers: ['/issues/', '/organizations/', '/settings/'],
    cookieDomains: ['sentry.io'],
    // The Rails-style `session` cookie (HttpOnly) lands after the SSO redirect; wait for it so we
    // don't grab a pre-auth jar (the billing API 401s without it).
    requiredCookie: 'session'
  },
  auth: { kind: 'cookie' },
  config: sentryConfigSchema,
  capabilities: [
    defineCapability({
      id: 'summary',
      label: 'Summary',
      fetch: fetchSentryBilling,
      build: ({ invoices, customer }) => buildSentrySummaryResult(buildSentryBillingReport(invoices, customer)),
      sample: sampleSentryBilling
    }),
    defineCapability({
      id: 'billing',
      label: 'Billing',
      fetch: fetchSentryBilling,
      build: ({ invoices, customer }) => buildSentryBillingResult(buildSentryBillingReport(invoices, customer)),
      sample: sampleSentryBilling
    }),
    defineCapability({
      id: 'usage',
      label: 'Usage',
      fetch: fetchSentryUsage,
      build: buildSentryUsageResult,
      sample: sampleSentryUsage
    }),
    defineCapability({
      id: 'members',
      label: 'Members',
      fetch: fetchSentryMembers,
      build: buildSentryMembersResult,
      sample: sampleSentryMembers
    })
  ],
  probe: async (ctx) => {
    // Validate the RESOLVED org slug (config-pinned value preferred), not just "any org exists" — a wrong
    // configured slug must 404 HERE so the single probe fails fast, instead of fanning out four doomed
    // capability fetches that each 404 on the bad slug.
    const orgSlug = await resolveOrgSlug(ctx)

    await get(ctx)(`${REGION_HOST}/api/0/organizations/${orgSlug}/`)
  }
})
