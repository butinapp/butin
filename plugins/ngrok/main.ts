import { defineCapability, definePlugin, type CollectContext } from '@butinapp/sdk'
import { capabilityResult, record, table, type CapabilityResult } from '@butinapp/sdk/data'
import {
  billing,
  keys,
  members,
  type ApiKeysInput,
  type BillingInvoiceInput,
  type MemberInput,
  type MembersInput
} from '@butinapp/sdk/presets'
import { centsStringToMajor, centsToMajor, epochSecDay } from '@butinapp/sdk/util'

import {
  sampleNgrokApiKeys,
  sampleNgrokAuthtokens,
  sampleNgrokInvitations,
  sampleNgrokInvoices,
  sampleNgrokSubscription,
  sampleNgrokTeamMembers
} from './sample.js'

// ngrok: read-only views over dashboard.ngrok.com. The dashboard is backed by a Connect-RPC gateway mounted
// at /_api/rpx — every call is a POST of a JSON body to `${ORIGIN}/_api/rpx/<service>/<method>`. The gateway
// runs three checks a same-origin browser XHR satisfies automatically (each yields a descriptive 403):
//   1. Cloudflare browser check  → the canonical browser UA + sec-ch-ua (injected centrally by core — do NOT
//      hand-declare them here).
//   2. Fetch-Metadata        → `Sec-Fetch-Site: same-origin` ("cross-site … not allowed").
//   3. Origin match          → `Origin: https://dashboard.ngrok.com` ("cross-origin … not allowed").
// Origin + Sec-Fetch-* are FORBIDDEN on Electron net.request → this stays on plain `node` (axios) transport,
// NOT requiresBrowserEngine. Auth is the dashboard session cookie, replayed verbatim. Money is CENTS everywhere
// (strings on invoices, a number on usage-to-date) → normalized to USD dollars here.
const ORIGIN = 'https://dashboard.ngrok.com'
const RPX = `${ORIGIN}/_api/rpx`

// The gateway also wants a per-call CSRF token sent as `x-ngrok-proxy-csrf`. It is NOT a cookie and NOT a
// `/csrf-token` endpoint — it's embedded in every authenticated dashboard page as a <meta> (and, as a
// fallback, in the page's bootstrap JSON). Scrape it once per collect from a light authed page.
const CSRF_PAGE = `${ORIGIN}/team-members`

// Pull the proxy-csrf token out of a fetched dashboard page; throws (→ session re-prompt) when absent.
export const extractCsrfToken = (html: string): string => {
  const meta = /<meta\s+name="ngrok-proxy-csrf-token"\s+content="([^"]+)"/i.exec(html)

  if (meta) {
    return meta[1]
  }

  const blob = /"proxyCsrfToken","([^"]+)"/.exec(html)

  if (blob) {
    return blob[1]
  }

  throw new Error('ngrok: could not find the proxy-csrf token in the dashboard page (session expired?).')
}

// One authed Connect-RPC POST. `rpcPath` is the service/method after `/_api/rpx`, e.g.
// `svc.dash.DashBillingService/GetInvoices`. Origin + Sec-Fetch-* are the same-origin markers the gateway
// requires; the cookie + canonical UA/sec-ch-ua are applied centrally by the node client.
const rpc = <T>(ctx: CollectContext, rpcPath: string, csrf: string, body: unknown = {}): Promise<T> =>
  ctx.client.post<T>(`${RPX}/${rpcPath}`, body, {
    'content-type': 'application/json',
    'connect-protocol-version': '1',
    'x-ngrok-proxy-csrf': csrf,
    Origin: ORIGIN,
    Referer: CSRF_PAGE,
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty'
  })

const loadCsrf = (ctx: CollectContext): Promise<string> =>
  ctx.client.getText(CSRF_PAGE, { Referer: ORIGIN }).then((html) => extractCsrfToken(html ?? ''))

// ── types (the data dictionary) ───────────────────────────────────────────────────────
// Connect-RPC wraps epoch seconds in `{ seconds }` objects and reports all money as cent strings.

interface RawSeconds {
  seconds?: string
}

export interface RawSubscription {
  intervalMonths?: number
  renewsAt?: RawSeconds
  plan?: { productId?: string; quantity?: string; description?: string }
  currentBillingPeriodStartDate?: RawSeconds
  currentBillingPeriodEndDate?: RawSeconds
  additionalUsageToDateInCents?: number
}

export interface RawInvoice {
  total?: string
  amountDue?: string
  amountPaid?: string
  status?: string
  invoiceUrl?: string
  createdAt?: RawSeconds
  issuedAt?: RawSeconds
  dueAt?: RawSeconds
}

export interface RawInvoiceList {
  invoices?: RawInvoice[]
}

interface RawOwner {
  title?: string
  name?: string
  description?: string
}

interface RawCredential {
  description?: string
  createdAt?: RawSeconds
  id?: { id?: string }
  ownerLegacy?: RawOwner
  active?: boolean
}

export interface RawApiKeyList {
  apiKeys?: RawCredential[]
}

export interface RawAuthtokenList {
  dashAuthtokens?: RawCredential[]
}

// `{ seconds: '1781150400' }` → 'YYYY-MM-DD' (UTC); missing → undefined.
const secDay = (s?: RawSeconds): string | undefined => epochSecDay(s?.seconds ? parseInt(s.seconds, 10) : undefined)

// ── billing (DashBillingService — subscription summary + invoice history) ────────────────
// Two tabs share one fetch (the core query cache dedupes the underlying RPCs):
//   • Summary — the lean overview the cross-service Overview rolls up (spend.mtd): the open period's
//     metered usage-to-date headline + the monthly-spend chart + a tight row of stats. No tables/records.
//   • Billing — the detail: the subscription account record (plan, seats, period, renewal) + the invoice
//     history. ngrok's invoice link is a hosted console URL (not a PDF), so it's a url-column table.

export interface NgrokBilling {
  plan: string
  seats: number
  intervalMonths: number
  renewsAt?: string
  periodStart?: string
  periodEnd?: string
  // Metered overage accrued in the open period, in USD dollars — the live MTD figure.
  usageToDate: number
  invoices: BillingInvoiceInput[]
}

// Pure transform — fixture-tested. Cent strings → USD, `{ seconds }` → ISO day. Invoice date prefers issued,
// then created, then due. Invoices newest-first for the table; the monthly spark re-buckets them by month.
export const buildNgrokBilling = (
  rawSub: RawSubscription | null | undefined,
  rawInvoices: RawInvoiceList | null | undefined
): NgrokBilling => {
  const sub = rawSub ?? {}
  const invoices = (rawInvoices?.invoices ?? [])
    .map((inv): BillingInvoiceInput => ({
      date: secDay(inv.issuedAt) ?? secDay(inv.createdAt) ?? secDay(inv.dueAt),
      amount: centsStringToMajor(inv.total),
      status: inv.status ?? 'Unknown',
      hostedUrl: inv.invoiceUrl ?? null
    }))
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))

  return {
    plan: sub.plan?.description ?? 'Unknown plan',
    seats: sub.plan?.quantity ? parseInt(sub.plan.quantity, 10) : 0,
    intervalMonths: sub.intervalMonths ?? 1,
    renewsAt: secDay(sub.renewsAt),
    periodStart: secDay(sub.currentBillingPeriodStartDate),
    periodEnd: secDay(sub.currentBillingPeriodEndDate),
    usageToDate: centsToMajor(sub.additionalUsageToDateInCents),
    invoices
  }
}

// Summary tab — the lean overview the cross-service Overview rolls up (spend.mtd): the headline (the open
// period's metered usage-to-date) + the monthly-spend chart + a tight row of stats. Plan, seats, period,
// renewal, and the invoice list are the Billing tab's detail — not here. usageToDate is 0 when there's no
// metered overage; 0 stays (the Overview reads ngrok's current-month bar) rather than nulling out and dropping
// the service from the Overview when a period reset leaves the open overage at 0.
export const buildNgrokSummaryResult = (billingData: NgrokBilling): CapabilityResult =>
  billing.summary({
    currentMtd: billingData.usageToDate,
    currentMtdLabel: 'Usage to date',
    // The headline is the open period's metered overage accruing live (the licensed base fee isn't priced in
    // the dashboard's subscription payload), so the basis is 'accrued'.
    mtdBasis: 'accrued',
    invoices: billingData.invoices,
    stats: [
      { key: 'seats', label: 'Seats', role: 'count', value: billingData.seats },
      { key: 'renewsAt', label: 'Renews', role: 'timestamp', value: billingData.renewsAt ?? null },
      { key: 'invoiceCount', label: 'Invoices', role: 'count', value: billingData.invoices.length }
    ]
  })

interface BillingAccountRow {
  plan: string
  seats: number
  period: string | null
  renewsAt: string | null
}

interface BillingInvoiceRow {
  date: string | null
  amount: number
  status: string
  url: string | null
}

// Billing tab — the financial detail (not the Overview rollup; the headline + chart live on Summary): the
// subscription account record + the invoice history. The invoice link is a hosted console URL, so it's a
// plain table with a url column (no PDF download).
export const buildNgrokBillingTab = (billing: NgrokBilling): CapabilityResult => {
  const period = billing.periodStart && billing.periodEnd ? `${billing.periodStart} → ${billing.periodEnd}` : null

  const account = record<BillingAccountRow>({
    id: 'account',
    fields: [
      { key: 'plan', label: 'Plan', role: 'label' },
      { key: 'seats', label: 'Seats', role: 'count' },
      { key: 'period', label: 'Current period', role: 'label' },
      { key: 'renewsAt', label: 'Renews', role: 'timestamp' }
    ],
    value: { plan: billing.plan, seats: billing.seats, period, renewsAt: billing.renewsAt ?? null }
  })

  const invoices = table<BillingInvoiceRow>({
    id: 'invoices',
    columns: [
      { key: 'date', label: 'Date', role: 'timestamp' },
      { key: 'amount', label: 'Amount', role: 'money' },
      { key: 'status', label: 'Status', role: 'status' },
      { key: 'url', label: 'Invoice', role: 'url' }
    ],
    rows: billing.invoices.map((i) => ({
      date: i.date ?? null,
      amount: i.amount,
      status: i.status,
      url: i.hostedUrl ?? null
    })),
    // The invoice payload carries no id, and a single date can hold two invoices (subscription + metered), so
    // (date, amount) is the stable unique identity — keyed as a composite so each invoice's status accumulates.
    key: ['date', 'amount']
  })

  return capabilityResult({
    sections: [
      account.keyvalue({ title: 'Subscription' }),
      invoices.dataset.rows.length > 0 ? invoices.table({ title: 'Invoices' }) : null
    ]
  })
}

// Summary + Billing share the same two billing RPCs; both capabilities fetch the same raw bundle and the
// core query cache dedupes the underlying reads. build derives NgrokBilling from the raw wire shape.
export interface RawNgrokBilling {
  subscription: RawSubscription | null
  invoices: RawInvoiceList | null
}

const fetchNgrokBilling = async (ctx: CollectContext): Promise<RawNgrokBilling> => {
  const csrf = await loadCsrf(ctx)
  const [subscription, invoices] = await Promise.all([
    rpc<RawSubscription>(ctx, 'svc.dash.DashBillingService/GetSubscription', csrf),
    rpc<RawInvoiceList>(ctx, 'svc.dash.DashBillingService/GetInvoices', csrf)
  ])

  return { subscription, invoices }
}

// ── apiKeys (combined credential inventory — API keys `ak_…` + agent auth tokens `cr_…`) ──
// ngrok exposes no per-credential spend or last-used, so this is a pure inventory: id, owner, created,
// active. The apiKeys preset has no owner column, so owner is folded into the displayed name; the id is the
// stable identifier and is masked to its prefix + last 4 (never surface a full credential id).

export type NgrokCredentialKind = 'API key' | 'Auth token'

export interface NgrokCredential {
  kind: NgrokCredentialKind
  id: string
  owner: string
  createdAt?: string
  active: boolean
}

// `ak_38Dp3a1M3G6YaZ2MbpfL6kNV0tq` → `ak_38…V0tq`; short/empty ids degrade to '—'.
export const maskId = (id?: string): string => {
  if (!id) {
    return '—'
  }

  return id.length > 9 ? `${id.slice(0, 5)}…${id.slice(-4)}` : id
}

const ownerEmail = (owner?: RawOwner): string => owner?.title || owner?.name || owner?.description || 'unknown'

const transform = (c: RawCredential, kind: NgrokCredentialKind): NgrokCredential => ({
  kind,
  id: c.id?.id ?? '',
  owner: ownerEmail(c.ownerLegacy),
  createdAt: secDay(c.createdAt),
  active: c.active ?? false
})

// Pure transform — fixture-tested. API keys then auth tokens, in that order.
export const buildNgrokCredentials = (
  apiKeys: RawApiKeyList | null | undefined,
  authtokens: RawAuthtokenList | null | undefined
): NgrokCredential[] => [
  ...(apiKeys?.apiKeys ?? []).map((c) => transform(c, 'API key')),
  ...(authtokens?.dashAuthtokens ?? []).map((c) => transform(c, 'Auth token'))
]

// Map the combined inventory onto the apiKeys preset: name carries kind + owner (no owner column in the
// preset), masked carries the id prefix, status reflects `active`.
export const buildNgrokKeysResult = (credentials: NgrokCredential[]): CapabilityResult =>
  keys.result({
    keys: credentials.map((c, i): ApiKeysInput['keys'][number] => ({
      id: c.id || String(i),
      name: `${c.kind} · ${c.owner}`,
      masked: maskId(c.id),
      createdAt: c.createdAt,
      revoked: !c.active
    }))
  })

export interface RawNgrokCredentials {
  apiKeys: RawApiKeyList | null
  authtokens: RawAuthtokenList | null
}

const fetchNgrokKeys = async (ctx: CollectContext): Promise<RawNgrokCredentials> => {
  const csrf = await loadCsrf(ctx)
  const [apiKeys, authtokens] = await Promise.all([
    rpc<RawApiKeyList>(ctx, 'svc.dash.DashAPIKeysService/GetAll', csrf),
    rpc<RawAuthtokenList>(ctx, 'svc.dash.DashAuthtokenService/GetAll', csrf)
  ])

  return { apiKeys, authtokens }
}

// ── members (team roster — active members + pending invitations) ──────────────────────
// Management + insights share the dashboard session cookie, so the roster is reachable via the same
// Connect-RPC gateway the billing/apiKeys collects already use:
//   POST svc.dash.DashTeamMembersService/List → { teamMembers: [...] }
//   POST svc.dash.DashInvitationsService/List  → { invitations: [...] }
// Each member carries an email, a `{ id: { id } }` wrapper, and a permissions object; role is derived
// from the permissions (team-manage / admin → 'Admin', else 'Member'). Pending invitations join the
// roster with a 'Pending' role so the table shows who's been invited but hasn't accepted.
const TEAM_MEMBERS_LIST = 'svc.dash.DashTeamMembersService/List'
const INVITATIONS_LIST = 'svc.dash.DashInvitationsService/List'

interface RawPermissions {
  isAdmin?: boolean
  team?: string
}

interface RawMember {
  id?: { id?: string }
  email?: string
  name?: string
  permissions?: RawPermissions
  membershipPermissions?: RawPermissions
  active?: boolean
  status?: string
}

export interface RawTeamMemberList {
  teamMembers?: RawMember[]
}

export interface RawInvitationList {
  invitations?: RawMember[]
}

// Active members get their derived role ('Admin'/'Member'); invitations are surfaced as 'Pending'.
const memberRole = (m: RawMember): string => {
  const perms = m.permissions ?? m.membershipPermissions

  return perms?.isAdmin || perms?.team === 'TeamManage' ? 'Admin' : 'Member'
}

const transformMember = (m: RawMember, i: number, pending: boolean): MemberInput => ({
  id: m.id?.id || m.email || String(i),
  name: m.name,
  email: m.email,
  role: pending ? 'Pending' : memberRole(m)
})

// Pure transform — fixture-tested. Active members first, then pending invitations.
export const buildNgrokMembers = (
  teamMembers: RawTeamMemberList | null | undefined,
  invitations: RawInvitationList | null | undefined
): MembersInput => ({
  members: [
    ...(teamMembers?.teamMembers ?? []).map((m, i) => transformMember(m, i, false)),
    ...(invitations?.invitations ?? []).map((m, i) => transformMember(m, i, true))
  ]
})

export interface RawNgrokMembers {
  teamMembers: RawTeamMemberList | null
  invitations: RawInvitationList | null
}

const fetchNgrokMembers = async (ctx: CollectContext): Promise<RawNgrokMembers> => {
  const csrf = await loadCsrf(ctx)
  const teamMembers = await rpc<RawTeamMemberList>(ctx, TEAM_MEMBERS_LIST, csrf)

  // Pending invitations live in a separate service — keep it non-fatal so a shape surprise there can't
  // blank out the (verified) member list.
  let invitations: RawInvitationList | null = null

  try {
    invitations = await rpc<RawInvitationList>(ctx, INVITATIONS_LIST, csrf)
  } catch (error) {
    ctx.log('ngrok: failed to list pending invitations', { error: String(error) })
  }

  return { teamMembers, invitations }
}

// ── descriptor ──────────────────────────────────────────────────────────────────────
export const ngrokPlugin = definePlugin({
  reportingCurrency: 'USD',
  meta: {
    id: 'ngrok',
    name: 'ngrok',
    vendor: 'ngrok',
    category: 'devtools',
    color: '#1f1e24',
    description: 'ngrok dashboard — plan/usage billing, invoices, and the API-key + agent-token inventory.',
    homepage: 'https://ngrok.com',
    dashboardUrl: 'https://dashboard.ngrok.com'
  },
  session: {
    loginUrl: 'https://dashboard.ngrok.com/login',
    dashboardMarkers: ['/get-started', '/cloud-edge', '/team-members', '/api'],
    cookieDomains: ['ngrok.com']
  },
  auth: { kind: 'cookie' },
  // node (axios) transport: the Connect-RPC gateway needs Origin + Sec-Fetch-* (forbidden on Electron
  // net.request), and ngrok's 403s are app-level, not a browser-engine requirement — so plain Node TLS works. The
  // canonical browser UA + sec-ch-ua are injected centrally; only the per-call same-origin markers are set
  // per request inside rpc() (they vary by call, so they don't belong in defaultHeaders).
  transport: { engine: 'node', baseUrl: ORIGIN },
  capabilities: [
    defineCapability({
      id: 'summary',
      label: 'Summary',
      fetch: fetchNgrokBilling,
      build: (raw) => buildNgrokSummaryResult(buildNgrokBilling(raw.subscription, raw.invoices)),
      sample: (g, c) => ({ subscription: sampleNgrokSubscription(g, c), invoices: sampleNgrokInvoices(g, c) })
    }),
    defineCapability({
      id: 'billing',
      label: 'Billing',
      fetch: fetchNgrokBilling,
      build: (raw) => buildNgrokBillingTab(buildNgrokBilling(raw.subscription, raw.invoices)),
      sample: (g, c) => ({ subscription: sampleNgrokSubscription(g, c), invoices: sampleNgrokInvoices(g, c) })
    }),
    defineCapability({
      id: 'apiKeys',
      label: 'API Keys',
      fetch: fetchNgrokKeys,
      build: (raw) => buildNgrokKeysResult(buildNgrokCredentials(raw.apiKeys, raw.authtokens)),
      sample: (g, c) => ({ apiKeys: sampleNgrokApiKeys(g, c), authtokens: sampleNgrokAuthtokens(g, c) })
    }),
    defineCapability({
      id: 'members',
      label: 'Members',
      fetch: fetchNgrokMembers,
      build: (raw) => members.result(buildNgrokMembers(raw.teamMembers, raw.invitations)),
      sample: (g, c) => ({ teamMembers: sampleNgrokTeamMembers(g, c), invitations: sampleNgrokInvitations(g, c) })
    })
  ],
  probe: async (ctx) => {
    // Scraping the CSRF page is the cheapest authed call — a 200 with a token proves the session is live.
    await loadCsrf(ctx)
  }
})
