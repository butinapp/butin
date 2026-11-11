import { defineCapability, definePlugin, type ButinClient, type CollectContext } from '@butinapp/sdk'
import { capabilityResult, record, table, type CapabilityResult } from '@butinapp/sdk/data'
import { billing, blocks, usage } from '@butinapp/sdk/presets'
import { byDayDesc, centsToMajor, dayOf, epochMsDay, isPdfBytes, startCase } from '@butinapp/sdk/util'

import {
  sampleTailscaleBilling,
  sampleTailscaleKeys,
  sampleTailscaleSubscription,
  sampleTailscaleUsers
} from './sample.js'

// Tailscale (console.tailscale.com) — the tailnet admin console. The console SPA reads a JSON API on
// login.tailscale.com/admin/api, and every response is wrapped `{ status: 'success', data }`.
//
// AUTH: the `tailcontrol` session cookie (HttpOnly, login.tailscale.com), replayed verbatim. A signed-out request
// answers `403 forbidden - not logged in`, not a 401, so 403 also clears the session — and `readAdmin` confirms a
// 403 against the session before letting it propagate, so a role that can't read one endpoint never wipes a live
// session.
//
// TRANSPORT: plain Node axios; the calls carry the console's cross-site `Origin`/`Referer` like the SPA's own XHRs.
//
// MONEY is Stripe-shaped: integer CENTS, with epoch-MILLISECOND period bounds on the subscription. The plan is
// billed in advance — each invoice is issued on the first day of the period it covers — so an invoice's issue day
// is the month its spend belongs to.

const CONSOLE_ORIGIN = 'https://console.tailscale.com'
const API_BASE = 'https://login.tailscale.com/admin/api'
const SELF = '/self'
const SUBSCRIPTION = '/public/stripe/subscription'
// The console's own invoice page size; the invoices table is keyed, so older invoices accumulate past this window.
const INVOICES = '/public/stripe/invoices?limit=24'
// `all` adds OAuth clients + federated identities to the auth keys and API tokens; `includeInvalid` keeps the
// expired and revoked ones.
const KEYS = '/public/tailnet/-/keys?all=true&includeInvalid=true'
const USERS = '/users'

// ── types: wire shapes (only the fields read below) ──────────────────────────────────

// Every admin-API response: `{ status: 'success', data }`, or `{ status: 'error', error }`.
type RawEnvelope<T> = { status?: string; data?: T; error?: string }

export type RawAllowance = { total?: { amount?: number; unlimited?: boolean } }

// The plan's limits beside the tailnet's current counts, keyed by metric (`users`, `devices`, `subnets`, …).
// `usage` also carries a `<metric>_valid` flag for the counts computed asynchronously.
export type RawBillingUsage = {
  allowance?: Record<string, RawAllowance>
  usage?: Record<string, number | boolean>
}

export type RawLineItem = {
  amount?: number // cents; negative for the credit on a proration
  description?: string
  periodStart?: number // epoch ms
  periodEnd?: number // epoch ms
  quantity?: number
}

export type RawTaxAmount = { amount?: number; displayName?: string; percentage?: number }

export type RawUpcomingInvoice = {
  dueDate?: number // epoch ms
  subtotal?: number // cents
  tax?: number // cents
  total?: number // cents
  lineItems?: RawLineItem[]
  totalTaxAmounts?: RawTaxAmount[]
}

export type RawSubscriptionItem = { productName?: string; readableProductID?: string; quantity?: number }

export type RawSubscription = {
  status?: string
  readableProductID?: string
  currentPeriodStart?: number // epoch ms
  currentPeriodEnd?: number // epoch ms
  // Keyed by Stripe price id; the plan's own item shares the subscription's readableProductID.
  items?: Record<string, RawSubscriptionItem>
  billingCard?: { brand?: string; lastFour?: string } | null
  customerDetails?: { name?: string; email?: string } | null
  upcomingInvoice?: RawUpcomingInvoice | null
}

export type RawSubscriptionData = {
  subscription?: RawSubscription | null
  billingUsage?: RawBillingUsage | null
}

export type RawInvoice = {
  id?: string
  created?: string // ISO instant
  status?: string
  total?: number // cents
  // A pay.stripe.com link that redirects to the signed PDF; it needs no Tailscale session.
  invoicePDFUrl?: string
}

export type RawInvoiceList = { invoices?: RawInvoice[] | null }

// Summary + Billing share this bundle; its subscription read is the one Usage makes, so the query cache serves both.
export type RawTailscaleBilling = { subscription: RawSubscriptionData; invoices: RawInvoiceList }

export type RawUser = {
  id?: string
  stableId?: string
  displayName?: string
  loginName?: string
  role?: string
  created?: string // ISO instant, nanosecond precision
  lastSeen?: string // ISO instant
  deviceCount?: number
}

export type RawUserList = { users?: RawUser[] | null }

export type RawKey = {
  id?: string
  keyType?: string // 'auth' | 'api' | 'client' | 'federated'
  description?: string
  creator?: string
  created?: string // ISO instant
  expires?: string // ISO instant
  revoked?: string // ISO instant, present once revoked
  invalid?: boolean // expired or revoked
  capabilities?: {
    devices?: { create?: { reusable?: boolean; ephemeral?: boolean; preauthorized?: boolean; tags?: string[] } }
  }
  tags?: string[] // an OAuth client's tags
}

export type RawKeyList = { keys?: RawKey[] | null }

// ── types: normalized billing (DOLLARS, 'YYYY-MM-DD' days) ───────────────────────────

export type TailscaleInvoice = {
  id: string
  date?: string
  status: string
  amount: number
  pdfUrl: string | null
}

export type TailscaleLine = {
  description: string
  period: string | null
  quantity: number
  amount: number
}

export type TailscaleBilling = {
  plan: string | null
  status: string | null
  seats: number | null
  devices: number | null
  periodStart?: string
  periodEnd?: string
  nextInvoiceDate?: string
  nextSubtotal: number | null
  nextTax: number | null
  nextTotal: number | null
  taxRates: string | null
  lines: TailscaleLine[]
  card: { brand: string; last4: string } | null
  contactName: string | null
  contactEmail: string | null
  invoices: TailscaleInvoice[] // newest-first
}

// ── shared: the admin API ────────────────────────────────────────────────────────────

const apiGet = async <T>(client: ButinClient, path: string): Promise<T> => {
  const body = await client.get<RawEnvelope<T>>(path)

  if (body?.status !== 'success' || body.data == null) {
    throw new Error(`Tailscale: ${body?.error ?? 'unexpected response'} (${path})`)
  }

  return body.data
}

// A signed-out request and a role-gated one both answer 403. Re-reading the session tells them apart: when /self
// still answers, the 403 is the role's, so it surfaces as a status-less permission error that leaves the session in
// place; when /self 403s too, that rejection propagates and clears the dead session.
const readAdmin = async <T>(client: ButinClient, path: string): Promise<T> => {
  try {
    return await apiGet<T>(client, path)
  } catch (err) {
    if ((err as { status?: number }).status !== 403) {
      throw err
    }

    await apiGet(client, SELF)

    throw new Error(`Tailscale: your role on this tailnet can't read ${path}`)
  }
}

// The Go backend sends its zero time (`0001-01-01T00:00:00Z`) for an instant that was never set.
const instantDay = (value?: string | null): string | null =>
  value && !value.startsWith('0001-') ? (dayOf(value) ?? null) : null

// --- billing: Summary + Billing ------------------------------------------------------

export const buildTailscaleBilling = (raw: RawTailscaleBilling): TailscaleBilling => {
  const sub = raw.subscription.subscription ?? {}
  const next = sub.upcomingInvoice
  const items = Object.values(sub.items ?? {})
  const planItem = items.find((i) => i.readableProductID === sub.readableProductID) ?? items[0]
  const devices = raw.subscription.billingUsage?.usage?.devices
  const card = sub.billingCard
  const taxRates = (next?.totalTaxAmounts ?? [])
    .filter((t) => t.displayName)
    .map((t) => (t.percentage != null ? `${t.displayName} ${t.percentage}%` : t.displayName))
    .join(' · ')

  return {
    plan: planItem?.productName ?? (sub.readableProductID ? startCase(sub.readableProductID) : null),
    status: sub.status ?? null,
    seats: planItem?.quantity ?? null,
    devices: typeof devices === 'number' ? devices : null,
    periodStart: epochMsDay(sub.currentPeriodStart),
    periodEnd: epochMsDay(sub.currentPeriodEnd),
    nextInvoiceDate: epochMsDay(next?.dueDate),
    nextSubtotal: next ? centsToMajor(next.subtotal) : null,
    nextTax: next ? centsToMajor(next.tax) : null,
    nextTotal: next ? centsToMajor(next.total) : null,
    taxRates: taxRates || null,
    lines: (next?.lineItems ?? []).map((l) => {
      const start = epochMsDay(l.periodStart)
      const end = epochMsDay(l.periodEnd)

      return {
        description: l.description ?? '',
        period: start && end ? `${start} → ${end}` : null,
        quantity: l.quantity ?? 0,
        amount: centsToMajor(l.amount)
      }
    }),
    card: card?.brand && card.lastFour ? { brand: startCase(card.brand), last4: card.lastFour } : null,
    contactName: sub.customerDetails?.name || null,
    contactEmail: sub.customerDetails?.email || null,
    invoices: (raw.invoices.invoices ?? [])
      .filter((i): i is RawInvoice & { id: string } => !!i.id)
      .map((i) => ({
        id: i.id,
        date: instantDay(i.created) ?? undefined,
        status: i.status ?? 'unknown',
        amount: centsToMajor(i.total),
        pdfUrl: i.invoicePDFUrl || null
      }))
      .sort(byDayDesc)
  }
}

// Summary — this month's invoiced spend (the Overview rollup), the monthly chart, and the plan at a glance.
export const buildTailscaleSummary = (report: TailscaleBilling): CapabilityResult => {
  // A voided or draft invoice never charged anything, so it stays out of the spend series.
  const charged = report.invoices.filter((i) => i.status !== 'void' && i.status !== 'draft')

  return billing.summary({
    currentMtd: billing.invoicedMtd(charged),
    plan: report.plan ?? undefined,
    invoices: charged,
    stats: [
      {
        key: 'nextInvoice',
        label: 'Next invoice',
        role: 'money',
        value: report.nextTotal,
        caption: report.nextInvoiceDate ? `due ${report.nextInvoiceDate}` : undefined
      },
      { key: 'seats', label: 'Seats', role: 'count', value: report.seats },
      { key: 'devices', label: 'Devices', role: 'count', value: report.devices }
    ]
  })
}

type SubscriptionRow = {
  plan: string | null
  status: string | null
  seats: number | null
  period: string | null
  nextInvoiceDate: string | null
  nextSubtotal: number | null
  nextTax: number | null
  taxRates: string | null
  nextTotal: number | null
  contactName: string | null
  contactEmail: string | null
}

type InvoiceRow = {
  id: string
  date: string | null
  amount: number
  status: string
  pdfUrl: string | null
  name: string
}

// Billing — the subscription and the invoice it is building toward, the payment card, and the downloadable invoices.
export const buildTailscaleBillingTab = (report: TailscaleBilling): CapabilityResult => {
  const subscription = record<SubscriptionRow>({
    id: 'subscription',
    fields: [
      { key: 'plan', label: 'Plan', role: 'label' },
      { key: 'status', label: 'Status', role: 'status' },
      { key: 'seats', label: 'Seats', role: 'count' },
      { key: 'period', label: 'Billing period', role: 'text' },
      { key: 'nextInvoiceDate', label: 'Next invoice', role: 'timestamp' },
      { key: 'nextSubtotal', label: 'Next invoice subtotal', role: 'money' },
      { key: 'nextTax', label: 'Tax', role: 'money' },
      { key: 'taxRates', label: 'Tax rates', role: 'text' },
      { key: 'nextTotal', label: 'Next invoice total', role: 'money' },
      { key: 'contactName', label: 'Billing contact', role: 'label' },
      { key: 'contactEmail', label: 'Billing email', role: 'identifier' }
    ],
    value: {
      plan: report.plan,
      status: report.status,
      seats: report.seats,
      period: report.periodStart && report.periodEnd ? `${report.periodStart} → ${report.periodEnd}` : null,
      nextInvoiceDate: report.nextInvoiceDate ?? null,
      nextSubtotal: report.nextSubtotal,
      nextTax: report.nextTax,
      taxRates: report.taxRates,
      nextTotal: report.nextTotal,
      contactName: report.contactName,
      contactEmail: report.contactEmail
    }
  })

  // The upcoming invoice carries only Stripe's first page of lines, so the rows need not add up to its subtotal —
  // the totals above come from the invoice itself.
  const lines = table<TailscaleLine>({
    id: 'nextInvoiceLines',
    columns: [
      { key: 'description', label: 'Line item', role: 'text', truncate: true },
      { key: 'period', label: 'Period', role: 'text' },
      { key: 'quantity', label: 'Qty', role: 'count' },
      { key: 'amount', label: 'Amount', role: 'money' }
    ],
    rows: report.lines
  })

  const invoices = table<InvoiceRow>({
    id: 'invoices',
    columns: [
      { key: 'date', label: 'Date', role: 'timestamp' },
      { key: 'amount', label: 'Amount', role: 'money' },
      { key: 'status', label: 'Status', role: 'status' },
      { key: 'pdfUrl', role: 'url', hidden: true },
      { key: 'name', role: 'label', hidden: true },
      { key: 'id', role: 'identifier', hidden: true }
    ],
    rows: report.invoices.map((i) => ({
      id: i.id,
      date: i.date ?? null,
      amount: i.amount,
      status: i.status,
      pdfUrl: i.pdfUrl,
      name: `Tailscale invoice ${i.date ?? i.id}`
    })),
    key: 'id'
  })

  return capabilityResult({
    sections: [
      subscription.keyvalue({ title: 'Subscription' }),
      report.card ? blocks.paymentMethod(report.card) : null,
      report.lines.length > 0 ? lines.table({ title: 'Next invoice line items' }) : null,
      invoices.fileTable({ title: 'Invoices', name: 'name', source: { fetch: true }, ext: 'pdf', category: 'Invoices' })
    ]
  })
}

const fetchTailscaleBilling = async (ctx: CollectContext): Promise<RawTailscaleBilling> => {
  const [subscription, invoices] = await Promise.all([
    readAdmin<RawSubscriptionData>(ctx.client, SUBSCRIPTION),
    readAdmin<RawInvoiceList>(ctx.client, INVOICES)
  ])

  return { subscription, invoices }
}

// The PDF link redirects to a short-lived signed S3 object. Neither hop needs the Tailscale session, so the cookie
// stays off both rather than travelling to Stripe.
const fetchTailscaleInvoicePdf = async (ctx: CollectContext, row: Record<string, unknown>): Promise<Uint8Array> => {
  const url = typeof row.pdfUrl === 'string' ? row.pdfUrl : ''

  if (!url) {
    throw new Error('Tailscale: this invoice has no PDF link')
  }

  const res = await ctx.client.request<ArrayBuffer>({
    url,
    responseType: 'arraybuffer',
    sendAuth: false,
    sendCookie: false,
    headers: { Accept: 'application/pdf,*/*' }
  })
  const bytes = new Uint8Array(res.data)

  if (!isPdfBytes(bytes)) {
    throw new Error('Tailscale: the invoice link did not return a PDF')
  }

  return bytes
}

// --- usage: the plan's limits against the tailnet's counts ---------------------------

// Display order for the metrics Tailscale meters; an allowance key outside this list is appended, title-cased.
const USAGE_METRICS: { key: string; label: string; unit?: string }[] = [
  { key: 'users', label: 'Users' },
  { key: 'occupied_seats', label: 'Occupied seats' },
  { key: 'active_users', label: 'Active users' },
  { key: 'active_users_28_days', label: 'Active users (28 days)' },
  { key: 'admin_users', label: 'Admins' },
  { key: 'devices', label: 'Devices' },
  { key: 'tag_devices', label: 'Tagged devices' },
  { key: 'subnets', label: 'Subnet routers' },
  { key: 'ephemeral_minutes', label: 'Ephemeral node time', unit: 'minutes' },
  { key: 'pam_seats', label: 'PAM seats' },
  { key: 'acl_named_users', label: 'Users named in ACLs' }
]

export const buildTailscaleUsage = (raw: RawSubscriptionData): CapabilityResult => {
  const allowance = raw.billingUsage?.allowance ?? {}
  const counts = raw.billingUsage?.usage ?? {}
  const listed = new Set(USAGE_METRICS.map((m) => m.key))
  const extra = Object.keys(allowance)
    .filter((key) => !listed.has(key))
    .map((key) => ({ key, label: startCase(key), unit: undefined }))

  return usage.result({
    metrics: [...USAGE_METRICS, ...extra].flatMap(({ key, label, unit }) => {
      const value = counts[key]

      // A count still being computed arrives flagged invalid — a placeholder, not a reading.
      if (typeof value !== 'number' || counts[`${key}_valid`] === false) {
        return []
      }

      const total = allowance[key]?.total

      return [{ label, value, unit, limit: total && !total.unlimited ? (total.amount ?? null) : null }]
    })
  })
}

// --- members: the tailnet's users ----------------------------------------------------

type MemberRow = {
  id: string
  name: string
  email: string | null
  role: string | null
  devices: number
  lastSeen: string | null
  joined: string | null
}

export const buildTailscaleMembers = (raw: RawUserList): CapabilityResult => {
  const rows = (raw.users ?? [])
    .flatMap((u): MemberRow[] => {
      const id = u.stableId || u.id

      if (!id) {
        return []
      }

      return [
        {
          id,
          name: u.displayName || u.loginName || id,
          email: u.loginName || null,
          role: u.role || null,
          devices: u.deviceCount ?? 0,
          lastSeen: instantDay(u.lastSeen),
          joined: instantDay(u.created)
        }
      ]
    })
    .sort((a, b) => a.name.localeCompare(b.name))

  const roster = table<MemberRow>({
    id: 'members',
    columns: [
      { key: 'name', label: 'Name', role: 'label' },
      { key: 'email', label: 'Email', role: 'identifier' },
      { key: 'role', label: 'Role', role: 'category' },
      { key: 'devices', label: 'Devices', role: 'count' },
      { key: 'lastSeen', label: 'Last seen', role: 'timestamp' },
      { key: 'joined', label: 'Joined', role: 'timestamp' }
    ],
    rows,
    key: 'id',
    // The user list is the complete roster: someone it stops returning has left the tailnet.
    retention: 'snapshot'
  })

  return capabilityResult({ sections: [roster.table({ title: 'Members' })] })
}

// --- keys: auth keys, API tokens, OAuth clients --------------------------------------

const KEY_TYPES: Record<string, string> = {
  auth: 'Auth key',
  api: 'API access token',
  client: 'OAuth client',
  federated: 'Federated identity'
}

type KeyRow = {
  id: string
  description: string | null
  type: string
  creator: string | null
  created: string | null
  expires: string | null
  status: string
  options: string | null
  tags: string | null
}

export const buildTailscaleKeys = (raw: RawKeyList): CapabilityResult => {
  const rows = (raw.keys ?? [])
    .filter((k): k is RawKey & { id: string } => !!k.id)
    .map((k): KeyRow => {
      const create = k.capabilities?.devices?.create
      const options = [
        create?.reusable && 'reusable',
        create?.ephemeral && 'ephemeral',
        create?.preauthorized && 'pre-approved'
      ].filter(Boolean)
      const tags = create?.tags ?? k.tags ?? []

      return {
        id: k.id,
        description: k.description || null,
        type: KEY_TYPES[k.keyType ?? ''] ?? startCase(k.keyType || 'key'),
        creator: k.creator || null,
        created: instantDay(k.created),
        expires: instantDay(k.expires),
        // `invalid` covers both ends of a key's life; a revocation instant tells the two apart.
        status: k.revoked ? 'revoked' : k.invalid ? 'expired' : 'active',
        options: options.length > 0 ? options.join(' · ') : null,
        tags: tags.length > 0 ? tags.join(', ') : null
      }
    })
    .sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''))

  const keys = table<KeyRow>({
    id: 'keys',
    columns: [
      { key: 'description', label: 'Description', role: 'label', truncate: true },
      { key: 'id', label: 'Key ID', role: 'identifier' },
      { key: 'type', label: 'Type', role: 'category' },
      { key: 'creator', label: 'Created by', role: 'identifier' },
      { key: 'created', label: 'Created', role: 'timestamp' },
      { key: 'expires', label: 'Expires', role: 'timestamp' },
      { key: 'status', label: 'Status', role: 'status' },
      { key: 'options', label: 'Options', role: 'text' },
      { key: 'tags', label: 'Tags', role: 'text' }
    ],
    rows,
    key: 'id',
    // The list is every key the tailnet still holds, expired and revoked included; a key it omits was deleted.
    retention: 'snapshot'
  })

  return capabilityResult({ sections: [keys.table({ title: 'Keys' })] })
}

// ── descriptor ──────────────────────────────────────────────────────────────────────

export const tailscalePlugin = definePlugin({
  reportingCurrency: 'USD',
  meta: {
    id: 'tailscale',
    name: 'Tailscale',
    vendor: 'Tailscale',
    category: 'devtools',
    color: '#242424',
    homepage: 'https://tailscale.com',
    dashboardUrl: `${CONSOLE_ORIGIN}/admin`,
    description: 'Tailscale tailnet — plan and invoices, usage against plan limits, users, and auth keys.'
  },
  session: {
    // A signed-out visit to the console bounces through login.tailscale.com and lands back on /admin.
    loginUrl: `${CONSOLE_ORIGIN}/admin`,
    dashboardMarkers: ['console.tailscale.com/admin'],
    cookieDomains: ['tailscale.com'],
    // The console shell renders before its sign-in redirect, so the marker alone matches a signed-out page.
    requiredCookie: 'tailcontrol',
    // The per-attempt state cookie of a social sign-in: one left behind by an abandoned attempt fails the next
    // attempt's OAuth state check.
    clearCookiesBeforeCapture: ['tailscale-authstate2-*']
  },
  // A signed-out request answers 403 (see readAdmin for how a role-gated 403 is kept from clearing the session).
  auth: { kind: 'cookie', clearOnStatuses: [401, 403] },
  transport: {
    baseUrl: API_BASE,
    defaultHeaders: {
      Accept: 'application/json, text/plain, */*',
      Origin: CONSOLE_ORIGIN,
      Referer: `${CONSOLE_ORIGIN}/`,
      'Sec-Fetch-Site': 'same-site',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty'
    }
  },
  capabilities: [
    defineCapability({
      id: 'summary',
      label: 'Summary',
      fetch: fetchTailscaleBilling,
      build: (raw) => buildTailscaleSummary(buildTailscaleBilling(raw)),
      sample: sampleTailscaleBilling
    }),
    defineCapability({
      id: 'billing',
      label: 'Billing',
      fetch: fetchTailscaleBilling,
      build: (raw) => buildTailscaleBillingTab(buildTailscaleBilling(raw)),
      sample: sampleTailscaleBilling,
      fetchFile: fetchTailscaleInvoicePdf
    }),
    defineCapability({
      id: 'usage',
      label: 'Usage',
      fetch: (ctx) => readAdmin<RawSubscriptionData>(ctx.client, SUBSCRIPTION),
      build: buildTailscaleUsage,
      sample: sampleTailscaleSubscription
    }),
    defineCapability({
      id: 'members',
      label: 'Members',
      fetch: (ctx) => readAdmin<RawUserList>(ctx.client, USERS),
      build: buildTailscaleMembers,
      sample: sampleTailscaleUsers
    }),
    defineCapability({
      id: 'keys',
      label: 'Keys',
      fetch: (ctx) => readAdmin<RawKeyList>(ctx.client, KEYS),
      build: buildTailscaleKeys,
      sample: sampleTailscaleKeys
    })
  ],
  // The signed-in user's own profile — readable by every role, and a 403 once the session is gone.
  probe: async (ctx) => {
    await apiGet(ctx.client, SELF)
  }
})
