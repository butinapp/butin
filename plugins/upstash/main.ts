import {
  defineCapability,
  defineConfigSchema,
  definePlugin,
  type AuthAttachment,
  type AuthContext,
  type CollectContext,
  type ConfigOf,
  type ConfigOption
} from '@butinapp/sdk'
import { capabilityResult, record, table, type CapabilityResult } from '@butinapp/sdk/data'
import { billing, keys, members, type ApiKeysInput, type BillingInput, type MembersInput } from '@butinapp/sdk/presets'
import { currentMonthKey, isoDay, monthKey } from '@butinapp/sdk/util'

import { sampleUpstashBilling, sampleUpstashKeys, sampleUpstashMembers } from './sample.js'

// Upstash uses the minted-jwt pattern (Clerk) over Node. The console's un-versioned endpoints (`/user`,
// `/invoices`, `/billingdetails/<YYYYMM>`, `/listkeys`) on api.upstash.com REJECT the Developer API key
// (403, "Api key cannot be used to access this endpoint") — they only accept the console's Clerk JWT. So the
// durable credential is the captured Clerk session cookie (`__client` from console.upstash.com), and per fetch
// resolve() mints a fresh console JWT off it: GET clerk `/v1/client` → active session id → POST
// `/sessions/<id>/tokens/console-jwt-template` → JWT, then api.upstash.com is called with `Authorization:
// Bearer <jwt>`. The Clerk FAPI calls are cross-origin (console → clerk) and need an Origin header (forbidden
// on Electron net.request), so this runs on Node axios.
//
// Team scoping rides the `team-id` HEADER (not a query param): without it the endpoints return the logged-in
// user's PERSONAL account (all zeros for a member of a paid team); with it, the team's data. So a member of a
// paid team must pin `teamId` in Settings.
//
// MONEY IS IN DOLLARS — `cost` (invoices) and `billing` (per-product) are USD floats, no normalization. Fields
// are read defensively: a free-tier account zeroes the magnitudes and returns an empty `/listkeys`.

const UPSTASH_API = 'https://api.upstash.com'
const UPSTASH_CONSOLE = 'https://console.upstash.com'
const UPSTASH_CLERK = 'https://clerk.upstash.com'
// Clerk FAPI version pins the console SPA sends; not secrets. Bump if Clerk's FAPI starts rejecting them.
const CLERK_QS = '__clerk_api_version=2025-11-10&_clerk_js_version=5.125.12'

// ── types (the data dictionary): Raw* wire shapes + normalized domain types ──────────────────────────

interface RawClerkClient {
  response?: { last_active_session_id?: string | null; sessions?: { id?: string }[] }
}

interface RawClerkToken {
  jwt?: string
}

export interface RawUser {
  customer_id?: string
  state?: string
  wallet?: number
  register_date?: string
}

export interface RawInvoice {
  date?: string // 'YYYYMM'
  cost?: number // USD dollars
  status?: string
}

interface RawInvoicesResponse {
  invoices?: RawInvoice[]
}

// Per-product usage block. Fields vary by product; `billing` is the cost (USD dollars).
export interface RawProductUsage {
  billing?: number
  request?: number
  storage?: number
  bandwidth?: number
}

export interface RawBillingDetails {
  redis?: RawProductUsage
  qStash?: RawProductUsage
  vector?: RawProductUsage
  search?: RawProductUsage
}

export interface UpstashBillingData {
  user: RawUser
  invoices: RawInvoice[]
  details: RawBillingDetails
  currentYm: string
}

// The Developer API key shape: every field is optional and read defensively. `/listkeys` returns no full
// secret to mask — only an already-truncated fragment (if any) — so there is nothing sensitive to strip here.
export interface RawApiKey {
  key_id?: string
  name?: string
  api_key?: string // already masked/truncated fragment, if present
  created_at?: string
}

// A team-membership row from the console `/v2/teams` endpoint (reached with the Clerk JWT, not the Developer
// key). One row per (team, member): the team id/name repeat across a team's members, and
// `member_email`/`member_role` identify the person. Read defensively.
export interface RawTeamMember {
  team_id?: string
  team_name?: string
  member_email?: string
  member_role?: string // 'owner' | 'admin' | 'dev'
  copy_cc?: boolean
}

// ── auth: mint a fresh console JWT from the durable Clerk session cookie ──────────────────────────────

// resolve(): cookie-auth the Clerk FAPI to discover the active session, then mint a short-lived console
// JWT and return it as the Bearer. Cross-origin (console → clerk) so it carries the console Origin/Referer
// the Clerk preflight expects — which is why this is Node axios, not net.request. The `team-id` scoping
// header is added per-request in collect() (it's not part of auth), since it varies by endpoint context.
export const resolveUpstashJwt = async ({ client, creds }: AuthContext): Promise<AuthAttachment> => {
  const cookie = creds.get('cookie') ?? ''

  if (!cookie) {
    throw new Error('[upstash] Missing console session — re-run Magic Login for Upstash.')
  }

  const clerkHeaders = { Cookie: cookie, Origin: UPSTASH_CONSOLE, Referer: `${UPSTASH_CONSOLE}/` }
  const clientResp = await client.get<RawClerkClient>(`${UPSTASH_CLERK}/v1/client?${CLERK_QS}`, clerkHeaders)
  const sessionId = clientResp?.response?.last_active_session_id ?? clientResp?.response?.sessions?.[0]?.id

  if (!sessionId) {
    throw new Error('[upstash] No active Clerk session — re-run Magic Login for Upstash.')
  }

  const tokenResp = await client.post<RawClerkToken>(
    `${UPSTASH_CLERK}/v1/client/sessions/${sessionId}/tokens/console-jwt-template?${CLERK_QS}`,
    null,
    clerkHeaders
  )

  if (!tokenResp?.jwt) {
    throw new Error('[upstash] Clerk did not return a console JWT.')
  }

  return { headers: { Authorization: `Bearer ${tokenResp.jwt}`, Origin: UPSTASH_CONSOLE } }
}

// ── shared fetch helpers ──────────────────────────────────────────────────────────────────────────────

// Scope account-scoped endpoints to a team via the `team-id` header when teamId is pinned in Settings.
const teamHeaders = (ctx: CollectContext<UpstashConfig>): Record<string, string> => {
  const teamId = ctx.config.teamId?.trim()

  return teamId ? { 'team-id': teamId } : {}
}

const apiGet = <T>(ctx: CollectContext<UpstashConfig>, path: string) =>
  ctx.client.get<T>(`${UPSTASH_API}${path}`, teamHeaders(ctx))

// Current month as 'YYYYMM' (the key /billingdetails is fetched for), UTC.
const currentYm = (now = new Date()): string => currentMonthKey(now).replace('-', '')

// ── billing: account state + monthly invoice history + the current month's per-product breakdown ───────

const PRODUCTS: { key: keyof RawBillingDetails; label: string }[] = [
  { key: 'redis', label: 'Redis' },
  { key: 'qStash', label: 'QStash' },
  { key: 'vector', label: 'Vector' },
  { key: 'search', label: 'Search' }
]

export interface ProductUsage {
  product: string
  billing: number
  request: number
  storage: number
  bandwidth: number
}

// 'YYYYMM' → 'YYYY-MM' (or '' when unparseable). The invoice month is the natural key Upstash returns.
const dashYm = (ym?: string): string =>
  ym && /^\d{6}$/.test(ym) ? monthKey(Number(ym.slice(0, 4)), Number(ym.slice(4, 6))) : ''

// Pure transform — fixture-tested. Invoice history (YYYYMM → first-of-month day for the monthly axis) +
// the current month's metered spend as the live MTD (sum of per-product `billing`). Invoices sort newest
// first; the monthly-spend chart is derived from them downstream by the billing preset.
export const buildUpstashBilling = (data: UpstashBillingData): BillingInput => {
  const invoices = data.invoices
    .map((inv) => {
      const month = dashYm(inv.date)

      return {
        date: month ? `${month}-01` : undefined,
        amount: inv.cost ?? 0,
        status: inv.status ?? 'unknown'
      }
    })
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))

  const currentMtd = PRODUCTS.reduce((sum, { key }) => sum + (data.details[key]?.billing ?? 0), 0)

  return { currentMtd, invoices }
}

// Pure transform — fixture-tested. Per-product current-month usage; products always listed (zeros included)
// so the table renders a stable shape on a fresh/free account.
export const buildUpstashProducts = (details: RawBillingDetails): ProductUsage[] =>
  PRODUCTS.map(({ key, label }) => {
    const u = details[key] ?? {}

    return {
      product: label,
      billing: u.billing ?? 0,
      request: u.request ?? 0,
      storage: u.storage ?? 0,
      bandwidth: u.bandwidth ?? 0
    }
  })

// ── Summary tab (its spend.mtd summary is what the cross-service Overview rolls up) ──────
// The shared preset (account stat + monthly-spend chart + spend.mtd summary), plus account state + wallet
// stats folded into the headline record.
export const buildUpstashSummaryResult = (data: UpstashBillingData): CapabilityResult => {
  const billingData = buildUpstashBilling(data)

  return billing.summary({
    currentMtd: billingData.currentMtd,
    // Per-product metered spend accruing live over the open period.
    mtdBasis: 'accrued',
    currency: billingData.currency,
    invoices: billingData.invoices,
    stats: [
      { key: 'state', label: 'State', role: 'label', value: data.user.state ?? 'unknown' },
      { key: 'wallet', label: 'Wallet', role: 'money', value: data.user.wallet ?? 0 },
      { key: 'invoiceCount', label: 'Invoices', role: 'count', value: billingData.invoices.length }
    ]
  })
}

// ── Billing tab (generic renderer, NOT the Overview rollup) ──────────────────────────────────────────────
// The current month's per-product breakdown table + the invoice history table + an account keyvalue. The
// headline (MTD / monthly chart) lives on Summary.

interface UpstashInvoiceRow {
  date: string | null
  amount: number
  status: string
}

interface UpstashAccountRow {
  customerId: string | null
  state: string | null
  wallet: number | null
  registered: string | null
}

export const buildUpstashBillingResult = (data: UpstashBillingData): CapabilityResult => {
  const billing = buildUpstashBilling(data)
  const products = buildUpstashProducts(data.details)
  const ymLabel = dashYm(data.currentYm) || data.currentYm

  const productsTable = table<ProductUsage>({
    id: 'products',
    columns: [
      { key: 'product', label: 'Product', role: 'label' },
      { key: 'billing', label: 'Cost', role: 'money' },
      { key: 'request', label: 'Requests', role: 'count' },
      { key: 'storage', label: 'Storage', role: 'count' },
      { key: 'bandwidth', label: 'Bandwidth', role: 'count' }
    ],
    rows: products
  })

  const invoicesTable = table<UpstashInvoiceRow>({
    id: 'invoices',
    columns: [
      { key: 'date', label: 'Month', role: 'timestamp' },
      { key: 'amount', label: 'Amount', role: 'money' },
      { key: 'status', label: 'Status', role: 'status' }
    ],
    rows: billing.invoices.map((i) => ({ date: i.date ?? null, amount: i.amount, status: i.status }))
  })

  const accountValue: UpstashAccountRow = {
    customerId: data.user.customer_id || null,
    state: data.user.state || null,
    wallet: data.user.wallet ?? null,
    registered: isoDay(data.user.register_date) ?? null
  }

  const accountRecord = Object.values(accountValue).some((v) => v !== null)
    ? record<UpstashAccountRow>({
        id: 'account',
        fields: [
          { key: 'customerId', label: 'Account', role: 'identifier' },
          { key: 'state', label: 'State', role: 'label' },
          { key: 'wallet', label: 'Wallet', role: 'money' },
          { key: 'registered', label: 'Registered', role: 'timestamp' }
        ],
        value: accountValue
      })
    : null

  return capabilityResult({
    sections: [
      productsTable.table({ title: `Usage — ${ymLabel}` }),
      invoicesTable.table({ title: 'Invoices' }),
      accountRecord?.keyvalue({ title: 'Account' })
    ]
  })
}

// Summary + Billing both need /user + /invoices + the current month's /billingdetails; both collects call
// this. The core query cache dedupes the underlying reads across the two runs. user + details are
// best-effort (a free/personal account 403s or zeroes them) — a miss must not blank the whole tab.
const loadUpstashBilling = async (ctx: CollectContext<UpstashConfig>): Promise<UpstashBillingData> => {
  const ym = currentYm()
  const [user, invoicesRes, details] = await Promise.all([
    apiGet<RawUser>(ctx, '/user').catch(() => ({}) as RawUser),
    apiGet<RawInvoicesResponse>(ctx, '/invoices'),
    apiGet<RawBillingDetails>(ctx, `/billingdetails/${ym}`).catch(() => ({}) as RawBillingDetails)
  ])

  return { user: user ?? {}, invoices: invoicesRes?.invoices ?? [], details: details ?? {}, currentYm: ym }
}

// ── apiKeys: Developer API key inventory (`/listkeys`) — audit only, secrets MASKED ─────────────────────

// `/listkeys` never returns a full secret — only an already-truncated fragment (if any). maskFragment is a
// defensive belt-and-braces: any value longer than a hint is reduced to a `…last4` tail before it leaves
// here, so even an unexpectedly-full value can't surface. Short/empty fragments degrade to '—'.
export const maskFragment = (fragment?: string): string => {
  if (!fragment) {
    return '—'
  }

  return fragment.length > 8 ? `…${fragment.slice(-4)}` : fragment
}

// Pure transform — fixture-tested. Reads every field defensively, with fallbacks so an unexpected shape
// degrades rather than throws. Keys carry no revoked flag.
export const buildUpstashKeys = (raw: RawApiKey[] | undefined | null): ApiKeysInput => ({
  keys: (Array.isArray(raw) ? raw : []).map((k, i) => ({
    id: k.key_id ?? k.name ?? String(i),
    name: k.name || '(unnamed)',
    masked: maskFragment(k.api_key),
    createdAt: isoDay(k.created_at),
    revoked: false
  }))
})

// ── members + team picker: the roster (`/v2/teams`) — reachable with the console Clerk JWT, NOT the Dev key ─

// `/v2/teams` returns every (team, member) row across all teams the session belongs to (unscoped — the
// team-id header doesn't filter it), so it doubles as the source for the Settings team picker.
const fetchTeams = (ctx: CollectContext) => ctx.client.get<RawTeamMember[]>(`${UPSTASH_API}/v2/teams`)

// Distinct teams the session belongs to → the Settings combobox options (value = team id, label = team name,
// role as subtext). Deduped because the rows are per-membership. Fixture-tested.
export const buildTeamOptions = (raw: RawTeamMember[] | undefined | null): ConfigOption[] => {
  const seen = new Set<string>()

  return (Array.isArray(raw) ? raw : []).flatMap((r) =>
    r.team_id && !seen.has(r.team_id)
      ? (seen.add(r.team_id),
        [{ value: r.team_id, label: r.team_name?.trim() || r.team_id, description: r.member_role }])
      : []
  )
}

// Pure transform — fixture-tested. Keep only the pinned team's rows (the same `team-id` scope the billing
// endpoints use) and map each to a portable member. Email is the only identifier the row carries, so it
// doubles as the id. Reads every field defensively.
export const buildUpstashMembers = (raw: RawTeamMember[] | undefined | null, teamId: string): MembersInput => ({
  members: (Array.isArray(raw) ? raw : [])
    .filter((m) => m.team_id === teamId && !!m.member_email)
    .map((m) => ({
      id: m.member_email as string,
      email: m.member_email,
      name: undefined, // the roster row carries no display name — email is the identifier
      role: m.member_role
    }))
})

// The roster's pure build needs the pinned teamId (which `build` can't read off ctx), so the fetch folds the
// scoped team rows + the teamId into one bundle. The "pick a team" guard lives in fetch (the live network path).
export interface UpstashMembersData {
  rows: RawTeamMember[]
  teamId: string
}

const fetchUpstashMembers = async (ctx: CollectContext<UpstashConfig>): Promise<UpstashMembersData> => {
  const teamId = ctx.config.teamId?.trim()

  if (!teamId) {
    throw new Error('Pick a Team in Settings to read the team roster — Upstash members live under a team.')
  }

  return { rows: (await fetchTeams(ctx)) ?? [], teamId }
}

export const buildUpstashMembersResult = (data: UpstashMembersData): CapabilityResult =>
  members.result(buildUpstashMembers(data.rows, data.teamId))

// ── descriptor ──────────────────────────────────────────────────────────────────────────────────────
export const upstashConfigSchema = defineConfigSchema([
  {
    key: 'teamId',
    label: 'Team',
    kind: 'combobox',
    placeholder: 'Personal account',
    help: 'Pick a team to read its billing/usage/roster. Leave unset for your personal account — a member of a paid team sees zeros without this.',
    loadOptions: async (ctx) => buildTeamOptions(await fetchTeams(ctx))
  }
])

export type UpstashConfig = ConfigOf<typeof upstashConfigSchema>

export const upstashPlugin = definePlugin({
  reportingCurrency: 'USD',
  meta: {
    id: 'upstash',
    name: 'Upstash',
    vendor: 'Upstash',
    category: 'devtools',
    color: '#00e9a3',
    description:
      'Upstash console billing (account state, invoices, per-product usage), Developer API keys, and the team roster.',
    homepage: 'https://upstash.com',
    dashboardUrl: 'https://console.upstash.com'
  },
  // Magic Login captures the Clerk session cookie (`__client`) off console.upstash.com. Clerk sets `__client`
  // on the console host BEFORE sign-in (it tracks the anonymous client too), so the marker is the only gate
  // against a premature capture. The markers are HOST-ANCHORED for that reason: a bare `/account` substring-
  // matches `accounts.google.com`, so during Google sign-in readiness would go true on the account-picker and
  // capture the logged-out session. Anchoring to console.upstash.com confines the match to the authed console.
  session: {
    loginUrl: 'https://console.upstash.com',
    dashboardMarkers: [
      'console.upstash.com/redis',
      'console.upstash.com/qstash',
      'console.upstash.com/vector',
      'console.upstash.com/account',
      'console.upstash.com/teams'
    ],
    cookieDomains: ['upstash.com', 'clerk.upstash.com'],
    requiredCookie: '__client'
  },
  // minted-jwt: the durable Clerk session cookie is exchanged for a short-lived console JWT per fetch.
  auth: { kind: 'minted-jwt', resolve: resolveUpstashJwt },
  // node client injects the browser UA + sec-ch-ua centrally; we add the cross-origin (console → clerk/api)
  // same-origin XHR markers the console sends. The Clerk Origin header forbidden on net.request keeps this
  // on node transport.
  transport: {
    defaultHeaders: {
      Accept: '*/*',
      Referer: 'https://console.upstash.com/',
      'Sec-Fetch-Site': 'same-site',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty'
    }
  },
  config: upstashConfigSchema,
  capabilities: [
    defineCapability({
      id: 'summary',
      label: 'Summary',
      fetch: loadUpstashBilling,
      build: buildUpstashSummaryResult,
      sample: sampleUpstashBilling
    }),
    defineCapability({
      id: 'billing',
      label: 'Billing',
      fetch: loadUpstashBilling,
      build: buildUpstashBillingResult,
      sample: sampleUpstashBilling
    }),
    defineCapability({
      id: 'apiKeys',
      label: 'API Keys',
      fetch: (ctx) => apiGet<RawApiKey[]>(ctx, '/listkeys'),
      build: (raw) => keys.result(buildUpstashKeys(raw)),
      sample: sampleUpstashKeys
    }),
    defineCapability({
      id: 'members',
      label: 'Members',
      fetch: fetchUpstashMembers,
      build: buildUpstashMembersResult,
      sample: sampleUpstashMembers
    })
  ],
  probe: async (ctx) => {
    // /invoices is a cheap account-scoped GET — a 200 proves the minted Bearer reaches the console API.
    await apiGet(ctx, '/invoices')
  }
})
