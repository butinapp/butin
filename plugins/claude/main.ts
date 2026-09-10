import {
  defineCapability,
  defineConfigSchema,
  definePlugin,
  type CollectContext,
  type ConfigOf,
  type ConfigOption
} from '@butinapp/sdk'
import { capabilityResult, record, table, type CapabilityResult } from '@butinapp/sdk/data'
import { billing, members, type BillingInvoiceInput, type BillingStat, type MembersInput } from '@butinapp/sdk/presets'
import { centsToMajor, epochSecDay, monthStart, normalizeCurrency, round2, startCase } from '@butinapp/sdk/util'

import { sampleClaudeAnalytics, sampleClaudeBilling, sampleClaudeMembers } from './sample.js'

export type InvoiceCategory = 'seats' | 'usage'

export interface InvoiceRecord extends BillingInvoiceInput {
  date: string
  createdTs: number
  amount: number
  currency: string
  status: string
  numSeats: number | null
  category: InvoiceCategory
  pdfUrl: string | null
  hostedUrl: string | null
}

export interface MonthlyBilling {
  month: string
  seats: number
  usage: number
}

export interface SeatLine {
  tier: string
  description: string
  count: number
  unitPrice: number
  total: number
}

export interface ClaudeBillingReport {
  // Live spend accrued so far in the open period (USD MTD), NOT a forecast. `null` when no running figure is exposed.
  currentMtd: number | null
  // Fixed recurring portion already in `currentMtd` (flat sub/seat base fee), so a base fee at the period
  // boundary doesn't read as a usage spike.
  baseCost?: number | null
  capturedAt: string
  currency: string
  limitEnabled: boolean
  monthlyLimit: number | null
  usedThisPeriod: number
  prepaidBalance: number
  autoReload: { enabled: boolean; threshold: number; reloadTo: number } | null
  stripeBalance: number
  seatLines: SeatLine[]
  seatSubtotal: number
  seatTotalWithTax: number
  nextChargeDate: string | null
  monthly: MonthlyBilling[]
  invoices: InvoiceRecord[]
}

interface RawInvoice {
  total: number
  currency?: string
  status?: string
  created_ts: number
  num_seats?: number | null
  invoice_pdf_url?: string | null
  hosted_invoice_url?: string | null
}
interface RawUpcomingInvoice {
  invoice?: {
    total?: number
    currency?: string
    lines?: Array<{ total?: number; num_seats?: number | null; description?: string }>
  }
}
interface RawOverageSpendLimit {
  is_enabled?: boolean
  monthly_credit_limit?: number | null
  used_credits?: number | null
  currency?: string
}
interface RawPrepaidCredits {
  amount?: number
  currency?: string
  auto_reload_settings?: {
    enabled?: boolean
    threshold_in_minor_units?: number
    reload_to_in_minor_units?: number
  } | null
}
interface RawStripeBalance {
  balance?: number
  currency?: string
}
interface RawSubscriptionDetails {
  next_charge_date?: string | null
  currency?: string
}
interface RawInvoicesPage {
  invoices?: RawInvoice[]
  has_more?: boolean
  next_page?: string | null
}

export interface RawBillingBundle {
  invoices: RawInvoice[]
  upcoming: RawUpcomingInvoice
  overage: RawOverageSpendLimit
  prepaid: RawPrepaidCredits
  balance: RawStripeBalance
  subscription: RawSubscriptionDetails
}

// org resolution
interface OrgSummary {
  uuid?: string
  name?: string
  capabilities?: string[]
}

// usage / team-analytics wire shapes
interface RawMembersCounts {
  total?: number
  by_seat_tier?: Record<string, number>
  pending_invites_total?: number
}
interface RawMembersLimit {
  seat_tier_quantities?: Record<string, number>
}
interface RawAnalyticsSubscription {
  status?: string
  currency?: string
  next_charge_date?: string | null
}
interface RawRankings {
  users?: Array<{ account_uuid: string; email_address: string; seat_tier: string; value: number }>
}
interface RawSpendTimeseries {
  data_points?: Array<{ date: string; value: number }>
  currency?: string
}
interface RawModelSpend {
  model_family: string
  data_points?: Array<{ date: string; value: number }>
}
interface RawSpendByModel {
  models?: RawModelSpend[]
}
interface RawMetric {
  value: number
}
interface RawActivityOverview {
  dau?: RawMetric
  wau?: RawMetric
  mau?: RawMetric
  utilization?: RawMetric
  stickiness?: number | null
}

export interface RawAnalyticsBundle {
  counts: RawMembersCounts
  limit: RawMembersLimit
  subscription: RawAnalyticsSubscription
  rankings: RawRankings
  spendTs: RawSpendTimeseries
  spendByModel: RawSpendByModel
  activity: RawActivityOverview
}

// members wire shapes
interface RawMemberAccount {
  uuid?: string
  email_address?: string
  full_name?: string | null
  name?: string | null
}

interface RawMember {
  account?: RawMemberAccount
  account_uuid?: string
  email_address?: string
  full_name?: string | null
  name?: string | null
  role?: string | null
}

export type RawMembersList = RawMember[] | { members?: RawMember[] }

// The billing fetch's raw output: the wire bundle + the capture instant the report stamps. Bundled so a
// capability's `build` stays pure (the live capturedAt rides in rather than a new Date() inside build).
export type ClaudeBillingRaw = { bundle: RawBillingBundle; capturedAt: string }

const USAGE_INVOICE_MIN_MINOR = 50000

const lineTier = (description: string): string =>
  /premium/i.test(description) ? 'team_tier_1' : /standard/i.test(description) ? 'team_standard' : 'unknown'

export const classifyInvoice = (inv: RawInvoice): InvoiceCategory | null => {
  const status = inv.status ?? 'paid'

  if (status === 'void' || status === 'uncollectible') {
    return null
  }

  if (inv.num_seats != null) {
    return 'seats'
  }

  return inv.total >= USAGE_INVOICE_MIN_MINOR ? 'usage' : 'seats'
}

export const buildClaudeBillingReport = (raw: RawBillingBundle, capturedAt: string): ClaudeBillingReport => {
  const currency = normalizeCurrency(raw.overage.currency ?? raw.invoices[0]?.currency ?? raw.prepaid.currency, 'CAD')

  const invoices: InvoiceRecord[] = []

  for (const inv of raw.invoices) {
    const category = classifyInvoice(inv)

    if (category == null) {
      continue
    }

    invoices.push({
      date: epochSecDay(inv.created_ts) ?? '',
      createdTs: inv.created_ts,
      amount: centsToMajor(inv.total),
      currency: normalizeCurrency(inv.currency ?? currency),
      status: inv.status ?? 'paid',
      numSeats: inv.num_seats ?? null,
      category,
      pdfUrl: inv.invoice_pdf_url ?? null,
      hostedUrl: inv.hosted_invoice_url ?? null
    })
  }

  invoices.sort((a, b) => b.createdTs - a.createdTs)

  const byMonth = new Map<string, MonthlyBilling>()

  for (const inv of invoices) {
    const month = inv.date.slice(0, 7)
    const row = byMonth.get(month) ?? { month, seats: 0, usage: 0 }

    row[inv.category] += inv.amount
    byMonth.set(month, row)
  }

  const monthly = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month))

  const seatLines: SeatLine[] = (raw.upcoming.invoice?.lines ?? []).map((l) => {
    const count = l.num_seats ?? 0
    const total = centsToMajor(l.total)

    return {
      tier: lineTier(l.description ?? ''),
      description: l.description ?? '',
      count,
      unitPrice: count > 0 ? total / count : 0,
      total
    }
  })
  const seatSubtotal = seatLines.reduce((s, l) => s + l.total, 0)
  const ar = raw.prepaid.auto_reload_settings

  return {
    capturedAt,
    currency,
    limitEnabled: raw.overage.is_enabled ?? false,
    monthlyLimit: raw.overage.monthly_credit_limit != null ? centsToMajor(raw.overage.monthly_credit_limit) : null,
    usedThisPeriod: centsToMajor(raw.overage.used_credits),
    currentMtd: centsToMajor(raw.overage.used_credits),
    prepaidBalance: centsToMajor(raw.prepaid.amount),
    autoReload: ar
      ? {
          enabled: ar.enabled ?? false,
          threshold: centsToMajor(ar.threshold_in_minor_units),
          reloadTo: centsToMajor(ar.reload_to_in_minor_units)
        }
      : null,
    stripeBalance: centsToMajor(raw.balance.balance),
    seatLines,
    seatSubtotal,
    seatTotalWithTax: centsToMajor(raw.upcoming.invoice?.total),
    nextChargeDate: raw.subscription.next_charge_date ?? null,
    monthly,
    invoices
  }
}

// Capability markers that indicate the org actually carries team billing/analytics — the endpoints that
// 403 on the wrong (personal) org. Best-effort: used only to mark a default in the picker, never to choose
// silently, so a miss is harmless (the user sees real names and picks).
const TEAM_MARKERS = ['claude_team', 'team', 'enterprise', 'billing']

const hasTeamCapability = (o: OrgSummary): boolean => (o.capabilities ?? []).some((c) => TEAM_MARKERS.includes(c))

// Map the /api/organizations payload onto combobox options (the Settings picker). Each option carries the
// org name as label and the uuid as subtext; `recommended` marks the best-guess team/billing org so the
// form can pre-select it as a smart default — but only when there's actually a choice to make.
export const buildOrgOptions = (orgs: OrgSummary[]): ConfigOption[] => {
  const valid = (orgs ?? []).filter((o): o is OrgSummary & { uuid: string } => typeof o.uuid === 'string' && !!o.uuid)
  const bestIdx = valid.findIndex(hasTeamCapability)

  return valid.map((o, i) => ({
    value: o.uuid,
    label: o.name?.trim() || o.uuid,
    description: o.name?.trim() ? o.uuid : undefined,
    recommended: valid.length > 1 && i === (bestIdx >= 0 ? bestIdx : 0)
  }))
}

// Resolve which org to read with ZERO config. A single-org account (the norm) is unambiguous → use it.
// With multiple orgs we can't guess safely (every billing/analytics call is org-scoped and the wrong org
// 403s), so force a deliberate pick in Settings instead of silently choosing.
export const resolveOrgId = (orgs: OrgSummary[]): { ok: true; orgId: string } | { ok: false; error: string } => {
  const ids = (orgs ?? []).map((o) => o.uuid).filter((u): u is string => !!u)

  if (ids.length === 1) {
    return { ok: true, orgId: ids[0] }
  }

  if (ids.length === 0) {
    return { ok: false, error: 'No Claude organization found for this session.' }
  }

  return { ok: false, error: `You have ${ids.length} Claude organizations — pick one in Settings.` }
}

export const fetchOrgs = (get: <T>(url: string) => Promise<T>): Promise<OrgSummary[]> =>
  get<OrgSummary[]>('https://claude.ai/api/organizations')

// Org for a collector: the pinned config value, else the single org (zero-config), else throw the friendly
// "pick one in Settings" message. Throws (never returns undefined) so callers don't re-guard.
const resolveOrgForCollect = async (ctx: CollectContext<ClaudeConfig>): Promise<string> => {
  const configured = ctx.config.orgId?.trim()

  if (configured) {
    return configured
  }

  const result = resolveOrgId(await fetchOrgs((url) => ctx.client.get(url)))

  if (!result.ok) {
    throw new Error(result.error)
  }

  return result.orgId
}

// Compact money for a caption line (whole units, grouped): 5614 → '$5,614'.
const captionMoney = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`

// The recurring-seat lines as one breakdown string: '76 seats · 56×$34 · 20×$171'. undefined with no lines.
export const seatBreakdownCaption = (lines: SeatLine[]): string | undefined => {
  if (lines.length === 0) {
    return undefined
  }

  const total = lines.reduce((s, l) => s + l.count, 0)
  const parts = lines.map((l) => `${l.count}×${captionMoney(l.unitPrice)}`)

  return `${total} seats · ${parts.join(' · ')}`
}

// Summary tab — its spend.mtd summary is what the cross-service Overview rolls up. The shared
// billing.summary preset (account stat + monthly-spend chart + spend.mtd summary), plus rich headline
// cards: a usage-limit progress bar (used / monthly cap), recurring seats (/mo + per-tier breakdown), prepaid
// balance (auto-reload terms), and next charge (seats incl. tax). The monthly chart buckets the invoice list
// the report carries (seats + usage charges per month). The currency caption disambiguates CAD billing from
// the USD usage figures on the Usage tab.
export const buildClaudeSummaryResult = (report: ClaudeBillingReport): CapabilityResult => {
  const ccy = report.currency
  const ar = report.autoReload

  const stats: (BillingStat | null)[] = [
    report.limitEnabled && report.monthlyLimit != null && report.monthlyLimit > 0
      ? {
          key: 'usageLimit',
          label: 'Usage limit (this period)',
          role: 'money',
          currency: ccy,
          value: report.usedThisPeriod,
          max: report.monthlyLimit,
          caption: `${Math.round((report.usedThisPeriod / report.monthlyLimit) * 100)}% of monthly cap`
        }
      : null,
    report.seatSubtotal > 0
      ? {
          key: 'recurringSeats',
          label: 'Recurring seats',
          role: 'money',
          currency: ccy,
          value: report.seatSubtotal,
          unit: '/mo',
          caption: seatBreakdownCaption(report.seatLines)
        }
      : null,
    {
      key: 'prepaidBalance',
      label: 'Prepaid balance',
      role: 'money',
      currency: ccy,
      value: report.prepaidBalance,
      caption: ar?.enabled ? `auto-reload ≤ ${captionMoney(ar.threshold)} → ${captionMoney(ar.reloadTo)}` : undefined
    },
    report.nextChargeDate
      ? {
          key: 'nextCharge',
          label: 'Next charge',
          role: 'timestamp',
          value: report.nextChargeDate,
          caption: report.seatTotalWithTax > 0 ? `seats ${captionMoney(report.seatTotalWithTax)} incl. tax` : undefined
        }
      : null,
    { key: 'invoiceCount', label: 'Invoices', role: 'count', value: report.invoices.length }
  ]

  return billing.summary({
    currentMtd: report.currentMtd,
    // Overage credits accruing live over the open period.
    mtdBasis: 'accrued',
    currency: ccy,
    currentMtdCaption: `invoiced · ${ccy}`,
    invoices: report.invoices,
    stats: stats.filter((s): s is BillingStat => s !== null)
  })
}

interface InvoiceRow {
  // Hidden — the Stripe invoice id (the invoice-PDF URL's stable path, minus its query) rides as the ledger
  // key. A month carries both a seats invoice and a usage invoice, so date/amount can't tell them apart; the
  // invoice URL's path is each one's unique identity.
  id: string
  date: string | null
  amount: number
  status: string
  pdfUrl: string | null
  // Not a rendered column — carried for the download filename.
  name: string
}

interface MonthCategoryRow {
  month: string
  category: string
  amount: number
}

// Long-format seats/usage rows (one per month per category) for the stacked monthly breakdown chart.
export const monthlyCategoryRows = (monthly: MonthlyBilling[]): MonthCategoryRow[] =>
  monthly.flatMap((m) => [
    { month: m.month, category: 'Seats', amount: m.seats },
    { month: m.month, category: 'Usage', amount: m.usage }
  ])

// Billing tab — a stacked monthly seats-vs-usage breakdown over the invoice history (seats + usage charges),
// not the Overview rollup. The headline (MTD / prepaid / monthly total) lives on Summary.
export const buildClaudeBillingTab = (report: ClaudeBillingReport): CapabilityResult => {
  const currency = report.currency
  const byCategory = table<MonthCategoryRow>({
    id: 'monthlyByCategory',
    columns: [
      { key: 'month', label: 'Month', role: 'timestamp' },
      { key: 'category', label: 'Category', role: 'label' },
      { key: 'amount', label: 'Spend', role: 'money', currency }
    ],
    rows: monthlyCategoryRows(report.monthly),
    // One row per (month, category) — the composite keys the ledger so the breakdown accumulates past the window.
    key: ['month', 'category']
  })

  const invoices = table<InvoiceRow>({
    id: 'invoices',
    columns: [
      { key: 'date', label: 'Date', role: 'timestamp' },
      { key: 'amount', label: 'Amount', role: 'money', currency },
      { key: 'status', label: 'Status', role: 'status' },
      { key: 'pdfUrl', label: 'PDF', role: 'url' },
      { key: 'name', role: 'label', hidden: true },
      { key: 'id', role: 'identifier', hidden: true }
    ],
    rows: report.invoices.map((i, idx) => {
      const url = i.pdfUrl ?? i.hostedUrl ?? null

      return {
        // The stable invoice-URL path (query stripped) is the Stripe invoice id; a per-row synthetic backs the rare gap.
        id: url ? url.split('?')[0] : `inv-${idx}`,
        date: i.date || null,
        amount: i.amount,
        status: i.status,
        pdfUrl: url,
        name: `Invoice ${i.date || 'unknown'}`
      }
    }),
    // The invoice-URL id is each invoice's stable identity — key it so an invoice accumulates history past the fetch window.
    key: 'id'
  })

  // The invoices table is downloadable: each row's invoice PDF (pdfUrl) becomes a selectable file the host
  // downloads via the shared engine (selection + Download all/selected + per-row Open + on-disk size). The
  // stacked breakdown leads (skipped when there are no months yet).
  return capabilityResult({
    sections: [
      report.monthly.length > 0
        ? byCategory.timeseries({
            x: 'month',
            y: 'amount',
            stackBy: 'category',
            granularity: 'monthly',
            title: 'Spend by category'
          })
        : null,
      invoices.fileTable({
        title: 'Invoices',
        name: 'name',
        source: { url: 'pdfUrl' },
        ext: 'pdf',
        category: 'Invoices'
      })
    ]
  })
}

const MAX_INVOICE_PAGES = 6

// Summary + Billing both need the same billing bundle (invoices + the five scalar Stripe/org endpoints).
// Both collects call loadClaudeBilling; the core query cache dedupes the underlying reads (keyed by org id
// via the call site).
const fetchClaudeBilling = async (ctx: CollectContext, orgId: string): Promise<ClaudeBillingRaw> => {
  const get = <T>(url: string) => ctx.client.get<T>(url)
  const org = `https://claude.ai/api/organizations/${orgId}`
  const stripe = `https://claude.ai/api/stripe/${orgId}`

  const invoicesP = (async () => {
    const all: RawInvoice[] = []
    let page = ''

    for (let i = 0; i < MAX_INVOICE_PAGES; i += 1) {
      const res = await get<RawInvoicesPage>(`${stripe}/invoices?limit=12&page=${page}`)

      if (!res?.invoices?.length) {
        break
      }

      all.push(...res.invoices)

      if (!res.has_more || !res.next_page) {
        break
      }

      page = res.next_page
    }

    return all
  })()

  const [invoices, upcoming, overage, prepaid, balance, subscription] = await Promise.all([
    invoicesP,
    get<RawUpcomingInvoice>(`${stripe}/upcoming_invoice`),
    get<RawOverageSpendLimit>(`${org}/overage_spend_limit`),
    get<RawPrepaidCredits>(`${org}/prepaid/credits`),
    get<RawStripeBalance>(`${stripe}/balance`),
    get<RawSubscriptionDetails>(`${org}/subscription_details?cached=true`)
  ])

  return {
    bundle: {
      invoices,
      upcoming: upcoming ?? {},
      overage: overage ?? {},
      prepaid: prepaid ?? {},
      balance: balance ?? {},
      subscription: subscription ?? {}
    },
    capturedAt: new Date().toISOString()
  }
}

// --- usage: claude.ai team analytics (spend / seats / activity). Same cookie session as billing. ---
// claude.ai's team analytics spend is DOLLARS (USD). Endpoints under /api/organizations/{orgId}/.

// The by-model API returns one entry per specific model version, each tagged with its family. Collapse to
// one row per family, summing spend across that family's versions; costliest first.
export const aggregateSpendByModelFamily = (models: RawModelSpend[]): Array<{ model: string; spend: number }> => {
  const byFamily = new Map<string, number>()

  for (const m of models) {
    let sum = byFamily.get(m.model_family) ?? 0

    for (const p of m.data_points ?? []) {
      sum += p.value
    }

    byFamily.set(m.model_family, sum)
  }

  return [...byFamily.entries()]
    .map(([model, spend]) => ({ model, spend: round2(spend) }))
    .sort((a, b) => b.spend - a.spend)
}

interface ModelDayRow {
  date: string
  model: string
  value: number
}

// Long-format per-day spend per model family for the stacked daily breakdown — collapses each family's model
// versions onto one (date, family) cell, summing same-day values. Family + first-seen order is preserved.
export const modelDailyRows = (models: RawModelSpend[]): ModelDayRow[] => {
  const rows: ModelDayRow[] = []
  const at = new Map<string, number>()

  for (const m of models) {
    for (const p of m.data_points ?? []) {
      const key = `${m.model_family}\u0000${p.date}`
      const i = at.get(key)

      if (i == null) {
        at.set(key, rows.length)
        rows.push({ date: p.date, model: m.model_family, value: round2(p.value) })
      } else {
        rows[i]!.value = round2(rows[i]!.value + p.value)
      }
    }
  }

  return rows
}

const PREMIUM_SEAT_USD = 150
const PREMIUM_HEAVY_USAGE_USD = 200
const PREMIUM_TIER = 'team_tier_1'
const STANDARD_TIER = 'team_standard'

// Pure seat suggestion from tier + MTD usage cost. A standard seat costing more than a premium seat
// should upgrade; a heavy premium user can't upgrade further, so nudge them to pace usage.
export const seatRecommendation = (seatTier: string, spend: number): string => {
  if (seatTier === STANDARD_TIER && spend > PREMIUM_SEAT_USD) {
    return 'Upgrade to Premium'
  }

  if (seatTier === PREMIUM_TIER && spend > PREMIUM_HEAVY_USAGE_USD) {
    return 'Monitor usage limits'
  }

  return 'OK'
}

interface AnalyticsOverviewRow {
  mtdSpend: number
  seatsUsed: number
  seatsPurchased: number
  pendingInvites: number
  status: string
  nextCharge: string | null
}

interface SpendPointRow {
  date: string
  value: number
}

interface ByModelRow {
  model: string
  spend: number
}

interface MemberRankRow {
  email: string
  tier: string
  spend: number
  suggestion: string
}

interface ActivityRow {
  dau: number
  wau: number
  mau: number
  utilization: number | null
  stickiness: number | null
}

// claude.ai's analytics report utilization & stickiness as whole-number percents (92.2 means 92.2%). The
// 'percent' role expects a 0..1 fraction (it scales ×100 for display), so normalize at the edge or the value
// renders 100× too large.
const percentToFraction = (pct: number | null | undefined): number | null => (pct == null ? null : pct / 100)

// A seat tier's display name: the two known tiers map to Anthropic's UI labels; anything else is title-cased
// (`team_tier_1` → 'Premium', `team_standard` → 'Standard', '' → 'Unknown', `team_enterprise` → 'Team Enterprise').
export const seatTierLabel = (tier: string): string =>
  tier === PREMIUM_TIER ? 'Premium' : tier === STANDARD_TIER ? 'Standard' : tier ? startCase(tier) : 'Unknown'

// Per-tier seat mix as a caption: { team_standard: 56, team_tier_1: 20 } → '56 Standard · 20 Premium'.
// undefined when no tiers carry seats (nothing to break down under the seats card).
export const seatMixCaption = (byTier: Record<string, number> | undefined): string | undefined => {
  const parts = Object.entries(byTier ?? {})
    .filter(([, n]) => n > 0)
    .map(([tier, n]) => `${n} ${seatTierLabel(tier)}`)

  return parts.length > 0 ? parts.join(' · ') : undefined
}

// Maps the analytics bundle onto a multi-view CapabilityResult.
export const buildClaudeAnalytics = (raw: RawAnalyticsBundle): CapabilityResult => {
  const purchased = raw.limit.seat_tier_quantities ?? {}
  const seatsPurchased = Object.values(purchased).reduce((s, n) => s + n, 0)

  const spendPoints = (raw.spendTs.data_points ?? []).map((p) => ({ date: p.date, value: p.value }))
  const mtdSpend = round2(spendPoints.reduce((s, p) => s + p.value, 0))
  const currency = raw.spendTs.currency ?? 'USD'

  const overview = record<AnalyticsOverviewRow>({
    id: 'overview',
    fields: [
      { key: 'mtdSpend', label: 'Spend (MTD)', role: 'money', currency },
      { key: 'seatsUsed', label: 'Seats', role: 'count' },
      { key: 'seatsPurchased', label: 'Seats purchased', role: 'count' },
      { key: 'pendingInvites', label: 'Pending invites', role: 'count' },
      { key: 'status', label: 'Status', role: 'label' },
      { key: 'nextCharge', label: 'Next charge', role: 'timestamp' }
    ],
    value: {
      mtdSpend,
      seatsUsed: raw.counts.total ?? 0,
      seatsPurchased,
      pendingInvites: raw.counts.pending_invites_total ?? 0,
      status: raw.subscription.status ?? 'unknown',
      nextCharge: raw.subscription.next_charge_date ?? null
    }
  })

  const spend = table<SpendPointRow>({
    id: 'spend',
    columns: [
      { key: 'date', label: 'Date', role: 'timestamp' },
      { key: 'value', label: 'Spend', role: 'money', currency }
    ],
    rows: spendPoints.map((p) => ({ date: p.date, value: p.value })),
    key: 'date'
  })

  const byModel = table<ByModelRow>({
    id: 'byModel',
    columns: [
      { key: 'model', label: 'Model', role: 'label' },
      { key: 'spend', label: 'Spend', role: 'money', currency }
    ],
    rows: aggregateSpendByModelFamily(raw.spendByModel.models ?? []).map((m) => ({ model: m.model, spend: m.spend })),
    key: 'model'
  })

  const byModelDaily = table<ModelDayRow>({
    id: 'byModelDaily',
    columns: [
      { key: 'date', label: 'Date', role: 'timestamp' },
      { key: 'model', label: 'Model', role: 'label' },
      { key: 'value', label: 'Spend', role: 'money', currency }
    ],
    rows: modelDailyRows(raw.spendByModel.models ?? []),
    // One row per (date, model family) — the composite keys the daily breakdown for accumulation.
    key: ['date', 'model']
  })

  // Keyed by email so the ledger records each member's row across captures; `spend` is an MTD counter that
  // resets monthly, so core differences its daily readings into a per-member daily-usage series (the trend).
  const members = table<MemberRankRow>({
    id: 'members',
    key: 'email',
    columns: [
      { key: 'email', label: 'Member', role: 'label' },
      { key: 'tier', label: 'Seat', role: 'category' },
      { key: 'spend', label: 'Spend (MTD)', role: 'money', currency, accrual: 'cumulative', resetPeriod: 'monthly' },
      { key: 'suggestion', label: 'Suggestion', role: 'label' }
    ],
    rows: (raw.rankings.users ?? []).map((u) => ({
      email: u.email_address,
      tier: seatTierLabel(u.seat_tier),
      spend: round2(u.value),
      suggestion: seatRecommendation(u.seat_tier, u.value)
    }))
  })

  const activity = record<ActivityRow>({
    id: 'activity',
    fields: [
      { key: 'dau', label: 'Daily active', role: 'count' },
      { key: 'wau', label: 'Weekly active', role: 'count' },
      { key: 'mau', label: 'Monthly active', role: 'count' },
      { key: 'utilization', label: 'Utilization', role: 'percent' },
      { key: 'stickiness', label: 'Stickiness', role: 'percent' }
    ],
    value: {
      dau: raw.activity.dau?.value ?? 0,
      wau: raw.activity.wau?.value ?? 0,
      mau: raw.activity.mau?.value ?? 0,
      utilization: percentToFraction(raw.activity.utilization?.value),
      stickiness: percentToFraction(raw.activity.stickiness)
    }
  })

  return capabilityResult({
    sections: [
      // Spend (MTD) is the USD usage meter (captioned to disambiguate it from the CAD billing currency on the
      // Summary/Billing tabs); Seats shows used / purchased with a progress bar + the per-tier mix.
      overview.stat({
        fields: [
          { key: 'mtdSpend', caption: `usage meter · ${currency}` },
          { key: 'seatsUsed', max: seatsPurchased, caption: seatMixCaption(raw.counts.by_seat_tier) },
          'pendingInvites',
          'status',
          'nextCharge'
        ]
      }),
      spend.timeseries({ x: 'date', y: 'value', granularity: 'daily', title: 'Spend' }),
      byModelDaily.dataset.rows.length > 0
        ? byModelDaily.timeseries({
            x: 'date',
            y: 'value',
            stackBy: 'model',
            granularity: 'daily',
            title: 'Spend by model over time'
          })
        : null,
      byModel.table({ title: 'Spend by model' }),
      members.table({ title: 'Members' }),
      activity.stat({ title: 'Activity' })
    ],
    summaries: [
      spend.summary({
        section: 'other',
        label: 'Spend (MTD)',
        value: mtdSpend,
        role: 'money',
        currency,
        x: 'date',
        y: 'value'
      })
    ]
  })
}

const fetchClaudeAnalytics = async (ctx: CollectContext, orgId: string): Promise<RawAnalyticsBundle> => {
  const get = <T>(url: string) => ctx.client.get<T>(url)
  const org = `https://claude.ai/api/organizations/${orgId}`
  const periodStart = monthStart(new Date())
  const [counts, limit, subscription, rankings, spendTs, spendByModel, activity] = await Promise.all([
    get<RawMembersCounts>(`${org}/members/counts`),
    get<RawMembersLimit>(`${org}/members_limit?cached=true`),
    get<RawAnalyticsSubscription>(`${org}/subscription_details?cached=true`),
    get<RawRankings>(`${org}/analytics/users/rankings?metric=spend&start_date=${periodStart}&limit=100`),
    get<RawSpendTimeseries>(`${org}/analytics/spend/timeseries?start_date=${periodStart}`),
    get<RawSpendByModel>(`${org}/analytics/spend/by-model?start_date=${periodStart}`),
    get<RawActivityOverview>(`${org}/analytics/activity/overview`)
  ])

  return {
    counts: counts ?? {},
    limit: limit ?? {},
    subscription: subscription ?? {},
    rankings: rankings ?? {},
    spendTs: spendTs ?? {},
    spendByModel: spendByModel ?? {},
    activity: activity ?? {}
  }
}

// --- members: the team roster (who has access + their org role) ---
// claude.ai's settings/members page is backed by /api/organizations/{orgId}/members. A roster row carries the
// person either nested under `account` or flattened on the row (defensive to both); `role` is the org
// permission role (admin / developer / billing / member …), coloured by the preset's ROLE_TONES. This is the
// access list — distinct from the usage tab's spend-ranked "top members" table.

// Normalizes either response envelope (bare array or { members }) and either identity placement (nested
// `account` or flattened) onto the standard members preset input.
export const buildClaudeMembers = (raw: RawMembersList | undefined | null): MembersInput => {
  const rows = Array.isArray(raw) ? raw : (raw?.members ?? [])

  return {
    members: rows.map((m, i) => {
      const acct = m.account ?? {}
      const email = m.email_address ?? acct.email_address ?? undefined
      const name = (m.full_name ?? m.name ?? acct.full_name ?? acct.name ?? '') || undefined

      return {
        id: acct.uuid ?? m.account_uuid ?? email ?? String(i),
        name,
        email,
        role: m.role ?? undefined
      }
    })
  }
}

const fetchClaudeMembers = (ctx: CollectContext, orgId: string): Promise<RawMembersList> =>
  ctx.client.get<RawMembersList>(`https://claude.ai/api/organizations/${orgId}/members?limit=200`)

export const claudeConfigSchema = defineConfigSchema([
  {
    key: 'orgId',
    label: 'Organization',
    kind: 'combobox',
    placeholder: 'Pick your organization…',
    help: 'Auto-used when you have only one. With several, pick which one Butin should read — the others 403.',
    loadOptions: async (ctx) => buildOrgOptions(await fetchOrgs((url) => ctx.client.get(url)))
  }
])

export type ClaudeConfig = ConfigOf<typeof claudeConfigSchema>

export const claudePlugin = definePlugin({
  reportingCurrency: 'USD',
  meta: {
    id: 'claude',
    name: 'Claude',
    vendor: 'Anthropic',
    category: 'ai',
    color: '#d97757',
    description: 'Claude.ai billing, team usage analytics, and members — from your own logged-in session.',
    homepage: 'https://claude.ai',
    dashboardUrl: 'https://claude.ai/settings/billing'
  },
  session: {
    loginUrl: 'https://claude.ai/settings/members',
    dashboardMarkers: ['/settings'],
    cookieDomains: ['claude.ai'],
    requiredCookie: 'sessionKey'
  },
  auth: { kind: 'cookie' },
  // UA omitted on purpose: capture + replay both default to the canonical Butin browser identity
  // (current Chrome), kept in lockstep so cf_clearance stays valid.
  transport: { requiresBrowserEngine: true },
  config: claudeConfigSchema,
  capabilities: [
    defineCapability({
      id: 'summary',
      label: 'Summary',
      fetch: async (ctx) => fetchClaudeBilling(ctx, await resolveOrgForCollect(ctx)),
      build: (raw) => buildClaudeSummaryResult(buildClaudeBillingReport(raw.bundle, raw.capturedAt)),
      sample: sampleClaudeBilling
    }),
    defineCapability({
      id: 'billing',
      label: 'Billing',
      fetch: async (ctx) => fetchClaudeBilling(ctx, await resolveOrgForCollect(ctx)),
      build: (raw) => buildClaudeBillingTab(buildClaudeBillingReport(raw.bundle, raw.capturedAt)),
      sample: sampleClaudeBilling
    }),
    defineCapability({
      id: 'usage',
      label: 'Usage',
      fetch: async (ctx) => fetchClaudeAnalytics(ctx, await resolveOrgForCollect(ctx)),
      build: buildClaudeAnalytics,
      sample: sampleClaudeAnalytics
    }),
    defineCapability({
      id: 'members',
      label: 'Members',
      fetch: async (ctx) => fetchClaudeMembers(ctx, await resolveOrgForCollect(ctx)),
      build: (raw) => members.result(buildClaudeMembers(raw)),
      sample: sampleClaudeMembers
    })
  ],
  // Probe just confirms the session can list orgs (a live session) — NOT that a single org resolves, so a
  // multi-org account still tests healthy; the org pick is a separate, deliberate Settings step.
  probe: async (ctx) => {
    const orgs = await fetchOrgs((url) => ctx.client.get(url))

    if (!Array.isArray(orgs) || orgs.length === 0) {
      throw new Error('No Claude organization found for this session.')
    }
  }
})
