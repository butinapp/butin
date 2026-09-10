import {
  defineCapability,
  defineConfigSchema,
  definePlugin,
  type CollectContext,
  type ConfigOf,
  type ConfigOption
} from '@butinapp/sdk'
import { capabilityResult, record, table, type CapabilityResult } from '@butinapp/sdk/data'
import { DateTime } from '@butinapp/sdk/libs'
import { billing, members, type BillingInvoiceInput, type MembersInput } from '@butinapp/sdk/presets'
import { MONTH_ABBR, asArray, centsToMajor, getReportingZone, isoDay, normalizeCurrency } from '@butinapp/sdk/util'

import { sampleAnthropicAnalytics, sampleAnthropicBilling, sampleAnthropicMembers } from './sample.js'

// Anthropic's API platform (platform.claude.com — the console behind console.anthropic.com). The platform
// bills the API in ARREARS: a monthly `usage_invoice` for the prior service period plus a running
// `current_spend` for the open period that resets at the cycle boundary. platform.claude.com sits behind
// the edge only accepts a real browser, so transport is `electron` (requiresBrowserEngine) replaying the
// captured `sessionKey` cookie; the console also wants an `anthropic-client-platform: web_console` header.
//
// All money from the console API is in CENTS (current_spend.amount / 100 ≈ org MTD dollars; invoice amounts
// match the Stripe totals; `spend_limits_v2.limit_usd` is ALSO cents despite the name) → centsToMajor at the edge.

// ── constants ───────────────────────────────────────────────────────────────────────

const ORIGIN = 'https://platform.claude.com'
// Bill org by id: /api/organizations/<id>/… (billing) and /api/console/organizations/<id>/… (console).
const orgPath = (orgId: string) => `${ORIGIN}/api/organizations/${orgId}`
const consolePath = (orgId: string) => `${ORIGIN}/api/console/organizations/${orgId}`

// Max invoice pages to walk (25/page) — bounds memory + latency.
const MAX_INVOICE_PAGES = 6
// How many months of per-member spend to show: current month + 3 previous.
const MONTHS_SHOWN = 4
const PERIOD_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

// ── types ─────────────────────────────────────────────────────────────────────────

// org resolution
interface OrgSummary {
  uuid?: string
  name?: string
}

// billing wire shapes (only the fields we use)
export interface RawConsoleInvoice {
  /** 'usage_invoice' (the monthly API bill) | 'prepaid_credits' (a top-up). */
  type: string
  invoice_status: string
  effective_at: string
  /** Amount in CENTS. */
  amount: number
  /** e.g. "May 01 2026 - May 31 2026"; null for credit purchases. */
  service_period: string | null
  download_url: string | null
  hosted_invoice_url: string | null
}
export interface RawCurrentSpend {
  /** Open-period spend in CENTS. */
  amount?: number
  resets_at?: string | null
}
export interface RawSpendLimit {
  /** Threshold in CENTS, despite the `_usd` name. */
  limit_usd: number
  /** 'notify_only' (alert) | 'notify_and_pause' (hard cap). */
  limit_action: string
}
export interface RawSpendLimitsV2 {
  spend_limits?: RawSpendLimit[]
}
export interface RawPaymentMethod {
  brand?: string
  last4?: string
}
export interface RawBillingEmails {
  primary_email?: string | null
}
interface RawInvoicesPage {
  invoices?: RawConsoleInvoice[]
  has_more?: boolean
  next_page?: string | null
}

export interface RawBillingBundle {
  invoices: RawConsoleInvoice[]
  currentSpend: RawCurrentSpend
  spendLimits: RawSpendLimitsV2
  paymentMethod: RawPaymentMethod
  billingEmails: RawBillingEmails
  /** From prepaid/credits.currency, defaulted to USD by the fetcher. */
  currency: string
}

type InvoiceKind = 'usage' | 'credits'

interface BillingInvoice {
  /** YYYY-MM-DD: usage invoices dated by their service-period month, credits by effective_at (see below). */
  date: string
  effectiveTs: number
  kind: InvoiceKind
  status: string
  servicePeriod: string | null
  /** USD. */
  amount: number
  pdfUrl: string | null
  hostedUrl: string | null
}

export interface AnthropicBillingReport {
  capturedAt: string
  currency: string
  /** Open-period (MTD) spend in USD. */
  currentSpend: number
  resetsAt: string | null
  /** The notify_and_pause hard cap in USD, or null if none set. */
  pauseLimit: number | null
  /** currentSpend as a whole-percent of pauseLimit, or null. */
  pauseLimitPct: number | null
  paymentMethod: { brand: string; last4: string } | null
  billingEmail: string | null
  /** All invoices, newest first. */
  invoices: BillingInvoice[]
}

// usage / member-analytics wire shapes
export interface RawMember {
  id: string
  email: string
  name: string
  role: string
}
export interface RawApiKey {
  id: string
  name: string
  workspace_id: string | null
  created_at: string
  status: string
  expires_at: string | null
  partial_key_hint?: string
  created_by: { id: string }
}
export interface RawKeyUsage {
  api_keys: Array<{ id: string; last_used_at: string }>
}
export interface RawUsageCost {
  costs: Record<string, Array<{ key_id: string; total: number }>>
}
/** One month's usage_cost response, tagged with its period + display label. */
export interface MonthlyCost {
  periodStart: string
  label: string
  cost: RawUsageCost
}
export interface RawAnalyticsBundle {
  members: RawMember[]
  apiKeys: RawApiKey[]
  keyUsage: RawKeyUsage
  /** Newest month first. */
  monthlyCosts: MonthlyCost[]
  orgCurrentSpendCents: number
}

interface MonthColumn {
  periodStart: string
  label: string
}

/** One API key's details, shown in a member's expanded row and the API Keys tab. */
export interface ApiKeyDetail {
  id: string
  name: string
  partialKeyHint: string
  status: string
  /** Workspace UUID, or null for the default workspace. */
  workspaceId: string | null
  /** RFC 3339 creation time, or null for a synthesized (metadata-less) key. */
  createdAt: string | null
  lastUsed: string | null
  /** This key's spend (USD) in the newest month. */
  currentSpend: number
  /** RFC 3339 expiry, or null if the key never expires. */
  expiresAt: string | null
}

export interface AnthropicMemberRow {
  /** created_by user id (or "unattributed"). */
  creatorId: string
  email: string | null
  name: string | null
  role: string | null
  isMember: boolean
  /** Count of active (non-archived) keys this creator owns. */
  apiKeyCount: number
  /** USD spend keyed by month periodStart (YYYY-MM-01). */
  spendByMonth: Record<string, number>
  /** Convenience: the newest month's spend in USD (drives the default sort). */
  currentSpend: number
  /** Max last_used_at (ISO) across this creator's keys, or null. */
  lastUsed: string | null
  /** This creator's API keys (details for the expanded row), newest-spend first. */
  keys: ApiKeyDetail[]
}
export interface AnthropicAnalyticsReport {
  capturedAt: string
  /** Month columns, newest first. */
  months: MonthColumn[]
  /** Org-wide month-to-date spend in USD. */
  orgCurrentSpend: number
  rows: AnthropicMemberRow[]
}

// roster wire shape
export interface RawRosterMember {
  id?: string
  email?: string
  name?: string | null
  role?: string | null
}

// ── org resolution (shared) ──────────────────────────────────────────────────────────
// Every billing/usage call is org-scoped (the wrong org 403s), so resolve it with ZERO config when possible:
// a single-org account (the norm) is unambiguous → use it. With several, the Settings combobox lists them
// (fed by fetchAnthropicOrgs → buildOrgOptions) so the user picks; we never silently choose. The pinned config
// value always wins (and is the fallback if the list endpoint ever stops returning).

export const fetchAnthropicOrgs = async (get: <T>(url: string) => Promise<T>): Promise<OrgSummary[]> => {
  try {
    const orgs = await get<OrgSummary[]>(`${ORIGIN}/api/organizations`)

    return asArray<OrgSummary>(orgs)
  } catch {
    return []
  }
}

// Map the /api/organizations payload onto the Settings combobox options: the org name as label, the uuid as
// value + subtext. `recommended` marks the first when there's an actual choice to make, so the picker pre-
// selects something instead of opening blank — but never silently chooses (the wrong org 403s).
export const buildOrgOptions = (orgs: OrgSummary[]): ConfigOption[] => {
  const valid = (orgs ?? []).filter((o): o is OrgSummary & { uuid: string } => typeof o.uuid === 'string' && !!o.uuid)

  return valid.map((o, i) => ({
    value: o.uuid,
    label: o.name?.trim() || o.uuid,
    description: o.name?.trim() ? o.uuid : undefined,
    recommended: valid.length > 1 && i === 0
  }))
}

export const resolveOrgId = (orgs: OrgSummary[]): { ok: true; orgId: string } | { ok: false; error: string } => {
  const ids = (orgs ?? []).map((o) => o.uuid).filter((u): u is string => !!u)

  if (ids.length === 1) {
    return { ok: true, orgId: ids[0] }
  }

  if (ids.length === 0) {
    return { ok: false, error: 'Set your Anthropic organization ID in Settings (the org_… in your console URL).' }
  }

  return { ok: false, error: `You have ${ids.length} Anthropic organizations — pick one in Settings.` }
}

// Org for a collector: the pinned config value, else the single auto-resolved org, else throw the friendly
// "pick one in Settings" message. Throws (never returns undefined) so callers don't re-guard.
const resolveOrgForCollect = async (ctx: CollectContext<AnthropicConfig>): Promise<string> => {
  const configured = ctx.config.orgId?.trim()

  if (configured) {
    return configured
  }

  const result = resolveOrgId(await fetchAnthropicOrgs((url) => ctx.client.get(url)))

  if (!result.ok) {
    throw new Error(result.error)
  }

  return result.orgId
}

// ── billing: invoice history + open-period spend + spend cap + payment method ──────────

/** "May 01 2026 - May 31 2026" → "2026-05" (start month). Null if unparseable. */
export const servicePeriodMonth = (period: string | null): string | null => {
  if (!period) {
    return null
  }

  const m = /([a-z]{3})\s+\d{1,2}\s+(\d{4})/i.exec(period.trim())

  if (!m) {
    return null
  }

  const monthIdx = PERIOD_MONTHS.indexOf(m[1]!.toLowerCase())

  return monthIdx < 0 ? null : `${m[2]}-${String(monthIdx + 1).padStart(2, '0')}`
}

const invoiceKind = (type: string): InvoiceKind => (type === 'prepaid_credits' ? 'credits' : 'usage')

/** ISO timestamp → 'Mon D' (e.g. 'Jul 1'), or null when unparseable. */
const shortDate = (iso: string | null): string | null => {
  const day = iso ? isoDay(iso) : null

  return day ? `${MONTH_ABBR[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8, 10))}` : null
}

// Raw console responses → the normalized USD billing report.
export const buildAnthropicBillingReport = (raw: RawBillingBundle, capturedAt: string): AnthropicBillingReport => {
  const currentSpend = centsToMajor(raw.currentSpend.amount)

  const pauseRaw = (raw.spendLimits.spend_limits ?? []).find((l) => l.limit_action === 'notify_and_pause')
  const pauseLimit = pauseRaw ? centsToMajor(pauseRaw.limit_usd) : null
  const pauseLimitPct = pauseLimit && pauseLimit > 0 ? Math.round((currentSpend / pauseLimit) * 100) : null

  const pm = raw.paymentMethod
  const paymentMethod = pm.brand && pm.last4 ? { brand: pm.brand, last4: pm.last4 } : null

  const invoices: BillingInvoice[] = raw.invoices.map((inv) => {
    const kind = invoiceKind(inv.type)
    // Date usage invoices by their service-period month, NOT effective_at (the issue date). Anthropic bills
    // usage in arrears: the invoice for May usage is effective ~June 1, so dating by effective_at books May's
    // spend into June in the monthly chart + the cross-service Overview. Credit purchases have no service
    // period → keep their effective_at date.
    const periodMonth = kind === 'usage' ? servicePeriodMonth(inv.service_period) : null

    return {
      date: periodMonth ? `${periodMonth}-01` : (isoDay(inv.effective_at) ?? ''),
      effectiveTs: Date.parse(inv.effective_at),
      kind,
      status: inv.invoice_status,
      servicePeriod: inv.service_period,
      amount: centsToMajor(inv.amount),
      pdfUrl: inv.download_url,
      hostedUrl: inv.hosted_invoice_url
    }
  })

  invoices.sort((a, b) => b.effectiveTs - a.effectiveTs)

  return {
    capturedAt,
    currency: raw.currency,
    currentSpend,
    resetsAt: raw.currentSpend.resets_at ?? null,
    pauseLimit,
    pauseLimitPct,
    paymentMethod,
    billingEmail: raw.billingEmails.primary_email ?? null,
    invoices
  }
}

const toInvoiceInput = (inv: BillingInvoice): BillingInvoiceInput => ({
  date: inv.date || undefined,
  amount: inv.amount,
  status: inv.status,
  pdfUrl: inv.pdfUrl,
  hostedUrl: inv.hostedUrl
})

// Summary tab — its spend.mtd summary is what the cross-service Overview rolls up. Headline: open-period (MTD)
// spend + the monthly-spend chart. The chart is fed ONLY the usage invoices (dated by service period) so it's a
// clean API-usage trend; credit purchases would spike the wrong month. Extra stats: the pause cap (when set)
// and the invoice count.
export const buildAnthropicSummaryResult = (report: AnthropicBillingReport): CapabilityResult => {
  const usageInvoices = report.invoices.filter((i) => i.kind === 'usage').map(toInvoiceInput)
  const resets = shortDate(report.resetsAt)

  return billing.summary({
    currentMtd: report.currentSpend,
    // Usage-metered spend accruing live over the open period.
    mtdBasis: 'accrued',
    // Disambiguate the headline: it's a running total for the open period, not a settled month.
    currentMtdCaption: resets ? `accrued so far · resets ${resets}` : 'accrued so far',
    currency: report.currency,
    invoices: usageInvoices,
    stats: [
      ...(report.pauseLimit != null
        ? [
            {
              key: 'pauseLimit',
              label: 'Pause cap',
              role: 'money' as const,
              currency: report.currency,
              value: report.pauseLimit,
              caption: report.pauseLimitPct != null ? `${report.pauseLimitPct}% used` : undefined
            }
          ]
        : []),
      { key: 'invoiceCount', label: 'Invoices', role: 'count' as const, value: report.invoices.length }
    ]
  })
}

// Billing tab — the financial detail, not the Overview rollup. The full invoice history (usage + credit
// invoices, with downloadable PDFs) plus an account record (open spend / reset / cap / payment card / billing
// email). The headline MTD + monthly chart live on Summary.

interface BillingInvoiceRow {
  // Hidden — the invoice's stable identity (kind + issue instant), keys the dataset so invoices accumulate in
  // the ledger past the fetched page window and version their status (open → paid) over time.
  id: string
  date: string | null
  kind: string | null
  amount: number
  status: string | null
  pdfUrl: string | null
  // Hidden — carried for the download filename.
  name: string
}

interface BillingAccountRow {
  currentSpend: number
  resetsAt: string | null
  pauseLimit: number | null
  pauseLimitPct: number | null
  paymentMethod: string | null
  billingEmail: string | null
}

export const buildAnthropicBillingTab = (report: AnthropicBillingReport): CapabilityResult => {
  const currency = report.currency

  const invoiceTable = table<BillingInvoiceRow>({
    id: 'invoices',
    columns: [
      { key: 'id', role: 'identifier', hidden: true },
      { key: 'date', label: 'Date', role: 'timestamp' },
      { key: 'kind', label: 'Type', role: 'label' },
      { key: 'amount', label: 'Amount', role: 'money', currency },
      { key: 'status', label: 'Status', role: 'status' },
      { key: 'pdfUrl', label: 'PDF', role: 'url' },
      { key: 'name', role: 'label', hidden: true }
    ],
    rows: report.invoices.map((i) => ({
      id: `${i.kind}:${i.effectiveTs}`,
      date: i.date || null,
      kind: i.kind === 'credits' ? 'Credits' : 'Usage',
      amount: i.amount,
      status: i.status,
      pdfUrl: i.pdfUrl ?? i.hostedUrl ?? null,
      name: `Invoice ${i.date || 'unknown'}`
    })),
    key: 'id'
  })

  const accountRecord = record<BillingAccountRow>({
    id: 'account',
    fields: [
      { key: 'currentSpend', label: 'Open-period spend', role: 'money', currency },
      { key: 'resetsAt', label: 'Resets', role: 'timestamp' },
      { key: 'pauseLimit', label: 'Pause cap', role: 'money', currency },
      { key: 'pauseLimitPct', label: 'Cap used', role: 'percent' },
      { key: 'paymentMethod', label: 'Payment', role: 'label' },
      { key: 'billingEmail', label: 'Billing email', role: 'identifier' }
    ],
    value: {
      currentSpend: report.currentSpend,
      resetsAt: report.resetsAt ? (isoDay(report.resetsAt) ?? report.resetsAt) : null,
      pauseLimit: report.pauseLimit,
      // percent role expects a 0..1 fraction.
      pauseLimitPct: report.pauseLimitPct != null ? report.pauseLimitPct / 100 : null,
      paymentMethod: report.paymentMethod ? `${report.paymentMethod.brand} ····${report.paymentMethod.last4}` : null,
      billingEmail: report.billingEmail
    }
  })

  return capabilityResult({
    sections: [
      accountRecord.keyvalue({ title: 'Account' }),
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

// Summary + Billing share the same six-endpoint billing bundle. Both fetch the raw bundle (the core query
// cache dedupes the underlying reads, keyed by org id) and the pure build derives each tab's render. The live
// capturedAt rides in on the wrapper so `buildAnthropicBillingReport` stays pure (no `new Date()` inside).
export type AnthropicBillingRaw = { bundle: RawBillingBundle; capturedAt: string }

const fetchAnthropicBilling = async (ctx: CollectContext, orgId: string): Promise<AnthropicBillingRaw> => {
  const org = orgPath(orgId)
  const get = <T>(url: string) => ctx.client.get<T>(url)

  const invoicesP = (async () => {
    const all: RawConsoleInvoice[] = []
    let page = ''

    for (let i = 0; i < MAX_INVOICE_PAGES; i += 1) {
      const res = await get<RawInvoicesPage>(`${org}/invoices?limit=25${page ? `&page=${page}` : ''}`)

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

  const [invoices, currentSpend, spendLimits, paymentMethod, billingEmails, prepaid] = await Promise.all([
    invoicesP,
    get<RawCurrentSpend>(`${org}/current_spend`).catch(() => ({}) as RawCurrentSpend),
    get<RawSpendLimitsV2>(`${org}/spend_limits_v2`).catch(() => ({}) as RawSpendLimitsV2),
    get<RawPaymentMethod>(`${org}/payment_method`).catch(() => ({}) as RawPaymentMethod),
    get<RawBillingEmails>(`${org}/billing_emails`).catch(() => ({}) as RawBillingEmails),
    get<{ currency?: string }>(`${org}/prepaid/credits`).catch(() => ({}) as { currency?: string })
  ])

  return {
    bundle: {
      invoices,
      currentSpend,
      spendLimits,
      paymentMethod,
      billingEmails,
      currency: normalizeCurrency(prepaid?.currency)
    },
    capturedAt: new Date().toISOString()
  }
}

// ── usage: per-member API spend (the API platform attributes spend per API key; the only human link is a
// key's created_by, so per-person spend is the sum over the keys that person created) ──

/** "YYYY-MM-01" for the first of the month `offset` months from `d`, in the reporting zone — so month[0] tracks
 * the user's current month, not UTC's (which has already rolled at the boundary). */
const monthStartZoned = (d: Date, offset: number): string =>
  DateTime.fromJSDate(d, { zone: getReportingZone() }).startOf('month').plus({ months: offset }).toFormat('yyyy-MM-dd')

/** Format a "YYYY-MM-01" period start as "Mon YYYY" (e.g. "Jun 2026"). */
export const monthLabel = (periodStart: string): string => {
  const [y, m] = periodStart.split('-')

  return `${MONTH_ABBR[Number(m) - 1]} ${y}`
}

interface MonthRange {
  start: string
  end: string
  label: string
}

/** The current month plus the previous `count - 1` months, newest first (reporting zone). */
export const recentMonths = (now: Date, count: number): MonthRange[] => {
  const out: MonthRange[] = []

  for (let i = 0; i < count; i += 1) {
    const start = monthStartZoned(now, -i)

    out.push({ start, end: monthStartZoned(now, -i + 1), label: monthLabel(start) })
  }

  return out
}

/** Sum usage_cost.total (cents) per key_id across all day buckets. */
const sumCostByKey = (cost: RawUsageCost): Map<string, number> => {
  const out = new Map<string, number>()

  for (const rows of Object.values(cost.costs ?? {})) {
    for (const row of rows) {
      out.set(row.key_id, (out.get(row.key_id) ?? 0) + (row.total ?? 0))
    }
  }

  return out
}

const UNATTRIBUTED = 'unattributed'

// Raw analytics responses → per-member spend, aggregating each key's monthly cost onto its creator (keys with
// no known creator fall into an "unattributed" bucket).
export const buildAnthropicAnalytics = (raw: RawAnalyticsBundle, capturedAt: string): AnthropicAnalyticsReport => {
  const months = raw.monthlyCosts.map((mc) => ({ periodStart: mc.periodStart, label: mc.label }))
  const newest = months[0]?.periodStart ?? ''
  const memberById = new Map(raw.members.map((m) => [m.id, m]))
  const keyToCreator = new Map(raw.apiKeys.map((k) => [k.id, k.created_by.id]))
  const costByMonth = raw.monthlyCosts.map((mc) => ({ periodStart: mc.periodStart, byKey: sumCostByKey(mc.cost) }))
  const newestByKey = costByMonth[0]?.byKey ?? new Map<string, number>()
  const lastUsedByKey = new Map(raw.keyUsage.api_keys.map((k) => [k.id, k.last_used_at]))

  interface Acc {
    creatorId: string
    activeKeys: number
    centsByMonth: Map<string, number>
    lastUsed: string | null
    keys: ApiKeyDetail[]
  }
  const accs = new Map<string, Acc>()
  const ensure = (id: string): Acc => {
    let a = accs.get(id)

    if (!a) {
      a = { creatorId: id, activeKeys: 0, centsByMonth: new Map(), lastUsed: null, keys: [] }
      accs.set(id, a)
    }

    return a
  }
  const addCents = (a: Acc, periodStart: string, cents: number) =>
    a.centsByMonth.set(periodStart, (a.centsByMonth.get(periodStart) ?? 0) + cents)
  const bumpLastUsed = (a: Acc, ts: string | undefined | null) => {
    if (ts && (a.lastUsed === null || ts > a.lastUsed)) {
      a.lastUsed = ts
    }
  }

  // Every key contributes to its creator (active count, per-month spend, last-used, and a detail entry).
  for (const key of raw.apiKeys) {
    const a = ensure(key.created_by.id)

    if (key.status === 'active') {
      a.activeKeys += 1
    }

    for (const m of costByMonth) {
      addCents(a, m.periodStart, m.byKey.get(key.id) ?? 0)
    }

    const keyLastUsed = lastUsedByKey.get(key.id) ?? null

    bumpLastUsed(a, keyLastUsed)
    a.keys.push({
      id: key.id,
      name: key.name,
      partialKeyHint: key.partial_key_hint ?? '',
      status: key.status,
      workspaceId: key.workspace_id,
      createdAt: key.created_at,
      lastUsed: keyLastUsed,
      currentSpend: centsToMajor(newestByKey.get(key.id)),
      expiresAt: key.expires_at
    })
  }

  // Keys we have no metadata for (deleted keys / Workbench usage) → the Unattributed bucket: their spend
  // aggregates onto the bucket's per-month total, and each appears as a synthesized (name-less) key detail so
  // the API Keys tab can still list it with its this-month spend.
  const unknownKeyIds = new Set<string>()

  for (const m of costByMonth) {
    for (const [keyId, cents] of m.byKey) {
      if (!keyToCreator.has(keyId)) {
        addCents(ensure(UNATTRIBUTED), m.periodStart, cents)
        unknownKeyIds.add(keyId)
      }
    }
  }

  for (const { id, last_used_at } of raw.keyUsage.api_keys) {
    if (!keyToCreator.has(id)) {
      bumpLastUsed(ensure(UNATTRIBUTED), last_used_at)
      unknownKeyIds.add(id)
    }
  }

  for (const keyId of unknownKeyIds) {
    ensure(UNATTRIBUTED).keys.push({
      id: keyId,
      name: '',
      partialKeyHint: '',
      status: '',
      workspaceId: null,
      createdAt: null,
      lastUsed: lastUsedByKey.get(keyId) ?? null,
      currentSpend: centsToMajor(newestByKey.get(keyId)),
      expiresAt: null
    })
  }

  const statusRank = (s: string) => (s === 'active' ? 0 : 1)
  const rows: AnthropicMemberRow[] = [...accs.values()].map((a) => {
    const member = memberById.get(a.creatorId)
    const spendByMonth: Record<string, number> = {}

    for (const m of months) {
      spendByMonth[m.periodStart] = centsToMajor(a.centsByMonth.get(m.periodStart))
    }

    // Most-relevant keys first: highest current spend, then active, then name.
    a.keys.sort(
      (x, y) =>
        y.currentSpend - x.currentSpend || statusRank(x.status) - statusRank(y.status) || x.name.localeCompare(y.name)
    )

    return {
      creatorId: a.creatorId,
      email: member?.email ?? null,
      name: member?.name ?? null,
      role: member?.role ?? null,
      isMember: member !== undefined,
      apiKeyCount: a.activeKeys,
      spendByMonth,
      currentSpend: spendByMonth[newest] ?? 0,
      lastUsed: a.lastUsed,
      keys: a.keys
    }
  })

  rows.sort((x, y) => y.currentSpend - x.currentSpend)

  return { capturedAt, months, orgCurrentSpend: centsToMajor(raw.orgCurrentSpendCents), rows }
}

// The analytics report → an overview record + a per-member spend table (this month + last month + key count),
// with a usage.primary summary (org open-period spend) for the rollup.

interface UsageOverviewRow {
  orgCurrentSpend: number
  members: number
  activeKeys: number
}

interface UsageMemberRow {
  who: string | null
  role: string | null
  keys: number
  current: number
  previous: number | null
  lastUsed: string | null
  // Hidden join key: binds each member row to its keys in the memberKeys child table (the expanded row).
  creatorId: string
}

// One API key flattened onto a row shared by the Usage tab's per-member detail and the API Keys tab.
export interface FlatKeyRow {
  id: string
  creatorId: string
  name: string | null
  keyHint: string | null
  owner: string | null
  status: string | null
  workspace: string | null
  created: string | null
  lastUsed: string | null
  expires: string | null
  currentSpend: number
}

const ownerLabel = (row: AnthropicMemberRow): string =>
  row.email ?? row.name ?? (row.creatorId === UNATTRIBUTED ? 'Unattributed' : row.creatorId)

// Every member's keys flattened to one row list (owner-attributed), used for both the expanded member detail
// and the API Keys tab. Order follows the report's member order (spend-desc), keys already sorted within.
export const flattenKeys = (report: AnthropicAnalyticsReport): FlatKeyRow[] =>
  report.rows.flatMap((r) => {
    const owner = ownerLabel(r)

    return r.keys.map((k) => ({
      id: k.id,
      creatorId: r.creatorId,
      name: k.name || null,
      keyHint: k.partialKeyHint || null,
      owner,
      status: k.status || null,
      workspace: k.workspaceId ?? 'default',
      created: isoDay(k.createdAt) ?? null,
      lastUsed: isoDay(k.lastUsed) ?? null,
      expires: isoDay(k.expiresAt) ?? null,
      currentSpend: k.currentSpend
    }))
  })

export const buildAnthropicUsageResult = (report: AnthropicAnalyticsReport): CapabilityResult => {
  const currency = 'USD'
  const thisMonth = report.months[0]
  const lastMonth = report.months[1]

  const overviewRecord = record<UsageOverviewRow>({
    id: 'overview',
    fields: [
      { key: 'orgCurrentSpend', label: 'Spend (open period)', role: 'money', currency },
      { key: 'members', label: 'Members', role: 'count' },
      { key: 'activeKeys', label: 'Active API keys', role: 'count' }
    ],
    value: {
      orgCurrentSpend: report.orgCurrentSpend,
      members: report.rows.filter((r) => r.isMember).length,
      activeKeys: report.rows.reduce((s, r) => s + r.apiKeyCount, 0)
    }
  })

  const membersTable = table<UsageMemberRow>({
    id: 'members',
    columns: [
      { key: 'who', label: 'Member', role: 'label' },
      { key: 'role', label: 'Role', role: 'category' },
      { key: 'keys', label: 'Keys', role: 'count' },
      { key: 'current', label: thisMonth?.label ?? 'This month', role: 'money', currency },
      { key: 'previous', label: lastMonth?.label ?? 'Last month', role: 'money', currency },
      { key: 'lastUsed', label: 'Last used', role: 'timestamp' },
      { key: 'creatorId', role: 'identifier', hidden: true }
    ],
    rows: report.rows.map((r) => ({
      who: r.email ?? r.name ?? (r.creatorId === UNATTRIBUTED ? 'Unattributed' : r.creatorId),
      role: r.role ?? (r.isMember ? null : 'service'),
      keys: r.apiKeyCount,
      current: thisMonth ? (r.spendByMonth[thisMonth.periodStart] ?? 0) : r.currentSpend,
      previous: lastMonth ? (r.spendByMonth[lastMonth.periodStart] ?? 0) : null,
      lastUsed: r.lastUsed ? (isoDay(r.lastUsed) ?? r.lastUsed) : null,
      creatorId: r.creatorId
    })),
    key: 'creatorId'
  })

  // The child table each member row expands into: that creator's keys (joined on creatorId). Rows carry every
  // creator's keys; the renderer filters to the expanded parent. Per-key spend is this month only.
  const memberKeys = table<FlatKeyRow>({
    id: 'memberKeys',
    columns: [
      { key: 'name', label: 'Name', role: 'label' },
      { key: 'keyHint', label: 'Key', role: 'identifier' },
      { key: 'status', label: 'Status', role: 'status' },
      { key: 'workspace', label: 'Workspace', role: 'label' },
      { key: 'created', label: 'Created', role: 'timestamp' },
      { key: 'lastUsed', label: 'Last used', role: 'timestamp' },
      { key: 'currentSpend', label: thisMonth?.label ?? 'This month', role: 'money', currency },
      { key: 'creatorId', role: 'identifier', hidden: true }
    ],
    rows: flattenKeys(report),
    key: 'id'
  })

  return capabilityResult({
    sections: [
      overviewRecord.stat(),
      membersTable.table({ title: 'Spend by member', detail: { rows: memberKeys, on: 'creatorId' } })
    ],
    summaries: [
      {
        section: 'other',
        label: 'Spend (open period)',
        value: report.orgCurrentSpend,
        role: 'money',
        currency
      }
    ]
  })
}

// API Keys tab — every key across the org in one flat table (owner-attributed; deleted/Workbench keys show
// under 'Unattributed'), highest this-month spend first. Same flattened key rows as the Usage detail. No
// summary — keys aren't a spend headline (the Usage/Summary tabs own the money rollup).
export const buildAnthropicApiKeysResult = (report: AnthropicAnalyticsReport): CapabilityResult => {
  const currency = 'USD'
  const thisMonth = report.months[0]
  const rows = flattenKeys(report).sort((a, b) => b.currentSpend - a.currentSpend)

  const keys = table<FlatKeyRow>({
    id: 'apiKeys',
    columns: [
      { key: 'name', label: 'Name', role: 'label' },
      { key: 'keyHint', label: 'Key', role: 'identifier' },
      { key: 'owner', label: 'Owner', role: 'label' },
      { key: 'status', label: 'Status', role: 'status' },
      { key: 'workspace', label: 'Workspace', role: 'label' },
      { key: 'created', label: 'Created', role: 'timestamp' },
      { key: 'lastUsed', label: 'Last used', role: 'timestamp' },
      { key: 'expires', label: 'Expires', role: 'timestamp' },
      { key: 'currentSpend', label: thisMonth ? `Spend (${thisMonth.label})` : 'Spend', role: 'money', currency }
    ],
    rows,
    key: 'id'
  })

  return capabilityResult({ sections: [keys.table({ title: 'API keys' })] })
}

// The capturedAt rides in on the wrapper so `buildAnthropicAnalytics` stays pure (no `new Date()` inside).
export type AnthropicAnalyticsRaw = { bundle: RawAnalyticsBundle; capturedAt: string }

const fetchAnthropicUsage = async (ctx: CollectContext, orgId: string): Promise<AnthropicAnalyticsRaw> => {
  const months = recentMonths(new Date(), MONTHS_SHOWN)
  const console = consolePath(orgId)
  const org = orgPath(orgId)
  const get = <T>(url: string) => ctx.client.get<T>(url)

  const [members, apiKeys, keyUsage, spend, ...monthCosts] = await Promise.all([
    get<RawMember[]>(`${console}/members`).catch(() => [] as RawMember[]),
    get<RawApiKey[]>(`${console}/api_keys`).catch(() => [] as RawApiKey[]),
    get<RawKeyUsage>(`${org}/api_keys/usage`).catch(() => ({ api_keys: [] }) as RawKeyUsage),
    get<{ amount?: number }>(`${org}/current_spend`).catch(() => ({}) as { amount?: number }),
    ...months.map((m) =>
      get<RawUsageCost>(`${org}/usage_cost?starting_on=${m.start}&ending_before=${m.end}&group_by=api_key_id`).catch(
        () => ({ costs: {} }) as RawUsageCost
      )
    )
  ])

  const monthlyCosts: MonthlyCost[] = months.map((m, i) => ({
    periodStart: m.start,
    label: m.label,
    cost: monthCosts[i] ?? { costs: {} }
  }))

  return {
    bundle: {
      members: members ?? [],
      apiKeys: apiKeys ?? [],
      keyUsage: keyUsage ?? { api_keys: [] },
      monthlyCosts,
      orgCurrentSpendCents: spend?.amount ?? 0
    },
    capturedAt: new Date().toISOString()
  }
}

// ── members: the org roster (who has access + their console role) ──────────────────────

// The console members payload → the standard members preset input.
export const buildAnthropicMembers = (raw: RawRosterMember[] | undefined | null): MembersInput => ({
  members: (raw ?? []).map((m, i) => ({
    id: m.id ?? m.email ?? String(i),
    name: m.name || undefined,
    email: m.email,
    role: m.role ?? undefined
  }))
})

const fetchAnthropicMembers = (ctx: CollectContext, orgId: string): Promise<RawRosterMember[]> =>
  ctx.client.get<RawRosterMember[]>(`${consolePath(orgId)}/members`)

// ── descriptor ──────────────────────────────────────────────────────────────────────
export const anthropicConfigSchema = defineConfigSchema([
  {
    key: 'orgId',
    label: 'Organization',
    kind: 'combobox',
    placeholder: 'Pick your organization…',
    help: 'Auto-used when you have only one. With several, pick which one Butin should read — the others 403.',
    loadOptions: async (ctx) => buildOrgOptions(await fetchAnthropicOrgs((url) => ctx.client.get(url)))
  }
])

export type AnthropicConfig = ConfigOf<typeof anthropicConfigSchema>

export const anthropicPlugin = definePlugin({
  reportingCurrency: 'USD',
  meta: {
    id: 'anthropic-console',
    name: 'Anthropic Console',
    vendor: 'Anthropic',
    category: 'ai',
    color: '#d97757',
    description:
      'Anthropic API platform billing, per-member API spend, and org members — from your own console session.',
    homepage: 'https://console.anthropic.com',
    dashboardUrl: 'https://console.anthropic.com/settings/billing'
  },
  session: {
    loginUrl: 'https://platform.claude.com/settings/members',
    dashboardMarkers: ['/dashboard', '/settings', '/usage'],
    cookieDomains: ['claude.com'],
    // The auth cookie (sessionKey, on .platform.claude.com) lands a beat after the SPA routes to an authed
    // page; without this guard, capture grabs only the marketing-domain cookies and the API 403s.
    requiredCookie: 'sessionKey'
  },
  auth: { kind: 'cookie' },
  // platform.claude.com sits behind Cloudflare and only accepts a real browser → electron transport (real browser identity).
  // UA omitted on purpose: capture + replay both default to the canonical Butin identity, kept in lockstep so
  // cf_clearance stays valid. The console wants its client-platform marker header.
  transport: { requiresBrowserEngine: true, defaultHeaders: { 'anthropic-client-platform': 'web_console' } },
  config: anthropicConfigSchema,
  capabilities: [
    defineCapability({
      id: 'summary',
      label: 'Summary',
      fetch: async (ctx) => fetchAnthropicBilling(ctx, await resolveOrgForCollect(ctx)),
      build: (raw) => buildAnthropicSummaryResult(buildAnthropicBillingReport(raw.bundle, raw.capturedAt)),
      sample: sampleAnthropicBilling
    }),
    defineCapability({
      id: 'billing',
      label: 'Billing',
      fetch: async (ctx) => fetchAnthropicBilling(ctx, await resolveOrgForCollect(ctx)),
      build: (raw) => buildAnthropicBillingTab(buildAnthropicBillingReport(raw.bundle, raw.capturedAt)),
      sample: sampleAnthropicBilling
    }),
    defineCapability({
      id: 'usage',
      label: 'Usage',
      fetch: async (ctx) => fetchAnthropicUsage(ctx, await resolveOrgForCollect(ctx)),
      build: (raw) => buildAnthropicUsageResult(buildAnthropicAnalytics(raw.bundle, raw.capturedAt)),
      sample: sampleAnthropicAnalytics
    }),
    defineCapability({
      id: 'api-keys',
      label: 'API keys',
      // Shares the usage bundle (the core query cache dedupes the reads across the two tabs).
      fetch: async (ctx) => fetchAnthropicUsage(ctx, await resolveOrgForCollect(ctx)),
      build: (raw) => buildAnthropicApiKeysResult(buildAnthropicAnalytics(raw.bundle, raw.capturedAt)),
      sample: sampleAnthropicAnalytics
    }),
    defineCapability({
      id: 'members',
      label: 'Members',
      fetch: async (ctx) => fetchAnthropicMembers(ctx, await resolveOrgForCollect(ctx)),
      build: (raw) => members.result(buildAnthropicMembers(raw)),
      sample: sampleAnthropicMembers
    })
  ],
  // Probe confirms the session can reach the org's console (a live session). Resolves the org first so a
  // multi-org account surfaces the "pick one in Settings" message instead of a generic failure.
  probe: async (ctx) => {
    const orgId = await resolveOrgForCollect(ctx)

    await ctx.client.get(`${consolePath(orgId)}/members`)
  }
})
