import { defineCapability, defineConfigSchema, definePlugin, type CollectContext, type ConfigOf } from '@butinapp/sdk'
import { capabilityResult, record, table, type CapabilityResult } from '@butinapp/sdk/data'
import {
  billing,
  keys,
  members,
  type ApiKeysInput,
  type BillingStat,
  type BillingSummaryInput,
  type MemberInput,
  type MembersInput
} from '@butinapp/sdk/presets'
import { isoDay, parseDollarAmount, round2, utcDaysAgo } from '@butinapp/sdk/util'

import { sampleUnleashBilling, sampleUnleashRoster, sampleUnleashTokens } from './sample.js'

// Unleash (hosted dashboard, us.app.unleash-hosted.com). The control-plane billing/keys endpoints under
// /api/admin/* are gated to an authenticated admin USER session — the SSO dashboard cookies
// (`unleash-session` + `unleash-auth`), NOT the data-plane admin API token. So auth is cookie replay.
// unleash-hosted.com serves from AWS (not Cloudflare), so Node axios works — the edge accepts a plain client,
// no Electron transport.
const BASE = 'https://us.app.unleash-hosted.com'

// Every hosted-dashboard control-plane path is scoped under the instance slug — the first path segment
// after the host (e.g. the `acme` in us.app.unleash-hosted.com/acme/projects). Magic Login captures it off
// the settled URL into a credential; a Settings field overrides it. Without it every /api/admin call 404s —
// the endpoints don't exist at the bare origin.
const resolveInstance = (ctx: CollectContext<UnleashConfig>): string => {
  const slug = (ctx.config.instance?.trim() || ctx.creds.get('instance') || '').replace(/^\/+|\/+$/g, '')

  if (!slug) {
    throw new Error('Unleash instance not set — reconnect with Magic Login, or set the instance slug in Settings.')
  }

  return slug
}

// The dashboard API root for this instance: `<origin>/<slug>`.
const apiBase = (ctx: CollectContext<UnleashConfig>): string => `${BASE}/${resolveInstance(ctx)}`

// ── types (the data dictionary) ─────────────────────────────────────────────────────

// billing — invoices carry NO raw numeric amount, only a pre-formatted string ("US $464.00").
export interface RawUnleashInvoice {
  amountFormatted?: string
  paid?: boolean
  created?: string // ISO timestamp
  status?: string
  invoiceURL?: string
  invoicePDF?: string
}
export interface RawUnleashInvoicesResponse {
  invoices?: RawUnleashInvoice[]
}
// Plain dollar unit-rates (already numeric): base monthly, per-seat, per-million-requests.
export interface RawUnleashPrices {
  pro?: { base?: number; seat?: number; traffic?: number }
  payg?: { seat?: number; traffic?: number }
}
export interface RawUnleashStatus {
  plan?: string
  billing?: string
  seats?: number // purchased/active seats
  minSeats?: number // seats included in the base fee (the rest are per-seat)
  state?: string
  automaticallyPayForTraffic?: boolean
  emailDomain?: string
}
export interface RawUnleashAdminStats {
  users?: number
  licensedUsers?: number
  activeUsers?: { last7?: number; last30?: number; last60?: number; last90?: number }
}

// The raw bundle the Summary + Billing tabs both fetch (the four billing endpoints, the latter three
// best-effort). `buildUnleashBilling` is the pure transform off this; the two tabs' `build` differ only in
// which result they shape from it.
export interface UnleashBillingRaw {
  invoices: RawUnleashInvoicesResponse | null
  prices: RawUnleashPrices | null
  status: RawUnleashStatus | null
  stats: RawUnleashAdminStats | null
}

export interface UnleashInvoice {
  date?: string // 'YYYY-MM-DD'
  amount: number // parsed USD dollars
  amountFormatted: string // original string, e.g. "US $464.00"
  status: string
  paid: boolean
  hostedUrl?: string
  pdfUrl?: string
}

export interface UnleashSubscription {
  plan: string
  billingMode: string
  state: string
  seats: number | null
  minSeats: number | null
  licensedUsers: number | null
  activeUsers30d: number | null
  automaticallyPayForTraffic: boolean
  // Computed recurring monthly fee (USD): base + max(0, seats − minSeats) × per-seat rate. null when prices
  // or seat count are unavailable (so we never invent a figure).
  recurringFee: number | null
}

export interface UnleashBilling {
  invoices: UnleashInvoice[]
  totalBilled: number
  // The recurring subscription fee accruing in the open period (USD). null when unpriceable.
  currentMtd: number | null
  subscription: UnleashSubscription | null
}

// keys — secret looks like "<projects>:<environment>.<hash>"; we mask the hash, never returning the raw value.
export interface RawUnleashToken {
  secret?: string
  tokenName?: string
  type?: string // 'client' | 'frontend' | 'admin' …
  project?: string
  projects?: string[]
  environment?: string
  expiresAt?: string | null
  createdAt?: string
  alias?: string | null
  seenAt?: string | null
}
export interface RawUnleashTokensResponse {
  tokens?: RawUnleashToken[]
}

// ── billing ─────────────────────────────────────────────────────────────────────────

// Unleash's amounts arrive pre-formatted ("US $464.00", "US $3,232.00") → read the dollar value out.
export { parseDollarAmount }

// Recurring monthly subscription fee (USD): base + the per-seat rate applied to seats beyond the minSeats
// included in the base. null when the Pro prices or seat count aren't available (never guess a figure).
export const computeRecurringFee = (
  prices: RawUnleashPrices | null | undefined,
  status: RawUnleashStatus | null | undefined
): number | null => {
  const base = prices?.pro?.base
  const seatRate = prices?.pro?.seat
  const seats = status?.seats

  if (typeof base !== 'number' || typeof seatRate !== 'number' || typeof seats !== 'number') {
    return null
  }

  const minSeats = typeof status?.minSeats === 'number' ? status.minSeats : 0
  const billableSeats = Math.max(0, seats - minSeats)

  return base + billableSeats * seatRate
}

// Pure transform — fixture-tested. Unleash Pro bills monthly in arrears = a recurring fee (base + per-seat
// over minSeats) PLUS metered traffic overage. The recurring fee is the firm running figure accruing in the
// open period (it reconciles with the invoice floor), so it's the currentMtd. Traffic overage can't be
// priced without the included-request threshold (not exposed), so MTD is the live floor, not the full bill.
export const buildUnleashBilling = (
  raw: RawUnleashInvoicesResponse | null | undefined,
  prices: RawUnleashPrices | null = null,
  status: RawUnleashStatus | null = null,
  stats: RawUnleashAdminStats | null = null
): UnleashBilling => {
  const invoices = (raw?.invoices ?? [])
    .map(
      (inv): UnleashInvoice => ({
        date: isoDay(inv.created),
        amount: parseDollarAmount(inv.amountFormatted),
        amountFormatted: inv.amountFormatted ?? '—',
        status: inv.status ?? 'unknown',
        paid: !!inv.paid,
        hostedUrl: inv.invoiceURL || undefined,
        pdfUrl: inv.invoicePDF || undefined
      })
    )
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))

  const recurringFee = computeRecurringFee(prices, status)

  const subscription: UnleashSubscription | null = status
    ? {
        plan: status.plan ?? 'unknown',
        billingMode: status.billing ?? 'unknown',
        state: status.state ?? 'unknown',
        seats: typeof status.seats === 'number' ? status.seats : null,
        minSeats: typeof status.minSeats === 'number' ? status.minSeats : null,
        licensedUsers: typeof stats?.licensedUsers === 'number' ? stats.licensedUsers : null,
        activeUsers30d: typeof stats?.activeUsers?.last30 === 'number' ? stats.activeUsers.last30 : null,
        automaticallyPayForTraffic: !!status.automaticallyPayForTraffic,
        recurringFee
      }
    : null

  return {
    invoices,
    totalBilled: round2(invoices.reduce((sum, i) => sum + i.amount, 0)),
    currentMtd: recurringFee,
    subscription
  }
}

// Summary tab — the overview the cross-service Overview rolls up (spend.mtd): the recurring-fee headline, the
// monthly-spend trend chart, and a tight row of subscription headline stats (state/seats/licensed/active). The
// plan, per-seat rates, and the invoice list are the Billing tab's detail — not here.
export const buildUnleashSummaryResult = (billingData: UnleashBilling): CapabilityResult => {
  const sub = billingData.subscription
  const stats: BillingStat[] = []

  if (sub) {
    if (sub.state !== 'unknown') {
      stats.push({ key: 'state', label: 'State', role: 'label', value: sub.state })
    }

    if (sub.seats != null) {
      stats.push({ key: 'seats', label: 'Seats', role: 'count', value: sub.seats })
    }

    if (sub.licensedUsers != null) {
      stats.push({ key: 'licensedUsers', label: 'Licensed users', role: 'count', value: sub.licensedUsers })
    }

    if (sub.activeUsers30d != null) {
      stats.push({ key: 'activeUsers30d', label: 'Active users (30d)', role: 'count', value: sub.activeUsers30d })
    }
  }

  const input: BillingSummaryInput = {
    currentMtd: billingData.currentMtd,
    currentMtdLabel: 'Recurring fee',
    // The recurring subscription fee is a fixed monthly floor (traffic overage isn't separable here), so it IS
    // the baseFee and the basis is 'flat'.
    baseFee: billingData.currentMtd,
    mtdBasis: 'flat',
    plan: sub?.plan,
    invoices: billingData.invoices.map((i) => ({
      date: i.date,
      amount: i.amount,
      status: i.status,
      hostedUrl: i.hostedUrl ?? null,
      pdfUrl: i.pdfUrl ?? null
    })),
    stats
  }

  return billing.summary(input)
}

// Billing tab — the financial detail (the headline + chart + rollup live on Summary): the subscription account
// record (plan, billing mode, seats vs included minimum, state, recurring fee, per-seat & per-traffic rates) and
// the downloadable invoice history. Sections with no rows are dropped.

interface UnleashSubscriptionRow {
  plan: string
  billingMode: string
  state: string
  seats: number | null
  minSeats: number | null
  recurringFee: number | null
  autoPayTraffic: string
}

interface UnleashInvoiceRow {
  date: string | null
  amount: number
  status: string
  url: string | null
  // Hidden — the PDF byte source for the download (a fileTable's `source.url`); falls back to the hosted URL.
  pdfUrl: string | null
  // Hidden — carried for the download filename.
  name: string
}

export const buildUnleashBillingTab = (billing: UnleashBilling): CapabilityResult => {
  const sub = billing.subscription

  const account = sub
    ? record<UnleashSubscriptionRow>({
        id: 'subscription',
        fields: [
          { key: 'plan', label: 'Plan', role: 'label' },
          { key: 'billingMode', label: 'Billing mode', role: 'label' },
          { key: 'state', label: 'State', role: 'label' },
          { key: 'seats', label: 'Seats', role: 'count' },
          { key: 'minSeats', label: 'Included seats', role: 'count' },
          { key: 'recurringFee', label: 'Recurring fee', role: 'money' },
          { key: 'autoPayTraffic', label: 'Auto-pay traffic overage', role: 'label' }
        ],
        value: {
          plan: sub.plan,
          billingMode: sub.billingMode,
          state: sub.state,
          seats: sub.seats,
          minSeats: sub.minSeats,
          recurringFee: sub.recurringFee,
          autoPayTraffic: sub.automaticallyPayForTraffic ? 'Yes' : 'No'
        }
      })
    : null

  // A downloadable PDF turns the invoice list into a fileTable (the PDF is the byte source); without one it's a
  // plain table whose hosted-URL column is the only link out.
  const hasPdf = billing.invoices.some((i) => !!i.pdfUrl)

  const invoices = table<UnleashInvoiceRow>({
    id: 'invoices',
    columns: [
      { key: 'date', label: 'Date', role: 'timestamp' },
      { key: 'amount', label: 'Amount', role: 'money' },
      { key: 'status', label: 'Status', role: 'status' },
      { key: 'url', label: 'Invoice', role: 'url' },
      { key: 'pdfUrl', role: 'url', hidden: true },
      { key: 'name', role: 'label', hidden: true }
    ],
    rows: billing.invoices.map((i) => ({
      date: i.date ?? null,
      amount: i.amount,
      status: i.status,
      url: i.hostedUrl ?? i.pdfUrl ?? null,
      pdfUrl: i.pdfUrl ?? i.hostedUrl ?? null,
      name: `Invoice ${i.date ?? 'unknown'}`
    }))
  })

  return capabilityResult({
    sections: [
      account ? account.keyvalue({ title: 'Subscription' }) : null,
      billing.invoices.length > 0
        ? hasPdf
          ? invoices.fileTable({
              title: 'Invoices',
              name: 'name',
              source: { url: 'pdfUrl' },
              ext: 'pdf',
              category: 'Invoices'
            })
          : invoices.table({ title: 'Invoices' })
        : null
    ]
  })
}

// Summary + Billing share the same four billing endpoints. Both fetch via loadUnleashBilling; the core query
// cache dedupes the underlying reads. Only /api/admin/invoices is required — the other three are best-effort
// context for the recurring fee / subscription record, so a failure on any of them degrades that detail rather
// than sinking the view.
const loadUnleashBilling = async (ctx: CollectContext<UnleashConfig>): Promise<UnleashBillingRaw> => {
  const base = apiBase(ctx)
  const [invoices, prices, status, stats] = await Promise.all([
    ctx.client.get<RawUnleashInvoicesResponse>(`${base}/api/admin/invoices`),
    ctx.client.get<RawUnleashPrices>(`${base}/api/instance/prices`).catch(() => null),
    ctx.client.get<RawUnleashStatus>(`${base}/api/instance/status`).catch(() => null),
    ctx.client.get<RawUnleashAdminStats>(`${base}/api/admin/instance/admin/statistics`).catch(() => null)
  ])

  return { invoices, prices, status, stats }
}

// Both tabs normalize the same raw bundle, then shape their own result off it.
const billingFrom = (raw: UnleashBillingRaw): UnleashBilling =>
  buildUnleashBilling(raw.invoices, raw.prices, raw.status, raw.stats)

// ── apiKeys ─────────────────────────────────────────────────────────────────────────

// Mask an Unleash token secret. Keeps the non-sensitive "<projects>:<env>." prefix + the last 4 chars of the
// hash, masking the middle: "cdm:development.a34f1e93…5f2e" → "cdm:development.****5f2e".
export const maskSecret = (secret?: string): string => {
  if (!secret) {
    return '—'
  }

  const dot = secret.indexOf('.')

  if (dot === -1) {
    return secret.length > 4 ? `****${secret.slice(-4)}` : '****'
  }

  return `${secret.slice(0, dot + 1)}****${secret.slice(dot + 1).slice(-4)}`
}

// Pure transform — fixture-tested. The api-token inventory; the type is carried as the key's name suffix so
// the generic table shows client/frontend/admin scoping without a custom column.
export const buildUnleashKeys = (raw: RawUnleashTokensResponse | null | undefined): ApiKeysInput => ({
  keys: (raw?.tokens ?? []).map((t, i) => {
    const projects = t.projects ?? (t.project ? [t.project] : [])
    const scope = [projects.join(',') || '*', t.environment].filter(Boolean).join('/')

    return {
      id: t.tokenName ?? t.alias ?? String(i),
      name: `${t.tokenName ?? t.alias ?? '(unnamed)'} · ${t.type ?? 'unknown'} (${scope})`,
      masked: maskSecret(t.secret),
      createdAt: t.createdAt ?? undefined,
      lastUsedAt: t.seenAt ?? undefined,
      // Unleash tokens don't revoke in place (they're deleted); an expired token is the closest "inactive".
      revoked: !!(t.expiresAt && t.expiresAt.slice(0, 10) < utcDaysAgo(0))
    }
  })
})

const fetchUnleashKeys = (ctx: CollectContext<UnleashConfig>): Promise<RawUnleashTokensResponse> =>
  ctx.client.get<RawUnleashTokensResponse>(`${apiBase(ctx)}/api/admin/api-tokens`)

// ── members ───────────────────────────────────────────────────────────────────────────

// /api/admin/user-admin is reachable with the SAME SSO admin cookie the billing/keys endpoints already use
// (no separate data-plane token needed). It returns the instance roster under `users`. rootRole is the
// numeric root-role id (1 Admin / 2 Editor / 3 Viewer); newer builds also carry a human `rootRoleName`,
// preferred when present so we don't hardcode the id→name map.
export interface RawUnleashRosterUser {
  id?: number | string
  name?: string | null
  username?: string | null
  email?: string | null
  rootRole?: number | null
  roleId?: number | null
  rootRoleName?: string | null
}
export interface RawUnleashRosterResponse {
  users?: RawUnleashRosterUser[]
}

// Stable id→name map for Unleash's built-in root roles. Custom root roles fall back to "Role <id>" so an
// unmapped id is still legible rather than dropped.
const ROOT_ROLE_NAMES: Record<number, string> = { 1: 'Admin', 2: 'Editor', 3: 'Viewer' }

const resolveRootRole = (user: RawUnleashRosterUser): string | undefined => {
  if (user.rootRoleName) {
    return user.rootRoleName
  }

  const roleId = user.rootRole ?? user.roleId

  if (typeof roleId !== 'number') {
    return undefined
  }

  return ROOT_ROLE_NAMES[roleId] ?? `Role ${roleId}`
}

// Pure transform — fixture-tested. Map the roster to the members port: id (stringified), display name
// (falling back to username), email, and the resolved root-role label.
export const buildUnleashMembers = (raw: RawUnleashRosterResponse | null | undefined): MembersInput => ({
  members: (raw?.users ?? []).map(
    (u, i): MemberInput => ({
      id: u.id != null ? String(u.id) : String(i),
      name: u.name ?? u.username ?? undefined,
      email: u.email ?? undefined,
      role: resolveRootRole(u)
    })
  )
})

const fetchUnleashMembers = (ctx: CollectContext<UnleashConfig>): Promise<RawUnleashRosterResponse> =>
  ctx.client.get<RawUnleashRosterResponse>(`${apiBase(ctx)}/api/admin/user-admin`)

// ── descriptor ──────────────────────────────────────────────────────────────────────

export const unleashConfigSchema = defineConfigSchema([
  {
    key: 'instance',
    label: 'Instance',
    kind: 'text',
    help: 'Your Unleash instance slug — the first path segment after the host (e.g. the `acme` in us.app.unleash-hosted.com/acme/projects). Auto-detected on sign-in; set it here only to override.'
  }
])

export type UnleashConfig = ConfigOf<typeof unleashConfigSchema>

export const unleashPlugin = definePlugin({
  reportingCurrency: 'USD',
  meta: {
    id: 'unleash',
    name: 'Unleash',
    vendor: 'Unleash',
    category: 'devtools',
    color: '#1a4049',
    description: 'Unleash hosted dashboard — billing history, recurring fee + subscription, and API-token inventory.',
    homepage: 'https://www.getunleash.io',
    dashboardUrl: `${BASE}`,
    troubleshooting: {
      'config-invalid': {
        hint: 'A 404 usually means the Instance slug in Settings is wrong. It is the first path segment after the host in your dashboard URL (e.g. "acme" in us.app.unleash-hosted.com/acme/projects) — it is auto-detected on sign-in.'
      }
    }
  },
  // Two SSO cookies are captured (unleash-session + unleash-auth); the latter is the 24h SSO JWT carrying the
  // admin access claim the control-plane endpoints validate, so it's the required cookie.
  session: {
    loginUrl: `${BASE}`,
    // The authed SPA routes to `/<instance>/<section>`; these post-slug sections match for any instance,
    // while the login/SSO pages (under /auth) never do — so auto-capture fires the moment the user lands on
    // their dashboard with unleash-auth set, regardless of instance slug.
    dashboardMarkers: ['/personal', '/projects', '/admin'],
    // Both SSO cookies live on *.app.unleash-hosted.com; scoping here excludes the analytics cookies on
    // .unleash-hosted.com (reddit/clarity/hubspot) that would only bloat the request Cookie header.
    cookieDomains: ['app.unleash-hosted.com'],
    requiredCookie: 'unleash-auth',
    // Pull the instance slug out of the settled dashboard URL so the user never types it.
    captureFromUrl: [{ pattern: 'unleash-hosted\\.com/([^/]+)(?:/|$)', storeAs: 'instance' }]
  },
  auth: { kind: 'cookie' },
  // AWS-fronted JSON (the edge accepts a plain client) → plain Node axios. The dashboard XHRs the SPA makes
  // carry these same-origin fetch metadata headers; declare them per-service (the UA + client hints come from
  // the central browser identity, never hand-declared here).
  transport: {
    engine: 'node',
    baseUrl: BASE,
    defaultHeaders: {
      Accept: '*/*',
      Referer: `${BASE}/`,
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty'
    }
  },
  config: unleashConfigSchema,
  capabilities: [
    defineCapability({
      id: 'summary',
      label: 'Summary',
      fetch: loadUnleashBilling,
      build: (raw) => buildUnleashSummaryResult(billingFrom(raw)),
      sample: sampleUnleashBilling
    }),
    defineCapability({
      id: 'billing',
      label: 'Billing',
      fetch: loadUnleashBilling,
      build: (raw) => buildUnleashBillingTab(billingFrom(raw)),
      sample: sampleUnleashBilling
    }),
    defineCapability({
      id: 'apiKeys',
      label: 'API Keys',
      fetch: fetchUnleashKeys,
      build: (raw) => keys.result(buildUnleashKeys(raw)),
      sample: sampleUnleashTokens
    }),
    defineCapability({
      id: 'members',
      label: 'Members',
      fetch: fetchUnleashMembers,
      build: (raw) => members.result(buildUnleashMembers(raw)),
      sample: sampleUnleashRoster
    })
  ],
  probe: async (ctx) => {
    // A cheap authed control-plane GET — a 200 proves the SSO session reaches this instance's dashboard API.
    await ctx.client.get(`${apiBase(ctx)}/api/admin/api-tokens`)
  }
})
