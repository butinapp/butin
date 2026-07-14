import {
  defineCapability,
  definePlugin,
  type AuthAttachment,
  type AuthContext,
  type CollectContext
} from '@butinapp/sdk'
import { capabilityResult, table, type CapabilityResult } from '@butinapp/sdk/data'
import {
  billing,
  keys,
  members,
  type ApiKeysInput,
  type BillingStat,
  type MemberInput,
  type MembersInput
} from '@butinapp/sdk/presets'
import { centsToMajor, currentMonthKey, epochMsDay, epochSecDay, monthMinus, round2 } from '@butinapp/sdk/util'

import { sampleOpenaiBilling, sampleOpenaiKeys, sampleOpenaiMembers } from './sample.js'

// OpenAI Platform (platform.openai.com) — the real API spend + API-key inventory. This is the developer
// platform only; the ChatGPT seat subscription + Codex usage live behind a SEPARATE credential — those
// surfaces share the brand, not a session.
//
// Four read-only tabs over one transport / one mint:
//   • summary  — the overview: the live month-to-date spend (org → project → model) + the month-over-month
//                chart (from the arrears invoice history) + spend-limit headline stats. The ONLY tab that
//                emits the cross-service Overview rollup (spend.mtd).
//   • billing  — the detail: the per-org billed breakdown + the downloadable invoice history.
//   • apiKeys  — every standard key across the user's orgs + the legacy user-level keys (inventory, not
//                spend: OpenAI exposes no per-key dollar figure).
//   • members  — the org roster merged across the user's work orgs.
// Summary + Billing share one billing fetch (the query cache dedupes it).
//
// AUTH is a minted JWT: the durable session is the platform.openai.com cookie (it carries cf_clearance),
// but the API needs a short-lived `sess-` token minted from an auth0 access_token. The browser keeps that
// access_token in localStorage (auth0 SPA), so Magic Login captures it (storeAs 'accessToken'); resolve()
// then POSTs /dashboard/onboarding/login with `Authorization: Bearer <accessToken>` + body {app:'api'} to
// mint the `sess-` token (and the org list). Each per-org GET carries `openai-organization: <orgId>`.
//
// TRANSPORT needs the browser engine → Electron net.request. On that transport `origin`/`sec-fetch-*` are
// forbidden headers (→ net::ERR_FAILED) — only `referer` is settable — so we never declare Origin.
//
// MONEY: invoice totals + usage line-item costs are in CENTS (Stripe) → centsToMajor. Subscription *_usd
// limits are already dollars. The `sess-` mint + the dynamic auth0 localStorage clientId are the parts that
// need live verification (see resolve / session).

// ── constants ───────────────────────────────────────────────────────────────────────

const API = 'https://api.openai.com'
const REFERER = 'https://platform.openai.com/'
// The auth0 SPA stores the platform access_token under a key shaped
// `@@auth0spajs@@::<clientId>::https://api.openai.com/v1::openid profile email …`. The clientId is dynamic,
// so Magic Login matches by these substrings (key prefix + the API audience) and reads `.body.access_token`.
const ACCESS_TOKEN_KEY_INCLUDES = ['@@auth0spajs@@', 'https://api.openai.com/v1']

// ── types (the data dictionary) ───────────────────────────────────────────────────────

// One org the mint returns; only non-personal orgs carry billable API spend.
export interface PlatformOrg {
  id: string
  title: string
  personal?: boolean
}

// billing — invoices (GET /v1/dashboard/billing/invoices?system=api, one call per org)
export interface RawInvoice {
  id?: string
  number?: string | null
  total?: number // CENTS
  amount_due?: number // CENTS
  tax?: number // CENTS
  created?: number // unix seconds (issue date)
  period_start?: number // unix seconds (usage-period start — the correct bucket for arrears billing)
  period_end?: number
  status?: string
  pdf_url?: string | null
  hosted_invoice_url?: string | null
}
export interface RawInvoiceList {
  data?: RawInvoice[]
}
// One org's invoice list bundled with its identity (assembled in collect()).
export interface RawOrgInvoices {
  orgId: string
  orgName: string
  invoices: RawInvoice[]
}

// billing — spend breakdown (GET /v1/dashboard/billing/usage, current month)
export interface RawLineItem {
  name?: string
  cost?: number // CENTS
  project_id?: string
  project_name?: string
  organization_name?: string
}
export interface RawDailyCost {
  timestamp?: number // unix seconds
  line_items?: RawLineItem[]
}
export interface RawUsage {
  daily_costs?: RawDailyCost[]
}
// One org's usage bundle (assembled in collect()).
export interface RawOrgUsage {
  org: PlatformOrg
  usage: RawUsage
}

export interface SpendLimits {
  softLimitUsd: number | null
  hardLimitUsd: number | null
  planTitle: string | null
}

// apiKeys
export interface RawApiKey {
  sensitive_id?: string
  name?: string | null
  tracking_id?: string
  created?: number // unix seconds
  last_use?: number | null
  enabled?: boolean
  deleted_at?: number | null
  project?: { id: string; title?: string } | null
  organization?: { id: string; title?: string } | null
  user?: { id: string; name?: string | null; is_service_account?: boolean } | null
}
export interface RawApiKeyList {
  data?: RawApiKey[]
}

// normalized domain types
export interface PlatformInvoice {
  id: string
  number: string | null
  orgId: string
  orgName: string
  date?: string // YYYY-MM-DD (usage-period start)
  status: string
  amount: number // USD
  amountDue: number // USD
  tax: number // USD
  hostedUrl: string | null
  pdfUrl: string | null
}
export interface OrgInvoiceSummary {
  orgId: string
  name: string
  total: number
  count: number
}
export interface PlatformBilling {
  invoices: PlatformInvoice[] // merged across orgs, newest-first
  orgs: OrgInvoiceSummary[] // per-org totals, descending
  limits: SpendLimits
}

export interface SpendReport {
  period: string // 'YYYY-MM'
  grandTotal: number // USD
  currentMtd: number | null // USD — grandTotal when the report covers the current month, else null
  daily: Array<{ date: string; value: number }>
}

export interface ApiKeyRow {
  id: string
  name: string
  keyHint: string // masked, e.g. sk-svcac…5x0A
  orgTitle: string | null
  projectTitle: string | null
  legacy: boolean
  creator: string | null
  isServiceAccount: boolean
  created: string | null // YYYY-MM-DD
  lastUsed: string | null // YYYY-MM-DD
  enabled: boolean
}
export interface ApiKeyInventory {
  keys: ApiKeyRow[]
  totalKeys: number
  legacyKeys: number
  disabledKeys: number
}

// members — one org's user list (GET /v1/organization/users?limit=100&after=<cursor>)
export interface RawOrgUser {
  id?: string
  name?: string | null
  email?: string
  role?: string // 'owner' | 'reader'
}
export interface RawOrgUserList {
  data?: RawOrgUser[]
  has_more?: boolean
}

// ── billing: invoice history ──────────────────────────────────────────────────────────
// Pure transform — fixture-tested. Money is CENTS → USD; invoices merge across orgs, newest-first; per-org
// summaries sort by descending total. Dates by the usage-PERIOD start, not `created`: OpenAI bills the API
// in arrears, so an invoice created on the 1st covers the PREVIOUS month — dating by `created` would shift
// every month's spend +1 in the monthly trend + the cross-service Overview. Falls back to `created`.

export const buildOpenaiBilling = (
  perOrg: RawOrgInvoices[] | null | undefined,
  limits: SpendLimits
): PlatformBilling => {
  const invoices: PlatformInvoice[] = []
  const orgSummaries: OrgInvoiceSummary[] = []

  for (const bundle of perOrg ?? []) {
    let orgTotal = 0
    let count = 0

    for (const raw of bundle.invoices ?? []) {
      const amount = centsToMajor(raw.total)

      invoices.push({
        id: raw.id ?? `${bundle.orgId}-${count}`,
        number: raw.number ?? null,
        orgId: bundle.orgId,
        orgName: bundle.orgName,
        date: epochSecDay(raw.period_start) ?? epochSecDay(raw.created),
        status: raw.status ?? 'unknown',
        amount,
        amountDue: centsToMajor(raw.amount_due),
        tax: centsToMajor(raw.tax),
        hostedUrl: raw.hosted_invoice_url ?? null,
        pdfUrl: raw.pdf_url ?? null
      })
      orgTotal += amount
      count += 1
    }

    orgSummaries.push({ orgId: bundle.orgId, name: bundle.orgName, total: orgTotal, count })
  }

  invoices.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
  orgSummaries.sort((a, b) => b.total - a.total)

  return {
    invoices,
    orgs: orgSummaries,
    limits: limits ?? { softLimitUsd: null, hardLimitUsd: null, planTitle: null }
  }
}

// ── billing: current-month spend (org → project → model) ───────────────────────────────
// Pure transform — fixture-tested. line-item `cost` is in CENTS → USD. The grand total is the live
// month-to-date figure; `currentMtd` is non-null only when the report covers the current calendar month
// (a past-month view isn't MTD). This is how the cross-service Overview gets OpenAI's running spend —
// the invoice list is arrears (no current-month row), so the live figure lives here.

// Model = the line-item name up to the first comma ("gpt-5.5, input" → "gpt-5.5").
const modelOf = (name: string): string => {
  const comma = name.indexOf(',')

  return (comma === -1 ? name : name.slice(0, comma)).trim() || 'unknown'
}

export const buildOpenaiSpend = (
  perOrg: RawOrgUsage[] | null | undefined,
  capturedAt: string,
  period: string
): SpendReport => {
  const dailyMap = new Map<string, number>()
  let grandTotal = 0

  for (const bundle of perOrg ?? []) {
    for (const day of bundle.usage.daily_costs ?? []) {
      const date = epochSecDay(day.timestamp)

      for (const li of day.line_items ?? []) {
        const cost = centsToMajor(li.cost)

        grandTotal += cost
        void modelOf(li.name ?? 'unknown')

        if (date) {
          dailyMap.set(date, (dailyMap.get(date) ?? 0) + cost)
        }
      }
    }
  }

  const daily = [...dailyMap.entries()]
    .map(([date, value]) => ({ date, value: round2(value) }))
    .sort((a, b) => a.date.localeCompare(b.date))

  return {
    period,
    grandTotal: round2(grandTotal),
    // Compare the report's period to the capture month in the SAME (reporting) zone — capturedAt is a UTC
    // instant, so slicing it raw would read the next month near the boundary and null out a valid current-month total.
    currentMtd: period === currentMonthKey(new Date(capturedAt)) ? round2(grandTotal) : null,
    daily
  }
}

// ── billing: the Summary result (its spend.mtd is what the cross-service Overview rolls up) ────────────────────────────────────────
// The cross-service Overview rollup tab — lean by design: the headline currentMtd (the live month-to-date
// spend from buildOpenaiSpend), the monthly-spend chart (from the arrears invoice history), and the
// spend-limit / budget-used headline stats. The per-org breakdown + the downloadable invoice list are the
// Billing tab's detail — not here.

export const buildOpenaiSummaryResult = (billingData: PlatformBilling, spend: SpendReport): CapabilityResult => {
  const stats: BillingStat[] = []

  if (billingData.orgs.length) {
    stats.push({ key: 'orgs', label: 'Organizations', role: 'count', value: billingData.orgs.length })
  }

  if (billingData.limits.softLimitUsd != null) {
    stats.push({ key: 'softLimit', label: 'Soft limit', role: 'money', value: billingData.limits.softLimitUsd })
  }

  if (billingData.limits.hardLimitUsd != null) {
    stats.push({ key: 'hardLimit', label: 'Hard limit', role: 'money', value: billingData.limits.hardLimitUsd })
  }

  // How close month-to-date spend is to the hard cap — the actionable "am I about to hit my ceiling" figure.
  // percent role expects a 0..1 fraction. Only when a positive cap and a spend figure both exist.
  if (billingData.limits.hardLimitUsd != null && billingData.limits.hardLimitUsd > 0 && spend.currentMtd != null) {
    stats.push({
      key: 'budgetUsed',
      label: 'Budget used',
      role: 'percent',
      value: spend.currentMtd / billingData.limits.hardLimitUsd
    })
  }

  return billing.summary({
    currentMtd: spend.currentMtd,
    // The usage report's grand total for the current calendar month (invoiced month-to-date).
    mtdBasis: 'invoiced',
    plan: billingData.limits.planTitle ?? undefined,
    // The monthly-spend chart + the cross-service Overview bucket by the period the spend was INCURRED, not the
    // issue date. OpenAI issues each dashboard invoice a day or two into a month, billing the PREVIOUS month in
    // arrears (created == period_start == period_end, all the issue instant). Book it into the month before the
    // issue month so June's bill (issued Jul 2) buckets under June, and the current month (no invoice yet) reads
    // the live MTD headline instead of a phantom bar equal to last month's.
    invoices: billingData.invoices.map((i) => ({
      date: i.date ? monthMinus(i.date, 1) : undefined,
      amount: i.amount,
      status: i.status,
      hostedUrl: i.hostedUrl,
      pdfUrl: i.pdfUrl
    })),
    stats
  })
}

// ── billing: the Billing detail tab (no Overview rollup; headline + chart live on Summary) ──────────────
// The financial detail: the per-org billed breakdown and the downloadable invoice history. Invoices carry
// their Stripe hosted/pdf receipt, so the list is a fileTable (a PDF per row). Each section is dropped when
// it has no rows.

interface OrgRow {
  name: string
  total: number
  count: number
}

// `name` is hidden — carried for the download filename, not rendered.
interface InvoiceRow {
  date: string | null
  org: string
  amount: number
  status: string
  hostedUrl: string | null
  name: string
}

export const buildOpenaiBillingTab = (billing: PlatformBilling): CapabilityResult => {
  const orgs = table<OrgRow>({
    id: 'orgs',
    columns: [
      { key: 'name', label: 'Organization', role: 'label' },
      { key: 'total', label: 'Billed', role: 'money' },
      { key: 'count', label: 'Invoices', role: 'count' }
    ],
    rows: billing.orgs.map((o) => ({ name: o.name, total: o.total, count: o.count }))
  })

  const invoices = table<InvoiceRow>({
    id: 'invoices',
    columns: [
      { key: 'date', label: 'Date', role: 'timestamp' },
      { key: 'org', label: 'Organization', role: 'label' },
      { key: 'amount', label: 'Amount', role: 'money' },
      { key: 'status', label: 'Status', role: 'status' },
      { key: 'hostedUrl', label: 'Receipt', role: 'url' },
      { key: 'name', role: 'label', hidden: true }
    ],
    rows: billing.invoices.map((i) => ({
      date: i.date ?? null,
      org: i.orgName,
      amount: i.amount,
      status: i.status,
      hostedUrl: i.hostedUrl ?? i.pdfUrl ?? null,
      name: `Invoice ${i.date ?? 'unknown'}`
    }))
  })

  return capabilityResult({
    sections: [
      orgs.dataset.rows.length > 0 ? orgs.table({ title: 'By organization' }) : null,
      invoices.dataset.rows.length > 0
        ? invoices.fileTable({
            title: 'Invoices',
            name: 'name',
            source: { url: 'hostedUrl' },
            ext: 'pdf',
            category: 'Invoices'
          })
        : null
    ]
  })
}

// ── apiKeys: inventory ──────────────────────────────────────────────────────────────────
// Pure transform — fixture-tested. Per-org standard keys + the legacy user-level keys, flattened into one
// inventory: deleted keys dropped, deduped by id, sorted by last-used (most recent first, never-used last).
// OpenAI returns an already-masked `sensitive_id` (e.g. sk-svcac…5x0A) — never the full secret — so there's
// no secret to redact here.

const day = (ts?: number | null): string | null => epochSecDay(ts) ?? null

const toRow = (k: RawApiKey, orgFallback: string | null): ApiKeyRow => ({
  id: k.tracking_id ?? k.sensitive_id ?? k.name ?? 'unknown',
  name: k.name || '(unnamed)',
  keyHint: k.sensitive_id ?? '',
  orgTitle: k.organization?.title ?? orgFallback,
  projectTitle: k.project?.title ?? null,
  legacy: !k.project,
  creator: k.user?.name ?? null,
  isServiceAccount: k.user?.is_service_account ?? false,
  created: day(k.created),
  lastUsed: day(k.last_use),
  enabled: k.enabled ?? true
})

export const buildOpenaiKeys = (
  orgKeyLists: RawApiKeyList[] | null | undefined,
  userKeys: RawApiKeyList | null | undefined
): ApiKeyInventory => {
  const byId = new Map<string, ApiKeyRow>()

  const add = (k: RawApiKey, orgFallback: string | null) => {
    if (k.deleted_at) {
      return
    }

    const row = toRow(k, orgFallback)

    if (!byId.has(row.id)) {
      byId.set(row.id, row)
    }
  }

  for (const list of orgKeyLists ?? []) {
    for (const k of list.data ?? []) {
      add(k, null)
    }
  }

  for (const k of userKeys?.data ?? []) {
    add(k, null)
  }

  const keys = [...byId.values()].sort((a, b) => {
    // last-used desc; never-used (null) sinks to the bottom.
    if (a.lastUsed === b.lastUsed) {
      return a.name.localeCompare(b.name)
    }

    if (!a.lastUsed) {
      return 1
    }

    if (!b.lastUsed) {
      return -1
    }

    return b.lastUsed.localeCompare(a.lastUsed)
  })

  return {
    keys,
    totalKeys: keys.length,
    legacyKeys: keys.filter((k) => k.legacy).length,
    disabledKeys: keys.filter((k) => !k.enabled).length
  }
}

// Map the inventory onto the shared apiKeys result. orgTitle/projectTitle are folded into the name hint so
// the generic key table stays one row per key (the preset's columns are name/key/created/last-used/status).
export const buildOpenaiKeysResult = (inventory: ApiKeyInventory): CapabilityResult => {
  const input: ApiKeysInput = {
    keys: inventory.keys.map((k) => ({
      id: k.id,
      name: k.projectTitle ? `${k.name} · ${k.projectTitle}` : k.name,
      masked: k.keyHint || '—',
      createdAt: k.created ?? undefined,
      lastUsedAt: k.lastUsed ?? undefined,
      revoked: !k.enabled
    }))
  }

  return keys.result(input)
}

// ── auth: mint the `sess-` token from the captured auth0 access_token ───────────────────
// POST /dashboard/onboarding/login with the access_token as a Bearer → a `sess-` token + the org list. The
// token MUST be the one issued for platform.openai.com's own auth0 client (the audience the captured
// access_token carries); an access_token from a different client is rejected 403 unsupported_client. The
// resulting `sess-` token is the Bearer for every dashboard call; the org list drives the per-org loop.
// Both the token (`user.session.sensitive_id`) and the org list (`user.orgs.data`) hang off `user`.

interface RawLoginResponse {
  // The dashboard session token (`sess-` prefix) and the org list both hang off `user`. A flat `session`
  // shape is tolerated for the token.
  user?: {
    session?: { sensitive_id?: string }
    orgs?: { data?: Array<{ id: string; title?: string; name?: string; personal?: boolean }> }
  }
  session?: { sensitive_id?: string }
}

export interface MintedSession {
  sessToken: string
  orgs: PlatformOrg[]
}

// Pure shape-extraction so the mint parse is fixture-tested independent of the network.
export const parseMintedSession = (resp: RawLoginResponse | null | undefined): MintedSession => {
  const sessToken = resp?.user?.session?.sensitive_id ?? resp?.session?.sensitive_id ?? ''
  const orgs: PlatformOrg[] = (resp?.user?.orgs?.data ?? []).map((o) => ({
    id: o.id,
    title: o.title ?? o.name ?? o.id,
    personal: o.personal ?? false
  }))

  return { sessToken, orgs }
}

const mintSession = async (ctx: AuthContext | CollectContext): Promise<MintedSession> => {
  const accessToken = ctx.creds.get('accessToken')

  if (!accessToken) {
    throw new Error('OpenAI: no access token captured — re-run Magic Login on platform.openai.com.')
  }

  const resp = await ctx.client.post<RawLoginResponse>(
    `${API}/dashboard/onboarding/login`,
    { app: 'api' },
    { Authorization: `Bearer ${accessToken}`, Referer: REFERER }
  )

  const minted = parseMintedSession(resp)

  if (!minted.sessToken) {
    throw new Error('OpenAI: login did not return a session token — the captured access token may be stale.')
  }

  return minted
}

// resolve() attaches the minted `sess-` token as the Bearer. Core may memoize this per client lifetime
// (the `sess-` token is stable across a fetch run); the per-org `openai-organization` header is set
// per-call inside collect() since it varies by org.
const resolveOpenaiAuth = async (ctx: AuthContext): Promise<AuthAttachment> => {
  const { sessToken } = await mintSession(ctx)

  return { headers: { Authorization: `Bearer ${sessToken}` } }
}

// ── collect() bodies ─────────────────────────────────────────────────────────────────────
// resolve() already attached the minted Bearer; collect() adds the per-org `openai-organization` header.
// LIVE-VERIFY: the paths + the `openai-organization` switching are unconfirmed against a live session.

const orgGet = <T>(ctx: CollectContext, orgId: string, path: string) =>
  ctx.client
    .request<T>({ url: `${API}${path}`, method: 'GET', headers: { 'openai-organization': orgId }, referer: REFERER })
    .then((r) => r.data)

// Re-mint to get the org list (collect() can't see resolve()'s minted orgs). Personal orgs carry no
// billable API spend, so only work orgs are walked.
const workOrgs = async (ctx: CollectContext): Promise<PlatformOrg[]> => {
  const { orgs } = await mintSession(ctx)

  return orgs.filter((o) => !o.personal)
}

interface RawSubscription {
  soft_limit_usd?: number
  hard_limit_usd?: number
  plan?: { title?: string }
}

// The raw billing bundle Summary + Billing both fetch: the per-org invoice/usage lists, the org spend
// limits, and the capture moment + current month (so the pure build can decide whether the spend report is
// MTD). `build` runs buildOpenaiBilling/buildOpenaiSpend over it.
export interface OpenaiBillingRaw {
  perOrgInvoices: RawOrgInvoices[]
  perOrgUsage: RawOrgUsage[]
  limits: SpendLimits
  capturedAt: string // ISO timestamp of the fetch
  period: string // 'YYYY-MM' — the usage report's month
}

// Summary + Billing share the same per-org invoice/usage/subscription reads. Both capabilities fetch
// fetchOpenaiBilling; the core query cache dedupes the underlying GETs across the two tabs.
const fetchOpenaiBilling = async (ctx: CollectContext): Promise<OpenaiBillingRaw> => {
  const orgs = await workOrgs(ctx)
  const now = new Date()
  const month = currentMonthKey(now)
  const startDate = `${month}-01`
  // The window end in the reporting zone (not a raw UTC slice), so start_date/end_date stay in the same zone and
  // the range doesn't spill an out-of-month partial day into the current-month total near the boundary.
  const endDate = epochMsDay(now.getTime())

  let limits: SpendLimits = { softLimitUsd: null, hardLimitUsd: null, planTitle: null }
  const perOrgInvoices: RawOrgInvoices[] = []
  const perOrgUsage: RawOrgUsage[] = []

  for (const org of orgs) {
    const [invoices, usage] = await Promise.all([
      orgGet<RawInvoiceList>(ctx, org.id, `/v1/dashboard/billing/invoices?system=api`).catch(() => null),
      orgGet<RawUsage>(
        ctx,
        org.id,
        `/v1/dashboard/billing/usage?end_date=${endDate}&exclude_project_costs=false&new_endpoint=false&start_date=${startDate}`
      ).catch(() => null)
    ])

    perOrgInvoices.push({ orgId: org.id, orgName: org.title, invoices: invoices?.data ?? [] })
    perOrgUsage.push({ org, usage: usage ?? {} })

    // Limits are org-scoped; surface the first org's.
    if (limits.hardLimitUsd === null) {
      const sub = await orgGet<RawSubscription>(ctx, org.id, `/v1/dashboard/billing/subscription`).catch(() => null)

      if (sub) {
        limits = {
          softLimitUsd: sub.soft_limit_usd ?? null,
          hardLimitUsd: sub.hard_limit_usd ?? null,
          planTitle: sub.plan?.title ?? null
        }
      }
    }
  }

  return { perOrgInvoices, perOrgUsage, limits, capturedAt: now.toISOString(), period: month }
}

// Pure raw → result wrappers (the cents→USD + MTD normalization lives in buildOpenaiBilling/buildOpenaiSpend).
export const buildOpenaiSummary = (raw: OpenaiBillingRaw): CapabilityResult =>
  buildOpenaiSummaryResult(
    buildOpenaiBilling(raw.perOrgInvoices, raw.limits),
    buildOpenaiSpend(raw.perOrgUsage, raw.capturedAt, raw.period)
  )

export const buildOpenaiBillingResult = (raw: OpenaiBillingRaw): CapabilityResult =>
  buildOpenaiBillingTab(buildOpenaiBilling(raw.perOrgInvoices, raw.limits))

// The raw apiKeys bundle: each work org's standard-key list + the legacy user-level keys.
export interface OpenaiKeysRaw {
  orgKeyLists: RawApiKeyList[]
  userKeys: RawApiKeyList
}

const fetchOpenaiKeys = async (ctx: CollectContext): Promise<OpenaiKeysRaw> => {
  const orgs = await workOrgs(ctx)

  const orgKeyLists: RawApiKeyList[] = []

  for (const org of orgs) {
    const list = await orgGet<RawApiKeyList>(
      ctx,
      org.id,
      `/dashboard/organizations/${org.id}/api_keys?include_disabled=true&key_type=standard&limit=100`
    ).catch(() => null)

    if (list) {
      orgKeyLists.push(list)
    }
  }

  const userKeys =
    (await orgGet<RawApiKeyList>(ctx, orgs[0]?.id ?? '', `/dashboard/user/api_keys?include_disabled=true`).catch(
      () => null
    )) ?? {}

  return { orgKeyLists, userKeys }
}

export const buildOpenaiKeysTab = (raw: OpenaiKeysRaw): CapabilityResult =>
  buildOpenaiKeysResult(buildOpenaiKeys(raw.orgKeyLists, raw.userKeys))

// ── members: the org roster across the user's work orgs ─────────────────────────────────
// Pure transform — fixture-tested. Merge each org's user list into one roster, deduped by id (a person can
// belong to several orgs; first occurrence wins). Role is the org role ('owner' | 'reader').
export const buildOpenaiMembers = (lists: RawOrgUserList[] | null | undefined): MembersInput => {
  const byId = new Map<string, MemberInput>()

  for (const list of lists ?? []) {
    for (const u of list.data ?? []) {
      const id = u.id ?? u.email

      if (id && !byId.has(id)) {
        byId.set(id, { id, name: u.name ?? undefined, email: u.email, role: u.role ?? undefined })
      }
    }
  }

  return { members: [...byId.values()] }
}

// One org's full roster, walking the `after` cursor. LIVE-VERIFY: the org-users path + pagination cursor
// field are unconfirmed against a live session (the minted `sess-` Bearer + per-org header are reused).
const fetchOrgUsers = async (ctx: CollectContext, orgId: string): Promise<RawOrgUserList> => {
  const data: RawOrgUser[] = []
  let after = ''

  for (let i = 0; i < 10; i += 1) {
    const page = await orgGet<RawOrgUserList>(
      ctx,
      orgId,
      `/v1/organization/users?limit=100${after ? `&after=${after}` : ''}`
    ).catch(() => null)
    const rows = page?.data ?? []

    data.push(...rows)

    if (!page?.has_more || !rows.length) {
      break
    }

    after = rows[rows.length - 1]?.id ?? ''

    if (!after) {
      break
    }
  }

  return { data }
}

// The raw members bundle: each work org's full user list.
export interface OpenaiMembersRaw {
  lists: RawOrgUserList[]
}

const fetchOpenaiMembers = async (ctx: CollectContext): Promise<OpenaiMembersRaw> => {
  const orgs = await workOrgs(ctx)
  const lists = await Promise.all(orgs.map((o) => fetchOrgUsers(ctx, o.id)))

  return { lists }
}

export const buildOpenaiMembersResult = (raw: OpenaiMembersRaw): CapabilityResult =>
  members.result(buildOpenaiMembers(raw.lists))

// ── descriptor ──────────────────────────────────────────────────────────────────────────

export const openaiPlugin = definePlugin({
  reportingCurrency: 'USD',
  meta: {
    id: 'openai-platform',
    name: 'OpenAI Platform',
    vendor: 'OpenAI',
    category: 'ai',
    color: '#10a37f',
    description: 'OpenAI Platform — API spend (monthly invoices + current-month usage) and key inventory.',
    homepage: 'https://platform.openai.com',
    dashboardUrl: 'https://platform.openai.com/usage'
  },
  session: {
    // Open a deep authenticated page so the post-OAuth redirect returns HERE (a marker page) and auto-capture
    // fires — a generic landing (e.g. /home) settles on no marker and never captures.
    loginUrl: 'https://platform.openai.com/settings/organization/billing/overview',
    dashboardMarkers: ['/home', '/usage', '/api-keys', '/settings/organization'],
    cookieDomains: ['openai.com'],
    // The credential is NOT a cookie — it's the auth0 access_token in localStorage (the cookie only carries
    // cf_clearance). The key embeds a dynamic auth0 clientId, so match by substrings + read body.access_token.
    localStorageTokens: [
      { keyIncludes: ACCESS_TOKEN_KEY_INCLUDES, jsonPath: 'body.access_token', storeAs: 'accessToken' }
    ]
  },
  // minted-jwt: the durable cookie/access_token is exchanged for a short-lived `sess-` token per fetch run.
  auth: { kind: 'minted-jwt', resolve: resolveOpenaiAuth },
  transport: {
    requiresBrowserEngine: true,
    baseUrl: API
  },
  capabilities: [
    // Summary + Billing share one billing fetch (the query cache dedupes it); both bind the same sample.
    defineCapability({
      id: 'summary',
      label: 'Summary',
      fetch: fetchOpenaiBilling,
      build: buildOpenaiSummary,
      sample: sampleOpenaiBilling
    }),
    defineCapability({
      id: 'billing',
      label: 'Billing',
      fetch: fetchOpenaiBilling,
      build: buildOpenaiBillingResult,
      sample: sampleOpenaiBilling
    }),
    defineCapability({
      id: 'apiKeys',
      label: 'API Keys',
      fetch: fetchOpenaiKeys,
      build: buildOpenaiKeysTab,
      sample: sampleOpenaiKeys
    }),
    defineCapability({
      id: 'members',
      label: 'Members',
      fetch: fetchOpenaiMembers,
      build: buildOpenaiMembersResult,
      sample: sampleOpenaiMembers
    })
  ],
  probe: async (ctx) => {
    // Minting the `sess-` token proves the captured access_token still authenticates against the platform.
    await mintSession(ctx)
  }
})
