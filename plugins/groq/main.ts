import {
  defineCapability,
  defineConfigSchema,
  definePlugin,
  type AuthAttachment,
  type AuthContext,
  type CollectContext,
  type ConfigOf
} from '@butinapp/sdk'
import { capabilityResult, record, table, type CapabilityResult, type RecordHandle } from '@butinapp/sdk/data'
import { DateTime, upperFirst } from '@butinapp/sdk/libs'
import {
  billing,
  type ApiKeysInput,
  blocks,
  keys,
  members,
  type BillingInput,
  type MembersInput,
  type TrendPoint
} from '@butinapp/sdk/presets'
import {
  byDayAsc,
  byDayDesc,
  centsToMajor,
  dayOf,
  epochMsDay,
  epochSecDay,
  getReportingZone,
  monthMinus,
  round2
} from '@butinapp/sdk/util'

import { sampleGroqActivity, sampleGroqBilling, sampleGroqKeys, sampleGroqUsers } from './sample.js'

// Groq: minted-jwt auth over Node (the mint needs an Origin header → axios, not net.request). Groq
// delegates auth to Stytch B2B: api.groq.com takes a Bearer that is a Stytch member-session JWT living
// ~5 min. The durable credential is the `stytch_session` cookie (opaque, 30-day) captured with its
// companion `stytch_session_jwt`. Per fetch the captured JWT is reused while valid, else a fresh one is
// minted. The org id is pinned in Settings.
// Money: invoice/usage `total_amount_cents` are cents; activity `cost` is dollars.
const STYTCH_BASE = 'https://api.stytchb2b.groq.com'
const CONSOLE_ORIGIN = 'https://console.groq.com'
const GROQ_API = 'https://api.groq.com'
const STYTCH_PUBLIC_TOKEN = 'public-token-live-58df57a9-a1f5-4066-bc0c-2ff942db684f'
// Stytch's JS SDK double-submits the public token as Basic user:pass.
const STYTCH_BASIC = Buffer.from(`${STYTCH_PUBLIC_TOKEN}:${STYTCH_PUBLIC_TOKEN}`).toString('base64')
// Telemetry header Stytch's OPTIONS preflight allow-lists (a single-use event id Stytch does not
// validate). Without it the mint's CORS preflight can be rejected.
const X_SDK_CLIENT =
  'eyJldmVudF9pZCI6ImV2ZW50LWlkLWVjODBhNGViLWI2MWEtNDdjNi05ZTAyLTQ3ZDQxMWNiZTcwNiIsImFwcF9zZXNzaW9uX2lkIjoiYXBwLXNlc3Npb24taWQtZWQ4MTEwZTQtYWIxNC00MTZiLTgyM2UtYjgzYzdiZGQwOGJjIiwicGVyc2lzdGVudF9pZCI6InBlcnNpc3RlbnQtaWQtN2IzMDc3MDktMWZiMi00ZTcyLTlkZTktMWVjYWRlZGZjZTY1IiwiY2xpZW50X3NlbnRfYXQiOiIyMDI2LTA2LTExVDE0OjA4OjEzLjIyOVoiLCJ0aW1lem9uZSI6IkFtZXJpY2EvTmV3X1lvcmsiLCJhcHAiOnsiaWRlbnRpZmllciI6ImNvbnNvbGUuZ3JvcS5jb20ifSwic2RrIjp7ImlkZW50aWZpZXIiOiJTdHl0Y2guanMgSmF2YXNjcmlwdCBTREsiLCJ2ZXJzaW9uIjoiNS40My4wIn19'

// --- types: all Raw* wire shapes + normalized domain types (the data dictionary) ---
interface StytchResponse {
  data?: { session_jwt?: string }
  session_jwt?: string
}

export interface RawGroqInvoice {
  id?: string
  file_url?: string
  created_at?: number // epoch ms
  status?: string
  payment_status?: string
  total_amount_cents?: number
}

export interface RawGroqInvoiceList {
  data?: RawGroqInvoice[]
}

export interface RawCurrentUsage {
  from_datetime?: string
  to_datetime?: string
  currency?: string
  total_amount_cents?: number
  amount_cents?: number
}

export interface RawGroqProfile {
  user?: { orgs?: { data?: { id?: string; billing_plan?: string }[] } }
}

// summary + billing share these org-scoped reads; the orgId rides along so build can resolve the plan.
export interface GroqBillingData {
  orgId: string
  invoices: RawGroqInvoiceList
  current: RawCurrentUsage
  info: RawGroqBillingInfo | null
  profile: RawGroqProfile | null
}

export interface RawActivityRow {
  model?: string
  timestamp?: number // epoch seconds, day-bucketed
  num_requests?: number
  n_context_tokens_total?: number // prompt/input tokens
  n_generated_tokens_total?: number // completion/output tokens
  cost?: number // dollars (float)
}

export interface RawActivityList {
  data?: RawActivityRow[]
}

// usage's fetch bundles the activity feed with the period bounds off usage/current.
export interface GroqUsageData {
  activity: RawActivityList
  current: RawCurrentUsage
}

// Per-model consumption for the open period: requests, input/output tokens, dollar cost.
interface GroqModelUsage {
  model: string
  requests: number
  inputTokens: number
  outputTokens: number
  cost: number // dollars
}

interface GroqUsage {
  periodStart?: string
  periodEnd?: string
  totalRequests: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCost: number // dollars
  models: GroqModelUsage[] // costliest first
  daily: TrendPoint[] // per-day cost, ascending
}

export interface RawGroqApiKey {
  id?: string
  name?: string
  secret_key?: string // already masked by Groq
  created?: number // epoch ms
  last_use?: number // epoch ms; 0 = never used
}

export interface RawGroqApiKeyList {
  data?: RawGroqApiKey[]
}

export interface RawGroqOrgUser {
  role?: string
  user?: { id?: string; name?: string; email?: string }
}

export interface RawGroqUsers {
  members?: { data?: RawGroqOrgUser[] }
}

export interface RawGroqBillingInfo {
  name?: string
  customer_type?: string
  country?: string
  emails?: string[]
  tax_identification_number?: string
}

// --- auth: mint a fresh Stytch member-session JWT from the durable stytch_session cookie ---

// Seconds of validity left on a JWT (from its `exp`), or 0 if unparseable.
export const jwtSecondsLeft = (jwt: string): number => {
  try {
    const payload = jwt.split('.')[1]

    if (!payload) {
      return 0
    }

    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    const exp = (JSON.parse(json) as { exp?: number }).exp

    return typeof exp === 'number' ? exp - Math.floor(Date.now() / 1000) : 0
  } catch {
    return 0
  }
}

export const cookieValue = (cookie: string, name: string): string | undefined => {
  const part = cookie.split(/;\s*/).find((p) => p.startsWith(`${name}=`))

  return part?.slice(name.length + 1)
}

// resolve(): fast-path the captured stytch_session_jwt while it has >60s left; otherwise POST the
// durable stytch_session cookie to Stytch to mint a fresh ~5min JWT (with the SDK telemetry headers
// Stytch's preflight expects). Returns the Bearer + Origin; the org is discovered/attached in collect.
export const resolveGroqJwt = async ({ client, creds }: AuthContext): Promise<AuthAttachment> => {
  const cookie = creds.get('cookie') ?? ''
  let jwt = cookieValue(cookie, 'stytch_session_jwt')

  if (!jwt || jwtSecondsLeft(jwt) <= 60) {
    const resp = await client.post<StytchResponse>(
      `${STYTCH_BASE}/sdk/v1/b2b/sessions/authenticate`,
      {},
      {
        Authorization: `Basic ${STYTCH_BASIC}`,
        Origin: CONSOLE_ORIGIN,
        Referer: `${CONSOLE_ORIGIN}/`,
        'X-SDK-Client': X_SDK_CLIENT,
        'X-SDK-Parent-Host': CONSOLE_ORIGIN
      }
    )

    jwt = resp?.data?.session_jwt ?? resp?.session_jwt
  }

  if (!jwt) {
    throw new Error('[groq] could not mint a Stytch session JWT — re-capture the console session.')
  }

  return { headers: { Authorization: `Bearer ${jwt}`, Origin: CONSOLE_ORIGIN } }
}

// --- org id resolution ---

// Groq's platform API is **org-scoped only** — every endpoint lives under /platform/v1/organizations/<org>/…
// and there is NO list endpoint (GET /platform/v1/organizations 404s). So the org id must be pinned in
// Settings; it can't be auto-detected. Find it in the console (the billing-page URL, or the `Groq-Organization`
// header / path on any /platform/v1 request in devtools — it looks like `org_…`).
const resolveOrgId = (ctx: CollectContext<GroqConfig>): string => {
  const orgId = ctx.config.orgId?.trim()

  if (!orgId) {
    throw new Error('Set your Groq Organization ID in Settings — Groq has no org-list endpoint to auto-detect it.')
  }

  return orgId
}

const orgGet = <T>(ctx: CollectContext<GroqConfig>, orgId: string, path: string) =>
  ctx.client.get<T>(`${GROQ_API}/platform/v1/organizations/${orgId}${path}`, { 'Groq-Organization': orgId })

// --- billing: invoice history (`/billing/invoices`) + accrued spend (`/usage/current`) ---

// Invoice history + the in-progress period's accrued spend (the MTD).
export const buildGroqBilling = (rawInvoices: RawGroqInvoiceList, rawCurrent: RawCurrentUsage): BillingInput => {
  const invoices = (rawInvoices?.data ?? [])
    .map((inv, i) => ({
      id: inv.id ?? `inv-${i}`,
      date: epochMsDay(inv.created_at) ?? '',
      amount: centsToMajor(inv.total_amount_cents),
      status: inv.payment_status ?? inv.status ?? 'unknown',
      pdfUrl: inv.file_url || null
    }))
    .sort(byDayDesc)

  return {
    currentMtd: centsToMajor(rawCurrent?.total_amount_cents ?? rawCurrent?.amount_cents),
    currency: (rawCurrent?.currency ?? 'USD').toUpperCase(),
    invoices
  }
}

// The org's billing plan is authoritative on the user profile (`/user/profile` → `orgs[].billing_plan`),
// present even when there's no usage. `billing_plan` encodes tier_flags_cadence
// ('developer_early_access_monthly'); the leading tier token is title-cased ('Developer' / 'Free' /
// 'Enterprise') to match the console's plan cards.
export const extractGroqPlan = (profile: RawGroqProfile | null | undefined, orgId: string): string | null => {
  const org = (profile?.user?.orgs?.data ?? []).find((o) => o.id === orgId)
  const tier = org?.billing_plan?.split('_')[0]

  return tier ? upperFirst(tier) : null
}

// --- Summary tab: its spend.mtd summary is what the cross-service Overview rolls up ---
// The shared billing.summary preset (account stat + monthly-spend chart + spend.mtd summary), plus the
// plan and an invoice-count stat (off the invoice list already fetched for the chart).
export const buildGroqSummaryResult = (
  rawInvoices: RawGroqInvoiceList,
  rawCurrent: RawCurrentUsage,
  plan?: string | null
): CapabilityResult => {
  const billingData = buildGroqBilling(rawInvoices, rawCurrent)

  return billing.summary({
    currentMtd: billingData.currentMtd,
    // Usage-metered spend accruing live over the open period.
    mtdBasis: 'accrued',
    currency: billingData.currency,
    plan: plan ?? undefined,
    // Groq finalizes each Stripe invoice a day or two into the following month, billing the prior month in
    // arrears, so `created_at` is one month AFTER the spend it covers. Bucket the chart by the incurred month
    // so June's bill lands under June and the open month (no invoice yet) reads the live accrual via backfill.
    invoices: billingData.invoices.map((i) => ({ ...i, date: i.date ? monthMinus(i.date, 1) : i.date })),
    stats: [{ key: 'invoiceCount', label: 'Invoices', role: 'count', value: billingData.invoices.length }]
  })
}

// --- Billing tab: the invoice history + an Account keyvalue (plan + billing identity) ---
// The headline (MTD / plan / monthly chart) lives on Summary; the account block is dropped when everything
// is blank (a fresh org).

interface GroqInvoiceRow {
  // Hidden — the Groq invoice id rides as the ledger key so an invoice's status/amount accumulates past the
  // fetch window (date coerces to '' when created_at is absent, so it isn't a stable identity).
  id: string
  date: string | null
  amount: number
  status: string
  pdfUrl: string | null
  // Hidden — carried for the download filename, declared not smuggled.
  name: string
}

export const buildGroqBillingResult = (
  rawInvoices: RawGroqInvoiceList,
  rawCurrent: RawCurrentUsage,
  rawInfo?: RawGroqBillingInfo | null,
  plan?: string | null
): CapabilityResult => {
  const billing = buildGroqBilling(rawInvoices, rawCurrent)
  const invoices = table<GroqInvoiceRow>({
    id: 'invoices',
    columns: [
      { key: 'date', label: 'Date', role: 'timestamp' },
      { key: 'amount', label: 'Amount', role: 'money', currency: billing.currency },
      { key: 'status', label: 'Status', role: 'status' },
      { key: 'pdfUrl', label: 'PDF', role: 'url' },
      { key: 'name', role: 'label', hidden: true },
      { key: 'id', role: 'identifier', hidden: true }
    ],
    rows: billing.invoices.map((i, idx) => ({
      id: i.id ?? `inv-${idx}`,
      date: i.date || null,
      amount: i.amount,
      status: i.status,
      pdfUrl: i.pdfUrl ?? null,
      name: `Invoice ${i.date || 'unknown'}`
    })),
    key: 'id'
  })
  // The invoices table is downloadable: each row's invoice PDF (pdfUrl) becomes a selectable file the host
  // downloads via the shared engine (selection + Download all/selected + per-row Open + on-disk size).
  const invoicesView = invoices.fileTable({
    title: 'Invoices',
    name: 'name',
    source: { url: 'pdfUrl' },
    ext: 'pdf',
    category: 'Invoices'
  })
  const account = buildGroqAccount(rawInfo ?? {}, plan)
  const hasAccount = Object.values(account.dataset.value).some((v) => v !== null)

  return capabilityResult({
    sections: [invoicesView, hasAccount && account.keyvalue({ title: 'Account' })]
  })
}

// Summary + Billing both need the same org-scoped endpoints (invoices + accrued usage + billing identity +
// the plan off the user profile). Both collects call loadGroqBilling; the core query cache dedupes the
// underlying reads (keyed by org id via the call site). invoices + current are load-bearing; info + profile
// are best-effort.
const loadGroqBilling = async (ctx: CollectContext<GroqConfig>): Promise<GroqBillingData> => {
  const orgId = resolveOrgId(ctx)
  const [invoices, current, info, profile] = await Promise.all([
    orgGet<RawGroqInvoiceList>(ctx, orgId, '/billing/invoices'),
    orgGet<RawCurrentUsage>(ctx, orgId, '/usage/current'),
    orgGet<RawGroqBillingInfo>(ctx, orgId, '/billing/info').catch(() => null),
    ctx.client.get<RawGroqProfile>(`${GROQ_API}/platform/v1/user/profile`).catch(() => null)
  ])

  return { orgId, invoices: invoices ?? {}, current: current ?? {}, info, profile }
}

// --- usage: per-model tokens/requests/cost from `/activity` (cost is DOLLARS, tokens are counts) + period
// bounds. `activity` carries input (`n_context_tokens_total`) and output (`n_generated_tokens_total`) token
// totals and an epoch-second `timestamp` per row — the daily-cost trend buckets on that. ---

// Aggregate activity rows to per-model tokens/requests/cost (costliest first), period totals, and a per-day
// cost trend.
export const buildGroqUsage = (rawActivity: RawActivityList, rawCurrent: RawCurrentUsage): GroqUsage => {
  const byModel = new Map<string, GroqModelUsage>()
  const byDay = new Map<string, number>()
  const totals = { requests: 0, inputTokens: 0, outputTokens: 0, cost: 0 }

  for (const row of rawActivity?.data ?? []) {
    const requests = row.num_requests ?? 0
    const inputTokens = row.n_context_tokens_total ?? 0
    const outputTokens = row.n_generated_tokens_total ?? 0
    const cost = row.cost ?? 0

    totals.requests += requests
    totals.inputTokens += inputTokens
    totals.outputTokens += outputTokens
    totals.cost += cost

    const model = row.model || 'unknown'
    const m = byModel.get(model) ?? { model, requests: 0, inputTokens: 0, outputTokens: 0, cost: 0 }

    m.requests += requests
    m.inputTokens += inputTokens
    m.outputTokens += outputTokens
    m.cost += cost
    byModel.set(model, m)

    const day = epochSecDay(row.timestamp)

    if (day) {
      byDay.set(day, (byDay.get(day) ?? 0) + cost)
    }
  }

  return {
    periodStart: dayOf(rawCurrent?.from_datetime),
    periodEnd: dayOf(rawCurrent?.to_datetime),
    totalRequests: totals.requests,
    totalInputTokens: totals.inputTokens,
    totalOutputTokens: totals.outputTokens,
    totalCost: round2(totals.cost),
    models: [...byModel.values()].sort((a, b) => b.cost - a.cost).map((m) => ({ ...m, cost: round2(m.cost) })),
    daily: [...byDay.entries()].map(([date, cost]) => ({ date, cost: round2(cost) })).sort(byDayAsc)
  }
}

interface GroqUsageTotalsRow {
  requests: number
  inputTokens: number
  outputTokens: number
  spend: number
  period: string | null
}

interface GroqUsageModelRow {
  model: string
  requests: number
  inputTokens: number
  outputTokens: number
  cost: number
}

// Usage tab: a totals stat row + a daily-cost trend + the per-model table; the period's on-demand spend is
// the usage.primary the Overview rolls up (with the daily trend as its spark).
export const buildGroqUsageResult = (usage: GroqUsage): CapabilityResult => {
  const totals = record<GroqUsageTotalsRow>({
    id: 'usage',
    fields: [
      { key: 'spend', role: 'money', label: 'On-demand spend' },
      { key: 'requests', role: 'count', label: 'Requests' },
      { key: 'inputTokens', role: 'count', label: 'Input tokens' },
      { key: 'outputTokens', role: 'count', label: 'Output tokens' },
      { key: 'period', role: 'text', label: 'Period' }
    ],
    value: {
      requests: usage.totalRequests,
      inputTokens: usage.totalInputTokens,
      outputTokens: usage.totalOutputTokens,
      spend: usage.totalCost,
      period: [usage.periodStart, usage.periodEnd].filter(Boolean).join(' → ') || null
    }
  })

  const models = table<GroqUsageModelRow>({
    id: 'models',
    columns: [
      { key: 'model', label: 'Model', role: 'label' },
      { key: 'requests', label: 'Requests', role: 'count' },
      { key: 'inputTokens', label: 'Input tokens', role: 'count' },
      { key: 'outputTokens', label: 'Output tokens', role: 'count' },
      { key: 'cost', label: 'Cost', role: 'money' }
    ],
    rows: usage.models,
    // One row per model (aggregated), so the model name is its stable identity in the ledger.
    key: 'model'
  })
  const daily = usage.daily.length ? blocks.daily('daily', usage.daily, { title: 'Daily cost' }) : undefined

  return capabilityResult({
    sections: [totals.stat(), daily, models.table({ title: 'Usage by model' })],
    summaries: usage.totalCost
      ? [
          {
            section: 'other',
            label: 'On-demand spend',
            value: usage.totalCost,
            role: 'money',
            ...(usage.daily.length ? { spark: { dataset: 'daily', x: 'date', y: 'cost' } } : {})
          }
        ]
      : undefined
  })
}

const fetchGroqUsage = async (ctx: CollectContext<GroqConfig>): Promise<GroqUsageData> => {
  const orgId = resolveOrgId(ctx)
  // Current calendar month up to now, in the reporting zone (matching usage/current's period bounds and the
  // rest of the app), so at the UTC/local boundary the window doesn't jump to the next month and return ~nothing.
  const now = DateTime.now().setZone(getReportingZone())
  const start = Math.floor(now.startOf('month').toSeconds())
  const end = Math.floor(now.toSeconds())
  const [activity, current] = await Promise.all([
    orgGet<RawActivityList>(ctx, orgId, `/activity?start_date=${start}&end_date=${end}`),
    orgGet<RawCurrentUsage>(ctx, orgId, '/usage/current')
  ])

  return { activity: activity ?? {}, current: current ?? {} }
}

// --- apiKeys: `/api_keys` (underscore); Groq pre-masks the secret ---

// Groq's key list carries no revoked flag, so all listed keys are active.
export const buildGroqKeys = (raw: RawGroqApiKeyList): ApiKeysInput => ({
  keys: (raw?.data ?? []).map((k) => ({
    id: k.id ?? '',
    name: k.name || '(unnamed)',
    masked: k.secret_key ?? '',
    createdAt: epochMsDay(k.created),
    lastUsedAt: epochMsDay(k.last_use),
    revoked: false
  }))
})

const fetchGroqKeys = async (ctx: CollectContext<GroqConfig>): Promise<RawGroqApiKeyList> =>
  (await orgGet<RawGroqApiKeyList>(ctx, resolveOrgId(ctx), '/api_keys')) ?? {}

// --- members: org user roster (`/users`) — name / email / role ---

// Groq nests each person's identity under `user`; the org role sits on the row.
export const buildGroqMembers = (raw: RawGroqUsers): MembersInput => ({
  members: (raw?.members?.data ?? []).map((m, i) => ({
    id: m.user?.id ?? String(i),
    name: m.user?.name,
    email: m.user?.email,
    role: m.role
  }))
})

const fetchGroqMembers = async (ctx: CollectContext<GroqConfig>): Promise<RawGroqUsers> =>
  (await orgGet<RawGroqUsers>(ctx, resolveOrgId(ctx), '/users')) ?? {}

// --- account: org billing identity (`/billing/info`) + the plan, folded into the Billing tab. ---

interface GroqAccountRow {
  plan: string | null
  name: string | null
  customerType: string | null
  country: string | null
  billingEmail: string | null
  taxId: string | null
}

// The plan is passed in (resolved by extractGroqPlan); everything else is billing identity. Empty strings
// degrade to null so the keyvalue view omits blanks.
export const buildGroqAccount = (raw: RawGroqBillingInfo, plan?: string | null): RecordHandle<GroqAccountRow> =>
  record<GroqAccountRow>({
    id: 'accountInfo',
    fields: [
      { key: 'plan', label: 'Plan', role: 'label' },
      { key: 'name', label: 'Account name', role: 'label' },
      { key: 'customerType', label: 'Type', role: 'text' },
      { key: 'country', label: 'Country', role: 'text' },
      { key: 'billingEmail', label: 'Billing email', role: 'identifier' },
      { key: 'taxId', label: 'Tax ID', role: 'identifier' }
    ],
    value: {
      plan: plan || null,
      name: raw?.name || null,
      customerType: raw?.customer_type || null,
      country: raw?.country || null,
      billingEmail: (raw?.emails ?? []).join(', ') || null,
      taxId: raw?.tax_identification_number || null
    }
  })

export const groqConfigSchema = defineConfigSchema([
  {
    key: 'orgId',
    label: 'Organization ID',
    kind: 'text',
    help: 'The org id (org_…). Auto-detected at sign-in from the Groq-Organization request header; set it only to override (Groq has no org-list endpoint).'
  }
])

export type GroqConfig = ConfigOf<typeof groqConfigSchema>

export const groqPlugin = definePlugin({
  reportingCurrency: 'USD',
  meta: {
    id: 'groq',
    name: 'Groq',
    vendor: 'Groq',
    category: 'ai',
    color: '#f55036',
    description: 'Groq Cloud billing (plan + invoices), token usage, API keys, and org members.',
    homepage: 'https://groq.com',
    dashboardUrl: 'https://console.groq.com'
  },
  session: {
    loginUrl: 'https://console.groq.com/settings/billing',
    dashboardMarkers: ['/settings/billing', '/settings/', '/dashboard'],
    cookieDomains: ['groq.com'],
    requiredCookie: 'stytch_session',
    // The Stytch session pair is durable client-side but dies server-side on logout/expiry; the dead
    // `stytch_session` still loads the console SPA, so on reconnect it satisfies `requiredCookie` and
    // auto-capture re-grabs the dead session before you can sign in again (every mint then 401s). Drop
    // both before capture so a reconnect bounces through a real Stytch login and lands a fresh pair.
    clearCookiesBeforeCapture: ['stytch_session', 'stytch_session_jwt'],
    // No org-list endpoint and no org id in the URL — the console SPA sends `Groq-Organization: org_…` on
    // its own /platform/v1 requests, so capture it off the wire during sign-in to prefill the config field.
    captureFromHeader: [{ header: 'Groq-Organization', storeAs: 'orgId', on: 'request' }]
  },
  auth: { kind: 'minted-jwt', resolve: resolveGroqJwt },
  // node client injects the browser UA + sec-ch-ua centrally; we add the cross-subdomain (console → api)
  // same-site XHR markers the dashboard sends.
  transport: {
    defaultHeaders: {
      Accept: '*/*',
      Referer: 'https://console.groq.com/',
      'Sec-Fetch-Site': 'same-site',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty'
    }
  },
  config: groqConfigSchema,
  capabilities: [
    defineCapability({
      id: 'summary',
      label: 'Summary',
      fetch: loadGroqBilling,
      build: (raw) => buildGroqSummaryResult(raw.invoices, raw.current, extractGroqPlan(raw.profile, raw.orgId)),
      sample: sampleGroqBilling
    }),
    defineCapability({
      id: 'billing',
      label: 'Billing',
      fetch: loadGroqBilling,
      build: (raw) =>
        buildGroqBillingResult(raw.invoices, raw.current, raw.info, extractGroqPlan(raw.profile, raw.orgId)),
      sample: sampleGroqBilling
    }),
    defineCapability({
      id: 'usage',
      label: 'Usage',
      fetch: fetchGroqUsage,
      build: (raw) => buildGroqUsageResult(buildGroqUsage(raw.activity, raw.current)),
      sample: sampleGroqActivity
    }),
    defineCapability({
      id: 'apiKeys',
      label: 'API Keys',
      fetch: fetchGroqKeys,
      build: (raw) => keys.result(buildGroqKeys(raw)),
      sample: sampleGroqKeys
    }),
    defineCapability({
      id: 'members',
      label: 'Members',
      fetch: fetchGroqMembers,
      build: (raw) => members.result(buildGroqMembers(raw)),
      sample: sampleGroqUsers
    })
  ],
  probe: async (ctx) => {
    // Confirm the minted Bearer + pinned org actually reach the platform API (cheap org-scoped GET).
    await orgGet(ctx, resolveOrgId(ctx), '/usage/current')
  }
})
