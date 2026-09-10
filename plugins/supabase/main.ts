import { defineCapability, defineConfigSchema, definePlugin, type CollectContext, type ConfigOf } from '@butinapp/sdk'
import { addSections, capabilityResult, record, table, type CapabilityResult } from '@butinapp/sdk/data'
import {
  billing,
  members,
  usage,
  type BillingInvoiceInput,
  type MemberInput,
  type MembersInput,
  type UsageMetricInput
} from '@butinapp/sdk/presets'
import { byDayDesc, centsToMajor, epochSecDay, isoDay, normalizeCurrency, round2 } from '@butinapp/sdk/util'

import { sampleSupabaseBilling, sampleSupabaseMembers, sampleSupabaseUsage } from './sample.js'

// Supabase: read-only views over api.supabase.com's Studio platform API (the `/platform/...` endpoints the
// dashboard SPA calls). Four read-only tabs over one spa-bearer session:
//   1. Summary — the overview the cross-service Overview rolls up (spend.mtd): the in-progress invoice's
//      accrued total + the monthly-spend chart + a tight row of headline stats. No tables.
//   2. Billing — the detail: the subscription account record (plan, cycle, projected total), the in-progress
//      invoice's line items, and the downloadable past-invoice receipts (Orb-hosted PDFs).
//   3. Usage — per-metric current-cycle usage + cost + the project inventory.
//   4. Members — the org teammate roster.
// Summary + Billing share one billing fetch (the query cache dedupes it).
//
// ⚠️ Money units differ per endpoint — read each in its own unit:
//   - invoice LIST (`/billing/invoices`)        → CENTS (`subtotal`/`amount_due`, 453250 → $4532.50)
//   - UPCOMING invoice (`/billing/invoices/upcoming`) → DOLLARS (`amount_total` 4149.45, line `amount`)
//   - per-metric usage `cost` (`/usage`)        → DOLLARS (1655.05)
// Normalized to USD dollars here; the in-progress invoice's accrued total is the live MTD (amount_projected
// is the end-of-cycle forecast, not spend-so-far).

// ── constants ───────────────────────────────────────────────────────────────────────
// api.supabase.com doesn't need the browser engine — Node axios reaches it. The dashboard XHR's Origin/Referer are
// mirrored so the platform API treats the request like the Studio app. The UA is not hand-pinned — core injects
// the canonical browser identity into both the sign-in window and replay so they always agree.
const API = 'https://api.supabase.com'

// How many past invoices to pull (one page; the API paginates offset/limit).
const INVOICE_LIMIT = 24

// The org slug keys every `/platform/organizations/<slug>/…` path. Auto-captured from the settled dashboard
// URL (captureFromUrl → prefills the optional config field); resolveOrgSlug falls back to the first org.
export const supabaseConfigSchema = defineConfigSchema([
  {
    key: 'orgSlug',
    label: 'Organization slug',
    kind: 'text',
    placeholder: 'your-org-slug',
    help: 'Auto-captured from your dashboard URL on sign-in (supabase.com/dashboard/org/<slug>). Override only to target a different org.'
  }
])

export type SupabaseConfig = ConfigOf<typeof supabaseConfigSchema>

// ── types ─────────────────────────────────────────────────────────────────────────
// Raw* = the wire shapes the platform API returns (only the fields we read); the rest are normalized domain
// types (all money in USD dollars).

export interface RawInvoice {
  id?: string
  number?: string
  // Invoice subtotal in CENTS.
  subtotal?: number
  // Amount due in CENTS.
  amount_due?: number
  // Period end, unix SECONDS.
  period_end?: number
  status?: string
  invoice_pdf?: string
  payment_is_processing?: boolean
}

export interface RawUpcomingLine {
  amount?: number
  amount_before_discount?: number
  description?: string
  item_name?: string
  quantity?: number
  unit_price?: number | null
  unit_price_desc?: string
  usage_based?: boolean
  usage_metric?: string
}

export interface RawUpcomingInvoice {
  subscription_id?: string
  // Current cycle total so far, DOLLARS.
  amount_total?: number
  // Projected end-of-cycle total, DOLLARS.
  amount_projected?: number
  billing_cycle_start?: string
  billing_cycle_end?: string
  customer_balance?: number
  currency?: string
  lines?: RawUpcomingLine[]
}

interface RawOrgPlan {
  id?: string
  name?: string
}

export interface RawOrg {
  slug?: string
  name?: string
  plan?: RawOrgPlan
  tier?: string
  usage_billing_enabled?: boolean
}

// Normalized billing report (all money in USD dollars).
export interface SupabaseInvoice {
  id: string
  number?: string
  // 'YYYY-MM-DD' (period end).
  date?: string
  status: string
  amount: number
  amountDue: number
  pdfUrl?: string
}

export interface SupabaseUpcomingLine {
  itemName: string
  description?: string
  amount: number
  quantity: number
  unitPriceDesc?: string
  usageBased: boolean
  usageMetric?: string
}

export interface SupabaseUpcoming {
  amountTotal: number
  amountProjected: number
  cycleStart?: string
  cycleEnd?: string
  customerBalance: number
  currency: string
  lines: SupabaseUpcomingLine[]
}

export interface SupabaseBillingReport {
  planName: string
  tier?: string
  usageBillingEnabled: boolean
  currency: string
  // USD MTD spend; null when there's no in-progress invoice (the accrued total IS the MTD).
  currentMtd: number | null
  invoices: SupabaseInvoice[]
  upcoming?: SupabaseUpcoming
  // Most recent past-invoice total, dollars.
  latestAmount: number
}

// ── billing ─────────────────────────────────────────────────────────────────────────
// Mixed money units: the invoice list is CENTS (centsToMajor), the upcoming invoice + line amounts are DOLLARS
// (no /100). period_end is unix SECONDS → 'YYYY-MM-DD'.

export const buildSupabaseBilling = (
  org: RawOrg | undefined,
  rawInvoices: RawInvoice[] | null | undefined,
  rawUpcoming?: RawUpcomingInvoice | null
): SupabaseBillingReport => {
  const invoices: SupabaseInvoice[] = (rawInvoices ?? []).map((inv, i) => ({
    id: inv.id ?? inv.number ?? `inv-${i}`,
    number: inv.number,
    date: epochSecDay(inv.period_end),
    status: inv.payment_is_processing ? 'processing' : (inv.status ?? 'unknown'),
    amount: centsToMajor(inv.subtotal ?? 0),
    amountDue: centsToMajor(inv.amount_due ?? 0),
    pdfUrl: inv.invoice_pdf
  }))

  invoices.sort(byDayDesc)

  let upcoming: SupabaseUpcoming | undefined

  if (rawUpcoming) {
    upcoming = {
      amountTotal: rawUpcoming.amount_total ?? 0,
      amountProjected: rawUpcoming.amount_projected ?? 0,
      cycleStart: isoDay(rawUpcoming.billing_cycle_start),
      cycleEnd: isoDay(rawUpcoming.billing_cycle_end),
      customerBalance: rawUpcoming.customer_balance ?? 0,
      currency: normalizeCurrency(rawUpcoming.currency),
      lines: (rawUpcoming.lines ?? []).map((l) => ({
        itemName: l.item_name ?? l.description ?? 'unknown',
        description: l.description,
        amount: l.amount ?? 0,
        quantity: l.quantity ?? 0,
        unitPriceDesc: l.unit_price_desc,
        usageBased: l.usage_based ?? false,
        usageMetric: l.usage_metric
      }))
    }
  }

  return {
    planName: org?.plan?.name ?? 'Unknown',
    tier: org?.tier,
    usageBillingEnabled: org?.usage_billing_enabled ?? false,
    currency: upcoming?.currency ?? 'USD',
    // The in-progress (upcoming) invoice's accrued total is the live MTD; amountProjected is the
    // end-of-cycle forecast, not spend-so-far.
    currentMtd: upcoming?.amountTotal ?? null,
    invoices,
    upcoming,
    latestAmount: invoices[0]?.amount ?? 0
  }
}

// The Summary tab — the overview the cross-service Overview rolls up (spend.mtd): just the headline (the
// in-progress invoice's accrued total), the monthly-spend chart the preset derives from the invoice history,
// and plan / projected / latest folded in as headline stats. No tables — the detail lives on Billing.
export const buildSupabaseSummaryResult = (report: SupabaseBillingReport): CapabilityResult => {
  const invoiceInputs: BillingInvoiceInput[] = report.invoices.map((i) => ({
    date: i.date,
    amount: i.amount,
    status: i.status,
    // Orb-hosted PDF doubles as the hosted receipt page (no separate hosted URL).
    pdfUrl: i.pdfUrl ?? null,
    hostedUrl: i.pdfUrl ?? null
  }))

  return billing.summary({
    currentMtd: report.currentMtd,
    // The upcoming (in-progress) invoice total for the open cycle.
    mtdBasis: 'upcoming',
    currency: report.currency,
    plan: report.planName,
    invoices: invoiceInputs,
    stats: [
      {
        key: 'projected',
        label: 'Projected (cycle)',
        role: 'money',
        currency: report.currency,
        value: report.upcoming?.amountProjected ?? null
      },
      { key: 'latest', label: 'Latest invoice', role: 'money', currency: report.currency, value: report.latestAmount },
      {
        key: 'usageBilling',
        label: 'Usage billing',
        role: 'label',
        value: report.usageBillingEnabled ? 'enabled' : 'disabled'
      }
    ]
  })
}

// Subscription account record row.
interface SupabaseAccountRow {
  plan: string
  tier: string | null
  cycle: string | null
  projected: number | null
  usageBilling: string
}

// Upcoming line-items row.
interface SupabaseUpcomingLineRow {
  itemName: string
  unitPriceDesc: string | null
  amount: number
}

// Invoice row: the `name` field is hidden — carried for the download filename, not rendered. `id` (the raw
// Stripe invoice id) rides hidden as the ledger key so an invoice accumulates its status past the fetch window.
interface SupabaseInvoiceRow {
  id: string
  date: string | null
  number: string | null
  amount: number
  status: string
  pdfUrl: string | null
  name: string
}

// The Billing tab — the financial detail (not the Overview rollup; the headline + chart live on Summary): the
// subscription account record (plan, tier, current cycle, projected total), the in-progress invoice's line
// items, and the downloadable past-invoice receipts (Orb-hosted PDFs).
export const buildSupabaseBillingTab = (report: SupabaseBillingReport): CapabilityResult => {
  const ccy = report.currency
  const up = report.upcoming
  const cycle = up?.cycleStart && up.cycleEnd ? `${up.cycleStart} → ${up.cycleEnd}` : null

  const account = record<SupabaseAccountRow>({
    id: 'account',
    fields: [
      { key: 'plan', label: 'Plan', role: 'label' },
      { key: 'tier', label: 'Tier', role: 'label' },
      { key: 'cycle', label: 'Current cycle', role: 'label' },
      { key: 'projected', label: 'Projected (cycle)', role: 'money', currency: ccy },
      { key: 'usageBilling', label: 'Usage billing', role: 'label' }
    ],
    value: {
      plan: report.planName,
      tier: report.tier ?? null,
      cycle,
      projected: up?.amountProjected ?? null,
      usageBilling: report.usageBillingEnabled ? 'enabled' : 'disabled'
    }
  })

  const upcoming = table<SupabaseUpcomingLineRow>({
    id: 'upcoming',
    columns: [
      { key: 'itemName', label: 'Item', role: 'label' },
      { key: 'unitPriceDesc', label: 'Unit price', role: 'text' },
      { key: 'amount', label: 'Amount', role: 'money', currency: ccy }
    ],
    rows: (up?.lines ?? []).map((l) => ({
      itemName: l.itemName,
      unitPriceDesc: l.unitPriceDesc ?? null,
      amount: l.amount
    }))
  })

  const invoices = table<SupabaseInvoiceRow>({
    id: 'invoices',
    columns: [
      { key: 'date', label: 'Date', role: 'timestamp' },
      { key: 'number', label: 'Number', role: 'identifier' },
      { key: 'amount', label: 'Amount', role: 'money', currency: ccy },
      { key: 'status', label: 'Status', role: 'status' },
      { key: 'pdfUrl', label: 'Receipt', role: 'url' },
      { key: 'name', role: 'label', hidden: true },
      { key: 'id', role: 'identifier', hidden: true }
    ],
    rows: report.invoices.map((i) => ({
      id: i.id,
      date: i.date ?? null,
      number: i.number ?? null,
      amount: i.amount,
      status: i.status,
      pdfUrl: i.pdfUrl ?? null,
      name: `Invoice ${i.number ?? i.date ?? 'unknown'}`
    })),
    key: 'id'
  })

  return capabilityResult({
    sections: [
      account.keyvalue({ title: 'Subscription' }),
      upcoming.dataset.rows.length > 0 ? upcoming.table({ title: 'Current cycle' }) : null,
      invoices.dataset.rows.length > 0
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

// The org slug for every `/platform/organizations/<slug>/…` path: an explicit config override wins, else the
// id captured from the dashboard URL at sign-in, else the account's first org (the query cache dedupes the
// extra `/platform/organizations` read against the collectors' own).
const resolveOrgSlug = async (ctx: CollectContext<SupabaseConfig>): Promise<string> => {
  const configured = ctx.config.orgSlug?.trim() || ctx.creds.get('orgSlug')

  if (configured) {
    return configured
  }

  const orgs = await ctx.client.get<RawOrg[]>(`${API}/platform/organizations`)
  const slug = orgs?.[0]?.slug

  if (!slug) {
    throw new Error('Supabase: no organization found — sign in and open your org in the dashboard.')
  }

  return slug
}

// Summary + Billing share the same three billing reads. Both capabilities fetch the same raw bundle; the
// core query cache dedupes the underlying fetches. The raw wire bundle is the network half; buildSupabaseBilling
// is the pure raw→report transform Summary/Billing both build on.
export interface RawBillingBundle {
  orgs: RawOrg[] | null
  slug: string
  invoices: RawInvoice[] | null
  upcoming: RawUpcomingInvoice | null
}

const fetchSupabaseBilling = async (ctx: CollectContext<SupabaseConfig>): Promise<RawBillingBundle> => {
  const slug = await resolveOrgSlug(ctx)
  const base = `/platform/organizations/${slug}`
  const [orgs, invoices, upcoming] = await Promise.all([
    ctx.client.get<RawOrg[]>(`${API}/platform/organizations`),
    ctx.client.get<RawInvoice[]>(`${API}${base}/billing/invoices?offset=0&limit=${INVOICE_LIMIT}`),
    ctx.client.get<RawUpcomingInvoice>(`${API}${base}/billing/invoices/upcoming`)
  ])

  return { orgs: orgs ?? null, slug, invoices: invoices ?? null, upcoming: upcoming ?? null }
}

const billingReport = (raw: RawBillingBundle): SupabaseBillingReport => {
  const org = (raw.orgs ?? []).find((o) => o.slug === raw.slug) ?? raw.orgs?.[0]

  return buildSupabaseBilling(org, raw.invoices ?? [], raw.upcoming)
}

// ── usage ─────────────────────────────────────────────────────────────────────────
// Per-metric current-cycle usage + cost (DOLLARS, no /100) + the project inventory.

interface RawUsageMetric {
  metric?: string
  usage?: number
  // Charge so far this cycle, DOLLARS.
  cost?: number
  unit_price_desc?: string
  available_in_plan?: boolean
  capped?: boolean
  project_allocations?: unknown[]
}

export interface RawUsage {
  usage_billing_enabled?: boolean
  usages?: RawUsageMetric[]
}

interface RawProject {
  name?: string
  ref?: string
  region?: string
  status?: string
  cloud_provider?: string
  infra_compute_size?: string
  disk_volume_size_gb?: number
}

export interface RawProjectList {
  projects?: RawProject[]
}

export interface SupabaseUsageMetric {
  metric: string
  usage: number
  // Charge so far this cycle, dollars.
  cost: number
  unitPriceDesc?: string
  availableInPlan: boolean
  capped: boolean
  // Number of projects this metric is allocated across.
  projectCount: number
}

export interface SupabaseProject {
  name: string
  ref: string
  region?: string
  status: string
  cloudProvider?: string
  computeSize?: string
  diskGb: number
}

export interface SupabaseUsageReport {
  usageBillingEnabled: boolean
  // Total cost across metered metrics this cycle, dollars.
  totalCost: number
  metrics: SupabaseUsageMetric[]
  projects: SupabaseProject[]
}

export const buildSupabaseUsage = (
  usage: RawUsage | null | undefined,
  projectList: RawProjectList | null | undefined
): SupabaseUsageReport => {
  const metrics: SupabaseUsageMetric[] = (usage?.usages ?? []).map((m) => ({
    metric: m.metric ?? 'unknown',
    usage: m.usage ?? 0,
    cost: round2(m.cost ?? 0),
    unitPriceDesc: m.unit_price_desc,
    availableInPlan: m.available_in_plan ?? false,
    capped: m.capped ?? false,
    projectCount: Array.isArray(m.project_allocations) ? m.project_allocations.length : 0
  }))

  const projects: SupabaseProject[] = (projectList?.projects ?? []).map((p) => ({
    name: p.name ?? 'unknown',
    ref: p.ref ?? '',
    region: p.region,
    status: p.status ?? 'unknown',
    cloudProvider: p.cloud_provider,
    computeSize: p.infra_compute_size,
    diskGb: p.disk_volume_size_gb ?? 0
  }))

  return {
    usageBillingEnabled: usage?.usage_billing_enabled ?? false,
    totalCost: round2(metrics.reduce((sum, m) => sum + m.cost, 0)),
    metrics,
    projects
  }
}

// Projects table row. `ref` (the project's immutable Supabase reference) rides hidden as the ledger key so a
// project accumulates across fetches even if renamed.
interface SupabaseProjectRow {
  ref: string
  name: string
  region: string | null
  status: string
  computeSize: string | null
  diskGb: number
}

// The per-metric usage feeding usage.result: each metric is a count line carrying its current-cycle cost (USD)
// so the on-demand-spend summary rolls up. The project inventory is an extra table (no money).
export const buildSupabaseUsageMetrics = (report: SupabaseUsageReport): UsageMetricInput[] =>
  report.metrics.map((m) => ({ label: m.metric, value: m.usage, cost: m.cost > 0 ? m.cost : null }))

export const buildSupabaseUsageResult = (report: SupabaseUsageReport): CapabilityResult => {
  const result = usage.result({ metrics: buildSupabaseUsageMetrics(report) })

  const projectsHandle = report.projects.length
    ? table<SupabaseProjectRow>({
        id: 'projects',
        columns: [
          { key: 'name', label: 'Project', role: 'label' },
          { key: 'region', label: 'Region', role: 'text' },
          { key: 'status', label: 'Status', role: 'status' },
          { key: 'computeSize', label: 'Compute', role: 'text' },
          { key: 'diskGb', label: 'Disk (GB)', role: 'count' },
          { key: 'ref', role: 'identifier', hidden: true }
        ],
        rows: report.projects.map((p) => ({
          ref: p.ref,
          name: p.name,
          region: p.region ?? null,
          status: p.status,
          computeSize: p.computeSize ?? null,
          diskGb: p.diskGb
        })),
        key: 'ref'
      })
    : null

  return addSections(result, projectsHandle?.table({ title: 'Projects' }))
}

// The raw wire bundle for the usage tab; buildSupabaseUsage is the pure raw→report transform.
export interface RawUsageBundle {
  usage: RawUsage | null
  projects: RawProjectList | null
}

const fetchSupabaseUsage = async (ctx: CollectContext<SupabaseConfig>): Promise<RawUsageBundle> => {
  const slug = await resolveOrgSlug(ctx)
  const [usage, projects] = await Promise.all([
    ctx.client.get<RawUsage>(`${API}/platform/organizations/${slug}/usage`),
    ctx.client.get<RawProjectList>(`${API}/platform/projects?limit=100&offset=0&sort=name_asc`)
  ])

  return { usage: usage ?? null, projects: projects ?? null }
}

// ── members ─────────────────────────────────────────────────────────────────────────
// The org member roster, reachable on the SAME studioJwt (spa-bearer) that billing/usage use — the Studio
// SPA lists members from `/platform/organizations/<slug>/members` with its session JWT. Read-only here.

export interface RawMember {
  user_id?: string
  gotrue_id?: string
  user_name?: string
  email?: string
  // 'owner' | 'admin' | 'member' on the wire; kept as a string so we don't reject unknown future roles.
  role_name?: string
}

// Pure transform — fixture-tested. Prefer gotrue_id (the platform identity) over user_id for the stable id.
export const buildSupabaseMembers = (raw: RawMember[] | null | undefined): MembersInput => ({
  members: (raw ?? []).map((m, i) => ({
    id: m.gotrue_id ?? m.user_id ?? String(i),
    name: m.user_name,
    email: m.email,
    role: m.role_name
  })) satisfies MemberInput[]
})

const fetchSupabaseMembers = async (ctx: CollectContext<SupabaseConfig>): Promise<RawMember[] | null> => {
  const slug = await resolveOrgSlug(ctx)

  return await ctx.client.get<RawMember[]>(`${API}/platform/organizations/${slug}/members`)
}

// ── descriptor ──────────────────────────────────────────────────────────────────────
// spa-bearer over plain Node axios. The credential is NOT a stored cookie or a captured token — the Studio
// SPA mints a short-lived (~1h) session JWT in memory (OIDC silent-renew) and sends it as `Authorization:
// Bearer eyJ…` to api.supabase.com. It can't be replayed from a stored value, so core boots the Studio
// dashboard offscreen on the shared partition, captures the Bearer off the wire (the SPA's own
// api.supabase.com XHRs), caches it per-plugin, and re-mints on 401. The durable thing Magic Login persists
// is the Supabase session cookie that lets that offscreen boot mint a fresh JWT. api.supabase.com doesn't
// need the browser engine, so the data fetches run on node transport (we mirror the Studio XHR's Origin/Referer).
export const supabasePlugin = definePlugin({
  reportingCurrency: 'USD',
  meta: {
    id: 'supabase',
    name: 'Supabase',
    vendor: 'Supabase',
    category: 'devtools',
    color: '#3ecf8e',
    description: 'Supabase organization billing (invoices + projected spend) and per-metric usage.',
    homepage: 'https://supabase.com',
    dashboardUrl: 'https://supabase.com/dashboard'
  },
  session: {
    loginUrl: 'https://supabase.com/dashboard',
    // Only the settled authed pages (the org home / project list / a project) — NOT the bare `/dashboard` or
    // the `/dashboard/sign-in` redirect, both of which contain `/dashboard` and would fire before sign-in.
    dashboardMarkers: ['/dashboard/org', '/dashboard/project'],
    cookieDomains: ['supabase.com', 'supabase.io'],
    // The org home URL embeds the slug (`/dashboard/org/<slug>/…`) — capture it so the user needn't type it.
    captureFromUrl: [{ pattern: '/dashboard/org/([^/?#]+)', storeAs: 'orgSlug' }],
    // No requiredCookie gates the auth (Studio's session lives client-side, not in a named cookie), so the
    // `/dashboard/org` marker + any supabase.com cookie would auto-capture a half-ready session the instant
    // the page redirects there — closing the window before sign-in settles. Wait for an explicit Capture.
    manualCaptureOnly: true
  },
  auth: {
    kind: 'spa-bearer',
    // Boot the Studio dashboard offscreen; capture the Bearer off the SPA's own api.supabase.com XHRs.
    bootUrl: 'https://supabase.com/dashboard',
    authCaptureUrlPatterns: ['https://api.supabase.com/*'],
    // The Studio JWT expires in ~1h; a 401 means it's dead → clear + re-mint. A 403 is a per-endpoint
    // permission, not a dead session (excluded by the default clearOnStatuses).
    clearOnStatuses: [401]
  },
  // node client injects the browser UA + sec-ch-ua centrally; we add the cross-origin (supabase.com →
  // api.supabase.com) Origin/Referer the Studio XHR sends. api.supabase.com doesn't need the browser engine.
  transport: {
    defaultHeaders: {
      Accept: 'application/json',
      Origin: 'https://supabase.com',
      Referer: 'https://supabase.com/dashboard/'
    }
  },
  config: supabaseConfigSchema,
  capabilities: [
    defineCapability({
      id: 'summary',
      label: 'Summary',
      fetch: fetchSupabaseBilling,
      build: (raw) => buildSupabaseSummaryResult(billingReport(raw)),
      sample: sampleSupabaseBilling
    }),
    defineCapability({
      id: 'billing',
      label: 'Billing',
      fetch: fetchSupabaseBilling,
      build: (raw) => buildSupabaseBillingTab(billingReport(raw)),
      sample: sampleSupabaseBilling
    }),
    defineCapability({
      id: 'usage',
      label: 'Usage',
      fetch: fetchSupabaseUsage,
      build: (raw) => buildSupabaseUsageResult(buildSupabaseUsage(raw.usage, raw.projects)),
      sample: sampleSupabaseUsage
    }),
    defineCapability({
      id: 'members',
      label: 'Members',
      fetch: fetchSupabaseMembers,
      build: (raw) => members.result(buildSupabaseMembers(raw)),
      sample: sampleSupabaseMembers
    })
  ],
  probe: async (ctx) => {
    // /platform/organizations is the cheapest authed call — a 200 forces the offscreen spa-bearer mint and
    // proves the Studio JWT is live (no org slug needed).
    await ctx.client.get(`${API}/platform/organizations`)
  }
})
