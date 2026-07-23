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
import { capabilityResult, table, type CapabilityResult } from '@butinapp/sdk/data'
import { billing, members, type BillingInvoiceInput, type MemberInput } from '@butinapp/sdk/presets'
import { currentMonthKey, isoDay, millicentsToMajor, startCase } from '@butinapp/sdk/util'

import { sampleQdrantInvoices, sampleQdrantKeys, sampleQdrantMembers } from './sample.js'

// Qdrant — rotating-refresh auth. cloud.qdrant.io is an Auth0 SPA, not a cookie session: API calls carry a
// short-lived (60s) Bearer minted from a refresh token kept in localStorage. Magic Login captures that
// refresh token (dynamic @@auth0spajs@@ key, see the session config below). Per fetch we exchange it for a
// fresh access token AND a NEW refresh token (Auth0
// rotation invalidates the old one), then WRITE THE ROTATED TOKEN BACK — skip that and the next fetch
// dies with invalid_grant. axios (not net.request): the refresh grant is CORS-validated and needs an
// Origin header.
const LOGIN_ORIGIN = 'https://login.cloud.qdrant.io'
const API_ORIGIN = 'https://cloud.qdrant.io'
const AUTH0_CLIENT_ID = 'rI1wcOPHOMdeHuTx4x1kF0KFdQ7wnezg'
const AUTH0_REDIRECT_URI = 'https://cloud.qdrant.io/auth/callback'

// --- types: all Raw* wire shapes + normalized domain/input types (the data dictionary) ---
interface TokenResponse {
  access_token?: string
  refresh_token?: string
}

interface RawInvoice {
  id?: string
  number?: string
  totalAmount?: string // millicents
  createdAt?: string
  status?: string
  pdfUrl?: string
}

export interface QdrantInvoicesInput {
  items: RawInvoice[]
}

interface RawRole {
  name?: string
  subType?: string
}

interface RawUserWithRoles {
  user?: { id?: string; email?: string; status?: string }
  roles?: RawRole[]
}

export interface QdrantMembersInput {
  items: RawUserWithRoles[]
}

interface RawManagementKey {
  id?: string
  prefix?: string
  createdAt?: string
}

interface RawAccessRule {
  globalAccess?: { accessType?: string }
}

interface RawDatabaseApiKey {
  id?: string
  name?: string
  createdAt?: string
  createdByEmail?: string
  accessRules?: RawAccessRule[]
}

interface RawCluster {
  id?: string
  name?: string
}

interface ClusterKeys {
  clusterId: string
  clusterName: string
  items: RawDatabaseApiKey[]
}

export interface QdrantKeysInput {
  databaseKeys: ClusterKeys[]
  managementKeys: RawManagementKey[]
}

// resolve(): exchange the durable refresh token for a 60s access token; persist the rotated refresh
// token back to creds. Never memoized (auth.kind === 'rotating-refresh'), so it runs every request.
export const resolveQdrantToken = async ({ client, creds }: AuthContext): Promise<AuthAttachment> => {
  const refreshToken = creds.get('refreshToken')

  if (!refreshToken) {
    throw new Error('No Qdrant refresh token captured — sign in again.')
  }

  const body = new URLSearchParams({
    client_id: AUTH0_CLIENT_ID,
    redirect_uri: AUTH0_REDIRECT_URI,
    grant_type: 'refresh_token',
    refresh_token: refreshToken
  }).toString()

  const res = await client.post<TokenResponse>(`${LOGIN_ORIGIN}/oauth/token`, body, {
    'content-type': 'application/x-www-form-urlencoded',
    Origin: API_ORIGIN
  })

  if (!res?.access_token) {
    throw new Error('[qdrant] token endpoint returned no access_token')
  }

  // Auth0 rotates the refresh token on every exchange — persist the new one or the next fetch fails.
  if (res.refresh_token && res.refresh_token !== refreshToken) {
    creds.set('refreshToken', res.refresh_token)
  }

  return { headers: { Authorization: `Bearer ${res.access_token}` } }
}

// Auto-extracted from the dashboard URL at capture time (creds), overridable via config.
const accountIdOf = (ctx: CollectContext<QdrantConfig>): string => {
  const id = ctx.config.accountId?.trim() || ctx.creds.get('accountId')

  if (!id) {
    throw new Error('Could not determine your Qdrant account id — sign in again, or set it in Settings.')
  }

  return id
}

const connect = <T>(ctx: CollectContext<QdrantConfig>, rpc: string, body: unknown): Promise<T> =>
  ctx.client.post<T>(`${API_ORIGIN}/connect/${rpc}`, body, { Origin: API_ORIGIN })

// The connect-RPC gateway intermittently answers a transient 5xx on a busy account — the same call succeeds
// moments later. Retry a 5xx (each attempt is host-paced, so the retries are already spaced); surface
// auth/argument errors (401/4xx) immediately so a dead session still re-prompts.
const GATEWAY_MAX_ATTEMPTS = 3

export const retryOn5xx = async <T>(fn: () => Promise<T>, attempts = GATEWAY_MAX_ATTEMPTS): Promise<T> => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      const status = (err as { status?: number }).status

      if (attempt >= attempts || status == null || status < 500) {
        throw err
      }
    }
  }
}

// --- organization picker (Settings combobox) ---
// An account = one Qdrant organization (own account, a shared team org, …). AccountService/ListAccounts
// returns every org you belong to; the Settings combobox lists them so you pick one instead of pasting a
// UUID. The picked value is stored under `accountId` (the same key `accountIdOf` reads), so picking just
// overrides the account auto-extracted from the dashboard URL at capture time.
interface RawAccount {
  id?: string
  name?: string
  ownerEmail?: string
}

export interface QdrantAccountsInput {
  items: RawAccount[]
}

// Pure transform — fixture-tested. Org name as label, the account UUID as the stored value, owner email as
// subtext. `recommended` marks the account you signed in with (the captured one) so the picker pre-selects
// it instead of opening blank — it never silently changes the stored value.
export const buildQdrantAccountOptions = (accounts: RawAccount[], currentId?: string): ConfigOption[] => {
  const valid = (accounts ?? []).filter((a): a is RawAccount & { id: string } => typeof a.id === 'string' && !!a.id)

  return valid.map((a) => ({
    value: a.id,
    label: a.name?.trim() || a.ownerEmail?.trim() || a.id,
    description: a.ownerEmail?.trim() || a.id,
    recommended: !!currentId && a.id === currentId
  }))
}

const fetchQdrantAccounts = async (ctx: CollectContext): Promise<RawAccount[]> => {
  try {
    const res = await connect<{ items?: RawAccount[] }>(ctx, 'qdrant.cloud.account.v1.AccountService/ListAccounts', {})

    return res?.items ?? []
  } catch {
    return []
  }
}

// --- billing: the account's actual invoices (a committed monthly plan). Money is MILLICENTS. ---
// The Stripe-backed ListInvoices is the reliable, complete billing history — one call, every month present,
// each with a downloadable PDF. Summary reads it for the monthly-spend chart + the Overview spend rollup;
// Billing lists the individual invoices with their PDFs.
const invoiceStatus = (status?: string): string =>
  (status ?? '').replace(/^INVOICE_STATUS_/, '').toLowerCase() || 'unknown'

// Pure transform — fixture-tested. Raw invoices → the billing preset's invoice input (millicents→USD, the issue
// day, a lowercase status the renderer auto-tones, the Stripe PDF link). Undated invoices can't bucket, so skip.
export const toBillingInvoices = (items: RawInvoice[]): BillingInvoiceInput[] =>
  items
    .filter((i) => i.createdAt)
    .map((i) => ({
      id: i.id ?? i.number,
      date: isoDay(i.createdAt),
      amount: millicentsToMajor(i.totalAmount),
      status: invoiceStatus(i.status),
      pdfUrl: i.pdfUrl ?? null
    }))

// --- Summary tab (its spend summary is what the cross-service Overview rolls up) ---
// The monthly-spend chart + headline from the invoices. "This month" is the current month's invoice once it
// posts, else the latest invoice — the recurring charge you're on.
export const buildQdrantSummary = (input: QdrantInvoicesInput): CapabilityResult => {
  const invoices = toBillingInvoices(input.items)
  const newestFirst = [...invoices].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
  const thisMonth = currentMonthKey()
  const current = newestFirst.find((i) => i.date?.startsWith(thisMonth)) ?? newestFirst[0]

  return billing.summary({
    currentMtd: current?.amount ?? null,
    mtdBasis: 'invoiced',
    currency: 'USD',
    invoices
  })
}

// --- Billing tab (renders via the generic renderer; emits no summary, so it's NOT the Overview rollup) ---
// The itemized invoice list (newest first) with a downloadable PDF per row. The headline + chart live on Summary.
interface QdrantInvoiceRow {
  id: string
  number: string
  date: string | null
  amount: number
  status: string
  pdfUrl: string | null
  name: string
}

export const buildQdrantBilling = (input: QdrantInvoicesInput): CapabilityResult => {
  const rows: QdrantInvoiceRow[] = input.items
    .filter((i) => i.createdAt)
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
    .map((i) => ({
      id: i.id ?? i.number ?? String(i.createdAt),
      number: i.number ?? '—',
      date: isoDay(i.createdAt) ?? null,
      amount: millicentsToMajor(i.totalAmount),
      status: invoiceStatus(i.status),
      pdfUrl: i.pdfUrl ?? null,
      name: `Qdrant invoice ${i.number ?? isoDay(i.createdAt) ?? ''}`.trim()
    }))

  return capabilityResult({
    sections: [
      table<QdrantInvoiceRow>({
        id: 'invoices',
        columns: [
          { key: 'number', label: 'Invoice #', role: 'identifier' },
          { key: 'amount', label: 'Amount', role: 'money', currency: 'USD' },
          { key: 'date', label: 'Date', role: 'timestamp' },
          { key: 'status', label: 'Status', role: 'status' },
          { key: 'id', role: 'identifier', hidden: true },
          { key: 'pdfUrl', role: 'url', hidden: true },
          { key: 'name', role: 'label', hidden: true }
        ],
        rows,
        // one row per invoice → keyed by id so the invoice history accumulates.
        key: 'id'
      }).fileTable({ title: 'Invoices', name: 'name', source: { url: 'pdfUrl' }, ext: 'pdf', category: 'Invoices' })
    ]
  })
}

// Summary + Billing both read ListInvoices; the core query cache dedupes the underlying call across the two tabs.
const fetchQdrantInvoices = async (ctx: CollectContext<QdrantConfig>): Promise<QdrantInvoicesInput> => {
  const res = await retryOn5xx(() =>
    connect<{ items?: RawInvoice[] }>(ctx, 'qdrant.cloud.billing.v1.BillingService/ListInvoices', {
      accountId: accountIdOf(ctx)
    })
  )

  return { items: res?.items ?? [] }
}

// --- members: who has access to the account (the dashboard's /cloud-access "all users" page). ---
// The UI reads an aggregation RPC (NOT a flat user list) that joins each user with their account roles. The
// response has no `name` — only the email. Everyone carries a baseline "Base" system role; the meaningful
// assignment is whatever else they hold. Drop Base, dedupe + join the rest; if Base is all they have,
// surface it. Role names are already human.
const BASE_ROLE_SUBTYPE = 'SYSTEM_ROLE_SUB_TYPE_BASE'

export const displayMemberRole = (roles: RawRole[] = []): string | undefined => {
  const named = [...new Set(roles.filter((r) => r.subType !== BASE_ROLE_SUBTYPE && r.name).map((r) => r.name!))]

  return named.length ? named.join(', ') : roles.find((r) => r.name)?.name
}

// Pure transform — fixture-tested. Each user (email only) + their non-baseline role(s) → the members preset.
export const buildQdrantMembers = (input: QdrantMembersInput): CapabilityResult =>
  members.result({
    members: input.items.map(
      (item): MemberInput => ({
        id: item.user?.id ?? item.user?.email ?? 'unknown',
        email: item.user?.email,
        role: displayMemberRole(item.roles)
      })
    )
  })

const fetchQdrantMembers = async (ctx: CollectContext<QdrantConfig>): Promise<QdrantMembersInput> => {
  const res = await connect<{ items?: RawUserWithRoles[] }>(
    ctx,
    'qdrant.cloud.ui.v1.AggregationService/ListUsersWithRoles',
    { accountId: accountIdOf(ctx) }
  )

  return { items: res?.items ?? [] }
}

// --- apiKeys: account management keys + per-cluster database keys (access level + creator) ---
// `GLOBAL_ACCESS_RULE_ACCESS_TYPE_READ_ONLY` → `Read Only`. Empty → ''.
export const humanizeAccess = (accessType?: string): string =>
  accessType ? startCase(accessType.replace(/^GLOBAL_ACCESS_RULE_ACCESS_TYPE_/, '')) : ''

interface KeyRow {
  name: string
  type: string
  cluster: string | null
  access: string | null
  createdBy: string | null
  created: string | null
}

// Pure transform — fixture-tested. Database keys (per cluster, with access/creator) + management keys,
// merged into one inventory table. The columns (cluster, access, creator) exceed the apiKeys preset's
// fixed shape, so the table is hand-built.
export const buildQdrantKeys = (input: QdrantKeysInput): CapabilityResult => {
  const rows: KeyRow[] = []

  for (const cluster of input.databaseKeys) {
    for (const key of cluster.items) {
      rows.push({
        name: key.name ?? '(unnamed)',
        type: 'database',
        cluster: cluster.clusterName,
        access: humanizeAccess(key.accessRules?.[0]?.globalAccess?.accessType) || null,
        createdBy: key.createdByEmail ?? null,
        created: isoDay(key.createdAt) ?? null
      })
    }
  }

  for (const key of input.managementKeys) {
    rows.push({
      name: key.prefix ? `${key.prefix}…` : '(management key)',
      type: 'management',
      cluster: null,
      access: null,
      createdBy: null,
      created: isoDay(key.createdAt) ?? null
    })
  }

  return capabilityResult({
    sections: [
      table<KeyRow>({
        id: 'keys',
        columns: [
          { key: 'name', label: 'Name', role: 'label' },
          { key: 'type', label: 'Type', role: 'label' },
          { key: 'cluster', label: 'Cluster', role: 'label' },
          { key: 'access', label: 'Access', role: 'label' },
          { key: 'createdBy', label: 'Created by', role: 'label' },
          { key: 'created', label: 'Created', role: 'timestamp' }
        ],
        rows
      }).table({ title: 'API keys' })
    ]
  })
}

// Account-level cloud-management keys + per-cluster database keys (access level + creator).
const fetchQdrantKeys = async (ctx: CollectContext<QdrantConfig>): Promise<QdrantKeysInput> => {
  const accountId = accountIdOf(ctx)
  const [clustersRes, mgmtRes] = await Promise.all([
    connect<{ items?: RawCluster[] }>(ctx, 'qdrant.cloud.cluster.v1.ClusterService/ListClusters', { accountId }),
    connect<{ items?: RawManagementKey[] }>(ctx, 'qdrant.cloud.auth.v1.AuthService/ListManagementKeys', { accountId })
  ])

  const clusters = clustersRes?.items ?? []
  const databaseKeys = await Promise.all(
    clusters.map(async (cluster): Promise<ClusterKeys> => {
      const res = await connect<{ items?: RawDatabaseApiKey[] }>(
        ctx,
        'qdrant.cloud.cluster.auth.v2.DatabaseApiKeyService/ListDatabaseApiKeys',
        { accountId, clusterId: cluster.id }
      )

      return {
        clusterId: cluster.id ?? 'unknown',
        clusterName: cluster.name ?? cluster.id ?? 'unknown',
        items: res?.items ?? []
      }
    })
  )

  return { databaseKeys, managementKeys: mgmtRes?.items ?? [] }
}

// Qdrant: rotating-refresh over Node. No cookie — the durable credential is an Auth0 refresh token in
// localStorage under a DYNAMIC key (`@@auth0spajs@@::<clientId>::…clusters…`), so we capture it with
// keyIncludes + jsonPath. It rotates on every fetch (write-back above).
export const qdrantConfigSchema = defineConfigSchema([
  {
    key: 'accountId',
    label: 'Organization',
    kind: 'combobox',
    placeholder: 'Pick your organization…',
    help: 'The Qdrant account Butin reads. The list comes from your sign-in; pick one instead of pasting its ID.',
    loadOptions: async (ctx) => buildQdrantAccountOptions(await fetchQdrantAccounts(ctx), ctx.creds.get('accountId'))
  }
])

export type QdrantConfig = ConfigOf<typeof qdrantConfigSchema>

export const qdrantPlugin = definePlugin({
  reportingCurrency: 'USD',
  meta: {
    id: 'qdrant',
    name: 'Qdrant Cloud',
    vendor: 'Qdrant',
    category: 'cloud',
    color: '#d6204a',
    description: 'Qdrant Cloud metered spend, members, and API keys.',
    homepage: 'https://qdrant.tech',
    dashboardUrl: 'https://cloud.qdrant.io'
  },
  session: {
    loginUrl: 'https://cloud.qdrant.io/',
    dashboardMarkers: ['/accounts/', '/clusters', '/billing', '/cloud-access'],
    cookieDomains: ['qdrant.io'],
    // The credential is NOT a cookie — it's the Auth0 refresh token nested in a dynamic localStorage
    // key. No requiredCookie; we gate on the localStorage token landing instead.
    localStorageTokens: [
      { keyIncludes: ['@@auth0spajs@@', 'clusters'], jsonPath: 'body.refresh_token', storeAs: 'refreshToken' }
    ],
    // Auto-extract the account id from the dashboard URL (cloud.qdrant.io/accounts/<uuid>/).
    captureFromUrl: [{ pattern: '/accounts/([0-9a-fA-F-]{36})', storeAs: 'accountId' }]
  },
  auth: { kind: 'rotating-refresh', resolve: resolveQdrantToken },
  config: qdrantConfigSchema,
  capabilities: [
    defineCapability({
      id: 'summary',
      label: 'Summary',
      fetch: fetchQdrantInvoices,
      build: buildQdrantSummary,
      sample: sampleQdrantInvoices
    }),
    defineCapability({
      id: 'billing',
      label: 'Billing',
      fetch: fetchQdrantInvoices,
      build: buildQdrantBilling,
      sample: sampleQdrantInvoices
    }),
    defineCapability({
      id: 'members',
      label: 'Members',
      fetch: fetchQdrantMembers,
      build: buildQdrantMembers,
      sample: sampleQdrantMembers
    }),
    defineCapability({
      id: 'keys',
      label: 'API Keys',
      fetch: fetchQdrantKeys,
      build: buildQdrantKeys,
      sample: sampleQdrantKeys
    })
  ],
  probe: async (ctx) => {
    // ListClusters is the cheapest authed Connect-RPC — a 200 proves the rotating-refresh exchange minted a
    // valid access token (and wrote the rotated refresh token back), without pulling the metering history.
    await connect(ctx, 'qdrant.cloud.cluster.v1.ClusterService/ListClusters', { accountId: accountIdOf(ctx) })
  }
})
