import { defineCapability, defineConfigSchema, definePlugin, type CollectContext, type ConfigOf } from '@butinapp/sdk'
import { capabilityResult, table, type CapabilityResult } from '@butinapp/sdk/data'
import {
  fetchStripePortalResource,
  openStripePortalViaRedirect,
  type RawStripeInvoiceList,
  type StripePortalSession
} from '@butinapp/sdk/integrations'
import { billing, members, usage, type MembersInput } from '@butinapp/sdk/presets'
import { centsToMajor, epochSecDay, round2 } from '@butinapp/sdk/util'

import { sampleDepotBilling, sampleDepotSettings, sampleDepotUsage } from './sample.js'

// Depot (depot.dev — remote Docker/container builds + GitHub Actions runners + layer/remote build cache).
// Two surfaces, one captured session (the `depot-session` cookie), plain Node axios — depot.dev and
// billing.stripe.com don't need the browser engine, so no Electron transport needed.
//
//   SUMMARY — the overview the cross-service Overview rolls up (spend.mtd): the current period's running total
//             + monthly-spend trend chart + the plan/base/metered/upcoming headline stats. Summary + Billing
//             share ONE billing fetch (the query cache dedupes it).
//   BILLING — the financial detail: the downloadable invoice history + the per-invoice line-item breakdown.
//             No chart, no spend.mtd headline (those live on Summary).
//   USAGE   — the current-period build/job/CI MINUTES + layer/remote cache GB, read off Depot's own
//             settings/usage Remix loader. Units are minutes/GB — no money.
//
// Depot has NO invoice API of its own — billing lives in a Stripe-HOSTED billing portal, reached by a 302
// walk: GET depot.dev/orgs/<org>/billing-portal → 302 → billing.stripe.com/p/session/… → read the bps/ek/acct
// tokens off the portal page → call the portal's /invoices + /subscriptions with the ephemeral Bearer. The
// portal mechanics (redirect walk, token scrape, ephemeral-key calls) live in @butinapp/sdk's Stripe
// helpers; the fetch is best-effort, degrading to empty invoices on any failure. `buildBillingReport` is the
// fixture-tested normalizer.
//
// The org slug keys every path (`/orgs/<slug>/…`) and is account-specific, so it's a REQUIRED text config
// field read off ctx.config — not hardcoded. MONEY from Stripe is in CENTS → centsToMajor; usage units stay raw.

const ORIGIN = 'https://depot.dev'
const SETTINGS_USAGE_ROUTE = 'routes/_app.orgs.$orgID._org.settings.usage'

// ── usage: raw loader shape + normalized report ─────────────────────────────────────────

export interface RawDepotUsage {
  // Docker/container build minutes used this period.
  buildMinutes?: number
  // GitHub Actions job minutes used this period.
  jobMinutes?: number
  // Depot CI minutes used this period.
  ciMinutes?: number
  // Layer cache currently stored, GB.
  currentCacheUsage?: number
  // Remote build cache currently stored, GB.
  currentRemoteCacheSize?: number
}

export interface DepotUsageReport {
  buildMinutes: number
  jobMinutes: number
  ciMinutes: number
  // build + job + CI minutes.
  totalMinutes: number
  // Layer cache stored, GB.
  layerCacheGb: number
  // Remote build cache stored, GB.
  remoteCacheGb: number
}

// Pure transform — fixture-tested. Maps the loader's current-period totals; every field defaults to 0.
export const buildDepotUsage = (raw: RawDepotUsage | undefined | null): DepotUsageReport => {
  const buildMinutes = raw?.buildMinutes ?? 0
  const jobMinutes = raw?.jobMinutes ?? 0
  const ciMinutes = raw?.ciMinutes ?? 0

  return {
    buildMinutes,
    jobMinutes,
    ciMinutes,
    totalMinutes: buildMinutes + jobMinutes + ciMinutes,
    layerCacheGb: raw?.currentCacheUsage ?? 0,
    remoteCacheGb: raw?.currentRemoteCacheSize ?? 0
  }
}

// Compose the usage result: minutes split by lane (build/job/CI) + the two cache-GB metrics. Counts only —
// spend lives on the billing tab.
export const buildDepotUsageResult = (report: DepotUsageReport): CapabilityResult =>
  usage.result({
    metrics: [
      { label: 'Build minutes', value: report.buildMinutes, unit: 'min' },
      { label: 'Job minutes', value: report.jobMinutes, unit: 'min' },
      { label: 'CI minutes', value: report.ciMinutes, unit: 'min' },
      { label: 'Layer cache', value: report.layerCacheGb, unit: 'GB' },
      { label: 'Remote build cache', value: report.remoteCacheGb, unit: 'GB' }
    ]
  })

// ── members: raw settings-loader shapes + normalized roster ─────────────────────────────
// Depot's org settings page (`/orgs/<slug>/settings.data`) returns a Remix turbo-stream whose loader data
// carries a node with `{ users, invites }`, reachable under the same `depot-session` cookie that reads usage.
// Active members nest under `users` (flagged isOwner/isAdmin/role); pending invitations under `invites`. Both
// normalize into one roster, deriving a coarse role from the owner/admin flags when no explicit `role` is present.

export interface RawDepotMember {
  userID?: string
  id?: string
  email?: string
  name?: string
  role?: string
  isOwner?: boolean
  isAdmin?: boolean
}

export interface RawDepotSettings {
  users?: RawDepotMember[]
  invites?: RawDepotMember[]
}

// Owner/admin flags win over an explicit role string; falls back to 'member' so every row carries a role.
const memberRole = (m: RawDepotMember): string => {
  if (m.isOwner) {
    return 'owner'
  }

  if (m.isAdmin) {
    return 'admin'
  }

  return m.role ?? 'member'
}

// Pure transform — fixture-tested. Merges active users + pending invites into one roster; pending invites
// (often name-less) get a '(pending)' suffix so the table reads clearly. Every row gets a stable id.
export const buildDepotMembers = (raw: RawDepotSettings | undefined | null): MembersInput => {
  const users = (raw?.users ?? []).map((m, i) => ({
    id: m.userID ?? m.id ?? m.email ?? `user-${i}`,
    name: m.name ?? undefined,
    email: m.email ?? undefined,
    role: memberRole(m)
  }))

  const invites = (raw?.invites ?? []).map((m, i) => ({
    id: m.id ?? m.email ?? `invite-${i}`,
    name: m.name ?? undefined,
    email: m.email ?? undefined,
    role: `${memberRole(m)} (pending)`
  }))

  return { members: [...users, ...invites] }
}

// Settings-loader keys: the node carrying the roster declares at least one of these.
const SETTINGS_KEYS: Array<keyof RawDepotSettings> = ['users', 'invites']

const hasSettingsKeys = (node: Record<string, unknown>): boolean => SETTINGS_KEYS.some((k) => k in node)

// Exported so the parse path is fixture-tested: settings turbo-stream text → the `{ users, invites }` node.
export const extractMembersFromLoader = (text: string): RawDepotSettings => {
  const tree = resolveLoaderTree(text)

  if (!tree) {
    return {}
  }

  return findNode<RawDepotSettings>(tree, hasSettingsKeys) ?? {}
}

// ── billing: raw Stripe subscription shapes (only the fields we read) — money in CENTS, dates in unix seconds.
// The invoice/line shapes (RawStripeInvoice / RawStripeLine / RawStripeInvoiceList) come from @butinapp/sdk. ──

interface RawSubLine {
  amount?: number
  // `period.end === current_period_end` flags a current-period (metered) line; the licensed base-plan line
  // carries the NEXT period's end.
  period?: { start?: number; end?: number }
}

interface RawSubItem {
  price_details?: {
    unit_amount?: number
    recurring?: { usage_type?: string }
    product?: { name?: string }
  }
}

interface RawUpcomingInvoice {
  // Unix seconds — when the next invoice is issued (= current_period_end).
  created?: number
  total?: number
  amount_due?: number
  lines?: { data?: RawSubLine[] }
}

interface RawStripeSubscription {
  // Unix seconds — the active period's end / next billing date.
  current_period_end?: number
  items?: RawSubItem[]
  upcoming_invoice?: RawUpcomingInvoice
}

export interface RawStripeSubscriptionsList {
  data?: RawStripeSubscription[]
}

// ── billing: normalized report (dollars) ────────────────────────────────────────────────

export interface DepotInvoiceLine {
  description: string
  // Dollars.
  amount: number
}

export interface DepotInvoice {
  id: string
  number?: string
  // 'YYYY-MM-DD' (effective, else finalized, else created).
  date?: string
  status: string
  // Invoice grand total, dollars.
  amount: number
  // Amount paid, dollars.
  amountPaid: number
  currency: string
  hostedUrl?: string
  pdfUrl?: string
  lines: DepotInvoiceLine[]
}

// The active subscription's plan summary (from /subscriptions).
export interface DepotPlanSummary {
  // Licensed plan/product name, e.g. "Startup plan".
  name: string
  // Recurring base fee, dollars per month.
  baseFee: number
}

// The upcoming (next) invoice — Depot's dashboard "Next Invoice" card.
export interface DepotUpcomingInvoice {
  // 'YYYY-MM-DD' next billing date (current_period_end / upcoming.created).
  date?: string
  // Projected next-invoice total, dollars (grows with metered usage).
  amount: number
  // Metered usage accrued in the CURRENT period so far, dollars.
  meteredSoFar: number
}

export interface DepotBillingReport {
  invoices: DepotInvoice[]
  // Sum of `amount` across the returned invoices, dollars.
  totalBilled: number
  // Stripe paginated past `limit` — there are older invoices not shown.
  hasMore: boolean
  // Active plan summary, if the subscriptions fetch succeeded.
  plan?: DepotPlanSummary
  // The next invoice (date + projected total), if available.
  upcoming?: DepotUpcomingInvoice
  // currentMtd: current-period metered usage + base plan fee — a genuine running figure, NOT the next bill.
  // null when the subscriptions fetch failed or carried no upcoming invoice.
  currentMtd: number | null
}

// Derive the plan summary, upcoming invoice, and current-period MTD from the /subscriptions payload. Depot's
// only subscription bills metered usage in arrears alongside a flat licensed base plan, so the upcoming
// invoice mixes the current period's accrued metered lines (`period.end === current_period_end`) with the
// next period's licensed base-plan line. MTD = that metered usage + the recurring base fee (a real running
// figure for the open period), distinct from the upcoming invoice's headline total even though they coincide
// while the base fee is flat. Best-effort: returns all-absent when the shape is missing.
const buildSubscriptionSummary = (
  subs?: RawStripeSubscriptionsList | null
): { plan?: DepotPlanSummary; upcoming?: DepotUpcomingInvoice; currentMtd: number | null } => {
  const sub = subs?.data?.[0]
  const upcoming = sub?.upcoming_invoice

  if (!sub || !upcoming) {
    return { currentMtd: null }
  }

  const periodEnd = sub.current_period_end ?? upcoming.created
  const lines = upcoming.lines?.data ?? []
  // Current-period metered charges: lines whose period ends with this period.
  const meteredCents = lines
    .filter((l) => l.period?.end != null && l.period.end === periodEnd)
    .reduce((sum, l) => sum + (l.amount ?? 0), 0)

  // The recurring licensed base plan (its line carries the NEXT period; a flat monthly fee, so it stands in
  // for this period's base when computing MTD).
  const planItem = sub.items?.find((i) => i.price_details?.recurring?.usage_type === 'licensed')
  const baseFeeCents = planItem?.price_details?.unit_amount ?? 0
  const planName = planItem?.price_details?.product?.name

  return {
    plan: planName ? { name: planName, baseFee: centsToMajor(baseFeeCents) } : undefined,
    upcoming: {
      date: epochSecDay(periodEnd),
      amount: centsToMajor(upcoming.total ?? upcoming.amount_due),
      meteredSoFar: centsToMajor(meteredCents)
    },
    currentMtd: centsToMajor(meteredCents + baseFeeCents)
  }
}

// Pure transform — fixture-tested. Normalizes the Stripe portal's /invoices (+ best-effort /subscriptions)
// into dollars + ISO dates.
export const buildBillingReport = (
  raw: RawStripeInvoiceList,
  subs?: RawStripeSubscriptionsList | null
): DepotBillingReport => {
  const invoices = (raw.data ?? []).map(
    (inv): DepotInvoice => ({
      id: inv.id ?? '',
      number: inv.number,
      date: epochSecDay(inv.effective_at) ?? epochSecDay(inv.finalized_at) ?? epochSecDay(inv.created),
      status: inv.status ?? 'unknown',
      amount: centsToMajor(inv.total ?? inv.amount_due),
      amountPaid: centsToMajor(inv.amount_paid),
      currency: (inv.currency ?? 'usd').toUpperCase(),
      hostedUrl: inv.hosted_invoice_url,
      pdfUrl: inv.invoice_pdf || undefined,
      lines: (inv.lines?.data ?? []).map((l) => ({
        description: l.description ?? l.short_description ?? '',
        amount: centsToMajor(l.amount)
      }))
    })
  )

  const { plan, upcoming, currentMtd } = buildSubscriptionSummary(subs)

  return {
    invoices,
    totalBilled: round2(invoices.reduce((sum, i) => sum + i.amount, 0)),
    hasMore: !!raw.has_more,
    plan,
    upcoming,
    currentMtd
  }
}

// Summary tab — the overview the cross-service Overview rolls up (spend.mtd): the current period's running
// total, the monthly-spend trend chart, and the plan/base/metered/next-invoice headline stats. The invoice
// history + per-line-item detail live on Billing, not here.
export const buildDepotSummaryResult = (report: DepotBillingReport): CapabilityResult => {
  // Money is normalized to the plugin's USD reporting currency; the invoices carry it explicitly, but the
  // degraded/empty path has none — default to USD so every money column declares a currency.
  const ccy = report.invoices[0]?.currency ?? 'USD'
  const stats =
    report.upcoming != null
      ? [
          {
            key: 'nextInvoice',
            label: 'Next invoice',
            role: 'money' as const,
            value: report.upcoming.amount,
            currency: ccy
          }
        ]
      : []

  return billing.summary({
    currentMtd: report.currentMtd,
    currentMtdLabel: 'This period',
    // Depot bills metered usage in arrears on top of a flat licensed base plan: baseFee is the recurring plan
    // floor, meteredMtd the usage accrued above it this period (their sum is currentMtd).
    baseFee: report.plan?.baseFee ?? null,
    meteredMtd: report.upcoming?.meteredSoFar ?? null,
    mtdBasis: 'accrued',
    plan: report.plan?.name,
    currency: ccy,
    invoices: report.invoices.map((i) => ({
      date: i.date,
      amount: i.amount,
      status: i.status,
      hostedUrl: i.hostedUrl ?? null,
      pdfUrl: i.pdfUrl ?? null
    })),
    stats
  })
}

// Billing tab — the financial detail (not the Overview rollup; the headline + chart live on Summary): the
// downloadable invoice history and the per-invoice line-item breakdown.

interface BillingInvoiceRow {
  date: string | null
  number: string
  amount: number
  status: string
  pdfUrl: string | null
  // Hidden — carried for the download filename.
  name: string
}

interface BillingLineRow {
  invoice: string
  description: string
  amount: number
}

export const buildDepotBillingTab = (report: DepotBillingReport): CapabilityResult => {
  const ccy = report.invoices[0]?.currency ?? 'USD'

  const invoices = table<BillingInvoiceRow>({
    id: 'invoices',
    columns: [
      { key: 'date', label: 'Date', role: 'timestamp' },
      { key: 'number', label: 'Invoice', role: 'label' },
      { key: 'amount', label: 'Amount', role: 'money', currency: ccy },
      { key: 'status', label: 'Status', role: 'status' },
      { key: 'pdfUrl', label: 'PDF', role: 'url' },
      { key: 'name', role: 'label', hidden: true }
    ],
    rows: report.invoices.map((i) => ({
      date: i.date ?? null,
      number: i.number || '—',
      amount: i.amount,
      status: i.status,
      // The portal exposes a PDF link per invoice; the hosted invoice page is the fallback.
      pdfUrl: i.pdfUrl ?? i.hostedUrl ?? null,
      name: `Invoice ${i.number || i.date || 'unknown'}`
    }))
  })

  // Flatten each invoice's line items into one table, tagged by invoice number so the rows read in context.
  const lines = table<BillingLineRow>({
    id: 'lines',
    columns: [
      { key: 'invoice', label: 'Invoice', role: 'label' },
      { key: 'description', label: 'Line item', role: 'label' },
      { key: 'amount', label: 'Amount', role: 'money', currency: ccy }
    ],
    rows: report.invoices.flatMap((inv) =>
      inv.lines.map((l) => ({
        invoice: inv.number || inv.date || inv.id,
        description: l.description,
        amount: l.amount
      }))
    )
  })

  return capabilityResult({
    sections: [
      invoices.fileTable({
        title: 'Invoices',
        name: 'name',
        source: { url: 'pdfUrl' },
        ext: 'pdf',
        category: 'Invoices'
      }),
      lines.dataset.rows.length > 0 ? lines.table({ title: 'Line items' }) : null
    ]
  })
}

// ── minimal Remix single-flight parser (self-contained; the SDK ships none) ──────────────
// Depot's settings/usage loader returns a turbo-stream: index-referencing lines, optionally prefixed
// ("P0:[…]"/"1:[…]"). We only need the flat `currentUsageData` object, so a light resolver that walks the
// index array and pulls the first node carrying the usage keys is enough — no need to rebuild the whole tree.

const USAGE_KEYS: Array<keyof RawDepotUsage> = ['buildMinutes', 'jobMinutes', 'ciMinutes']

// Pull the index-encoded payload array out of a loader response (raw JSON array, or newline-prefixed lines).
const parseFlight = (input: string): unknown[] | null => {
  const trimmed = input.trim()

  try {
    const direct = JSON.parse(trimmed)

    if (Array.isArray(direct)) {
      return direct
    }
  } catch {
    // fall through to the line-prefixed form
  }

  for (const line of trimmed.split('\n')) {
    const body = line.trim().replace(/^[A-Za-z0-9]+:/, '')

    try {
      const parsed = JSON.parse(body)

      if (Array.isArray(parsed)) {
        return parsed
      }
    } catch {
      // skip non-JSON lines
    }
  }

  return null
}

// Resolve one index into its value. In this encoding a number is an INDEX into the payload (small integers
// are de-duplicated through the index table, so 1234 and 0 alike live in their own cell). Resolution is
// MEMOIZED per index (cache Map) so a value cell shared by several fields resolves once and a circular index
// ref is caught by the in-progress sentinel — without a destructive visited-set that would swallow a literal
// value whose index coincides with an already-walked node. Object keys prefixed `_<n>` name themselves via
// payload[n] (so `{_5: 6}` = { payload[5]: payload[6] }).
const CIRCULAR = Symbol('circular')

const resolveIndex = (index: number, payload: unknown[], cache: Map<number, unknown>): unknown => {
  if (index < 0 || index >= payload.length) {
    return undefined
  }

  if (cache.has(index)) {
    const cached = cache.get(index)

    return cached === CIRCULAR ? undefined : cached
  }

  const cell = payload[index]

  // A cell holding a primitive (string/number/bool/null) is a TERMINAL value — return it verbatim. Only
  // structural cells (objects/arrays) recurse, so a literal like 1234 isn't mistaken for another index.
  if (cell === null || typeof cell !== 'object') {
    cache.set(index, cell)

    return cell
  }

  cache.set(index, CIRCULAR)
  const resolved = resolveValue(cell, payload, cache)

  cache.set(index, resolved)

  return resolved
}

const resolveValue = (value: unknown, payload: unknown[], cache: Map<number, unknown>): unknown => {
  if (typeof value === 'number') {
    return resolveIndex(value, payload, cache)
  }

  if (Array.isArray(value)) {
    return value.map((v) => resolveValue(v, payload, cache))
  }

  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}

    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k.startsWith('_')) {
        const keyName = payload[Number(k.slice(1))]

        if (typeof keyName === 'string') {
          out[keyName] = resolveValue(v, payload, cache)
          continue
        }
      }

      out[k] = resolveValue(v, payload, cache)
    }

    return out
  }

  return value
}

// Walk a resolved tree for the first node matching `match`. Shared by the usage + members extractors.
const findNode = <T>(node: unknown, match: (n: Record<string, unknown>) => boolean, depth = 0): T | null => {
  if (depth > 12 || !node || typeof node !== 'object') {
    return null
  }

  if (match(node as Record<string, unknown>)) {
    return node as T
  }

  for (const v of Object.values(node as Record<string, unknown>)) {
    const found = findNode<T>(v, match, depth + 1)

    if (found) {
      return found
    }
  }

  return null
}

// Resolve a turbo-stream loader body to its fully-walked tree (or null when it isn't flight data).
const resolveLoaderTree = (text: string): unknown[] | null => {
  const payload = parseFlight(text)

  if (!payload) {
    return null
  }

  const cache = new Map<number, unknown>()

  return payload.map((_, i) => resolveIndex(i, payload, cache))
}

const hasUsageKeys = (node: Record<string, unknown>): boolean => USAGE_KEYS.some((k) => k in node)

// Exported so the parse path is fixture-tested: turbo-stream text → the flat usage object (or {}).
export const extractUsageFromLoader = (text: string): RawDepotUsage => {
  const tree = resolveLoaderTree(text)

  if (!tree) {
    return {}
  }

  return findNode<RawDepotUsage>(tree, hasUsageKeys) ?? {}
}

// ── collectors ──────────────────────────────────────────────────────────────────────────

const orgSlug = (ctx: CollectContext<DepotConfig>): string => {
  const slug = ctx.config.orgSlug?.trim()

  if (!slug) {
    throw new Error('Depot: set the Organization slug in Settings (the segment in your depot.dev/orgs/<slug>/… URL).')
  }

  return slug
}

const fetchDepotUsage = async (ctx: CollectContext<DepotConfig>): Promise<RawDepotUsage> => {
  const slug = orgSlug(ctx)
  // The `_routes` param scopes the loader response to just this route's `currentUsageData` (~300 bytes)
  // instead of the whole page tree.
  const url = `${ORIGIN}/orgs/${slug}/settings/usage.data?_routes=${encodeURIComponent(SETTINGS_USAGE_ROUTE)}`

  return extractUsageFromLoader(await ctx.client.getText(url))
}

const fetchDepotMembers = async (ctx: CollectContext<DepotConfig>): Promise<RawDepotSettings> => {
  const slug = orgSlug(ctx)

  // The org settings loader returns the `{ users, invites }` roster — same depot-session cookie as usage.
  return extractMembersFromLoader(await ctx.client.getText(`${ORIGIN}/orgs/${slug}/settings.data`))
}

// The raw Stripe portal bundle Summary + Billing share: the invoice list + (best-effort) subscriptions, both
// straight off the wire. buildBillingReport normalizes it; the two tabs draw different views of that report.
export interface RawDepotBilling {
  invoices: RawStripeInvoiceList
  subscriptions: RawStripeSubscriptionsList | null
}

// Summary + Billing share one billing fetch (the query cache dedupes it). Depot has no invoice API of its own
// — billing lives in a Stripe-hosted portal reached by a 302 walk: GET /orgs/<slug>/billing-portal redirects
// to the portal session, which the SDK helper opens and scrapes. Then fetch the invoice history (+ best-effort
// /subscriptions for plan/upcoming/MTD; limit:3 mirrors the portal UI). Any failure degrades to empty invoices
// so the tab still renders.
const fetchDepotBilling = async (ctx: CollectContext<DepotConfig>): Promise<RawDepotBilling> => {
  const slug = orgSlug(ctx)

  try {
    const session: StripePortalSession = await openStripePortalViaRedirect(
      ctx.client,
      `${ORIGIN}/orgs/${slug}/billing-portal`
    )
    const [invoices, subscriptions] = await Promise.all([
      fetchStripePortalResource<RawStripeInvoiceList>(ctx.client, session, 'invoices', { limit: 24 }),
      fetchStripePortalResource<RawStripeSubscriptionsList>(ctx.client, session, 'subscriptions', { limit: 3 }).catch(
        () => null
      )
    ])

    return { invoices, subscriptions }
  } catch (err) {
    ctx.log(`depot billing-portal walk failed (${(err as Error).message}); degrading to empty invoices.`)

    return { invoices: { data: [], has_more: false }, subscriptions: null }
  }
}

// ── descriptor ──────────────────────────────────────────────────────────────────────────

export const depotConfigSchema = defineConfigSchema([
  {
    key: 'orgSlug',
    label: 'Organization slug',
    kind: 'text',
    required: true,
    placeholder: 'e.g. ab12cd34ef',
    help: 'The slug in your dashboard URL: depot.dev/orgs/<slug>/settings. Keys every Depot path.'
  }
])

export type DepotConfig = ConfigOf<typeof depotConfigSchema>

export const depotPlugin = definePlugin({
  reportingCurrency: 'USD',
  meta: {
    id: 'depot',
    name: 'Depot',
    vendor: 'Depot',
    category: 'devtools',
    color: '#9d5cff',
    description: 'Depot build-minutes & cache usage (live) plus Stripe-portal billing (best-effort).',
    homepage: 'https://depot.dev',
    dashboardUrl: 'https://depot.dev'
  },
  session: {
    loginUrl: 'https://depot.dev/sign-in',
    dashboardMarkers: ['/orgs/', '/settings', '/projects'],
    cookieDomains: ['depot.dev'],
    requiredCookie: 'depot-session',
    // Prefill the org slug from the dashboard URL (depot.dev/orgs/<slug>/) when the capture settles on it.
    captureFromUrl: [{ pattern: '/orgs/([^/?#]+)', storeAs: 'orgSlug' }]
  },
  // Replay the stored depot-session cookie verbatim. Only a 401 reliably means the session is gone; a 403 is
  // usually a malformed request, so it's left out of clearOnStatuses (the core default).
  auth: { kind: 'cookie' },
  transport: {
    baseUrl: ORIGIN,
    defaultHeaders: { Accept: '*/*' }
  },
  config: depotConfigSchema,
  capabilities: [
    defineCapability({
      id: 'summary',
      label: 'Summary',
      fetch: fetchDepotBilling,
      build: (raw) => buildDepotSummaryResult(buildBillingReport(raw.invoices, raw.subscriptions)),
      sample: sampleDepotBilling
    }),
    defineCapability({
      id: 'billing',
      label: 'Billing',
      fetch: fetchDepotBilling,
      build: (raw) => buildDepotBillingTab(buildBillingReport(raw.invoices, raw.subscriptions)),
      sample: sampleDepotBilling
    }),
    defineCapability({
      id: 'usage',
      label: 'Usage',
      fetch: fetchDepotUsage,
      build: (raw) => buildDepotUsageResult(buildDepotUsage(raw)),
      sample: sampleDepotUsage
    }),
    defineCapability({
      id: 'members',
      label: 'Members',
      fetch: fetchDepotMembers,
      build: (raw) => members.result(buildDepotMembers(raw)),
      sample: sampleDepotSettings
    })
  ],
  probe: async (ctx) => {
    // The settings/usage loader is the cheapest authed call — a 200 proves the depot-session cookie is live.
    const slug = orgSlug(ctx)

    await ctx.client.getText(
      `${ORIGIN}/orgs/${slug}/settings/usage.data?_routes=${encodeURIComponent(SETTINGS_USAGE_ROUTE)}`
    )
  }
})
