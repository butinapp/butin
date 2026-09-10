import { defineCapability, defineConfigSchema, definePlugin, type CollectContext, type ConfigOf } from '@butinapp/sdk'
import { addSections, capabilityResult, record, table, type CapabilityResult } from '@butinapp/sdk/data'
import { billing, keys, members, usage, type ApiKeysInput, type MembersInput } from '@butinapp/sdk/presets'
import {
  MS_PER_DAY,
  byDayAsc,
  byDayDesc,
  centsToMajor,
  epochSecDay,
  isoDay,
  monthMinus,
  normalizeCurrency,
  round2
} from '@butinapp/sdk/util'

import { sampleCerebrasBilling, sampleCerebrasKeys, sampleCerebrasMembers, sampleCerebrasUsage } from './sample.js'

// Cerebras Cloud (cloud.cerebras.ai — LLM inference). One captured session (the NextAuth `authjs.session-token`
// cookie), one browser-engine transport (Electron, real browser identity), two read shapes:
//   1. GraphQL /api/graphql — API keys, request-volume metrics, rate-limit quotas, model catalog, members.
//   2. Next.js Server Actions on the billing pages — every $ figure (credits, accrued usage, invoices, the
//      Stripe customer) lives ONLY here, behind per-deploy ROTATING `Next-Action` hashes. The hashes aren't in
//      the RSC payload, so we rediscover them each run: fetch the billing pages' JS chunks and read the stable
//      action NAME off each `createServerReference("<hash>", …, "<name>")` call, then POST the action by name to
//      the sub-route whose chunk declared it (a Next action only resolves on the route that registers it).
//
// MONEY is Stripe cents everywhere → centsToMajor. The account/org id is auto-captured from the dashboard URL.
//
// SERVER-ACTION ORIGIN CAVEAT: Next's action handler checks the `Origin` header (CSRF), which Electron's
// net.request can't set. We send it per-call anyway (dropped harmlessly if forbidden); a same-origin request
// with no Origin is accepted by Next here. If a deploy ever rejects it, route these POSTs through ctx.browser.

const ORIGIN = 'https://cloud.cerebras.ai'
const GQL = `${ORIGIN}/api/graphql`
const HTTP_CODES = ['200', '4xx', '5xx']
const INPUT_TYPES = ['image', 'text']
const WINDOW_DAYS = 30

// The billing sub-routes whose JS chunks declare the billing server actions (Summary + invoices + credits +
// payment). We scan their chunks for action hashes, and POST each action back to the sub-route that declared it.
const BILLING_PATHS = ['/billing', '/billing/payment', '/billing/credits']

// ── types (the data dictionary) ──────────────────────────────────────────────────────

// billing
export type RawCerebrasInvoice = {
  created?: number // epoch seconds
  status?: string
  total?: number // cents — the dashboard figure (NOT amount_paid)
  amount_due?: number // cents — fallback when `total` is absent
  currency?: string
  number?: string
  hosted_invoice_url?: string | null
  invoice_pdf?: string | null // direct PDF (the download source); hosted_invoice_url is the Stripe-hosted page
}
export type RawLineItem = {
  amount?: number // cents
  description?: string
}
export type RawCreditBalance = {
  available?: number
  ledger?: number
} // cents
export type RawCustomer = {
  balance?: number // cents
  email?: string
  delinquent?: boolean
  currency?: string
}
export type RawCreditGrant = {
  name?: string
  category?: string
  amount?: number // cents — granted
  available?: number // cents — remaining
  currency?: string
  effective_at?: number // epoch seconds
  expires_at?: number | null // epoch seconds
}

export type CerebrasInvoice = {
  date?: string
  number?: string
  status: string
  amount: number
  hostedUrl?: string | null
  pdfUrl?: string | null
}
export type CerebrasCreditGrant = {
  name: string
  category: string
  granted: number
  available: number
  effective?: string
  expires?: string
}
export type CerebrasBilling = {
  invoices: CerebrasInvoice[]
  currentSpend: number
  currentBreakdown: Array<{ label: string; amount: number }>
  creditsAvailable: number
  creditsLedger: number
  creditGrants: CerebrasCreditGrant[]
  accountBalance: number
  accountEmail?: string
  delinquent: boolean
  currency: string
  latestAmount: number
}

// The raw billing wire bundle a capability's fetch returns: the five server-action payloads buildCerebrasBilling
// composes. Summary + Billing both fetch this; the query cache dedupes the underlying chunk GETs + action POSTs.
export type CerebrasBillingRaw = {
  invoices: RawCerebrasInvoice[] | null
  upcoming: RawLineItem[] | null
  balance: RawCreditBalance | null
  customer: RawCustomer | null
  grants: RawCreditGrant[] | null
}

const billingFromRaw = (raw: CerebrasBillingRaw): CerebrasBilling =>
  buildCerebrasBilling(raw.invoices, raw.upcoming, raw.balance, raw.customer, raw.grants)

// keys
export type RawCerebrasApiKey = {
  id?: string
  name?: string
  secretKey?: string
  projectName?: string
  projectId?: string
  state?: string
  createdAt?: string
  lastUsedAt?: string | null
}

// members
export type RawCerebrasMember = {
  user?: { id?: string; name?: string; email?: string }
  role?: string
}

// usage
export type RawModel = {
  id?: string
  name?: string
  deprecated?: boolean
}
export type RawQuota = {
  modelId?: string
  requestsPerMinute?: string
  tokensPerMinute?: string
  requestsPerDay?: string
  maxCompletionTokens?: string
}
export type RawGraphPoint = {
  timeWindow?: string
  requestCount?: number
}
export type CerebrasModelQuota = {
  modelId: string
  name: string
  rpm: number
  tpm: number
  rpd: number
  maxCompletion: number
}
export type CerebrasUsage = {
  totalRequests: number
  daily: Array<{ date: string; requests: number }>
  models: CerebrasModelQuota[]
  modelCount: number
  periodStart?: string
  periodEnd?: string
}

// ── server-action discovery + invocation ─────────────────────────────────────────────
// Next.js server-action ids rotate per deploy, so they can't be hardcoded. The client chunks register each
// action via `createServerReference("<40-hex-hash>", callServer, undefined, findSourceMapURL, "<actionName>")`
// — the name is stable, the hash is the current id. We fetch the billing pages, follow their chunk <script>s,
// and build a name→{hash, route} map, then POST each action to the sub-route that declared it.

const CHUNK_RE = /\/_next\/static\/chunks\/[\w./%-]+?\.js/g
const SERVER_REF_RE = /createServerReference\)\(\s*"([0-9a-f]{40,})"[^)]*?,\s*"([A-Za-z0-9_$]+)"\s*\)/g

// Bound chunk fetching so a pathological deploy can't fan out unboundedly; the needed actions sit in the first
// handful of billing chunks in practice.
const MAX_CHUNKS = 48

const billingUrl = (org: string, path = '/billing'): string => `${ORIGIN}/platform/${org}${path}`

// A Next server action only resolves on a route whose bundle REGISTERS it: posting an action id to a route that
// doesn't own it makes Next re-render that page instead of running the action, so the flight carries the page
// tree (no result) rather than the action's return value — a silent empty. So each action is POSTed to the
// billing sub-route whose chunk declared it (`getCustomerBillingId` on /billing, `listCustomerInvoices` on
// /billing/payment, `listCreditGrantHistory` on /billing/credits, …), captured alongside its hash at discovery.
type ActionRoute = {
  url: string
  tree: string
}

// A discovered action: its rotating per-deploy id (`hash`) and the billing sub-route that registers it (`path`).
type ActionEntry = {
  hash: string
  path: string
}

// The terminal segment of a router-state-tree (`__PAGE__`); trailing markers are cosmetic cache hints.
const leaf = { children: ['__PAGE__', {}, null, null, 0] }

// The router-state-tree + url for a billing sub-route (`/billing`, `/billing/payment`, `/billing/credits`),
// nesting each path segment under platform/<org> down to the page leaf.
const billingRouteFor = (org: string, path: string): ActionRoute => {
  const branch = path
    .replace(/^\//, '')
    .split('/')
    .reduceRight<unknown>((child, seg) => ({ children: [seg, child] }), leaf)

  return {
    url: billingUrl(org, path),
    tree: encodeURIComponent(
      JSON.stringify(['', { children: ['platform', { children: [['organizationId', org, 'd', null], branch] }] }])
    )
  }
}

// A per-deploy fingerprint: the billing layout chunk's content hash (rotates on every deploy), else the Next
// buildId. Used to reuse a discovered action map across refreshes until the deployment changes.
const deployFingerprint = (html: string): string =>
  html.match(/static\/chunks\/app\/platform\/[^"']*billing\/layout-[0-9a-f]+\.js/)?.[0] ??
  html.match(/"buildId":"([^"]+)"/)?.[1] ??
  ''

// Resolve action name→{hash, path}, reusing the cached map while the deployment is unchanged so a refresh costs
// ONE page GET (the fingerprint) and no chunk sweep. On a new deploy (or first run) it rediscovers + recaches.
const loadActionMap = async (ctx: CollectContext, org: string, needed: string[]): Promise<Map<string, ActionEntry>> => {
  const fingerprint = deployFingerprint(await ctx.client.getText(billingUrl(org)).catch(() => ''))
  const cached = ctx.creds.get('actionRoutes')

  if (fingerprint && ctx.creds.get('actionsDeploy') === fingerprint && cached) {
    try {
      const map = new Map<string, ActionEntry>(Object.entries(JSON.parse(cached) as Record<string, ActionEntry>))

      if (needed.every((n) => map.get(n)?.hash && map.get(n)?.path)) {
        return map
      }
    } catch {
      // fall through to rediscover
    }
  }

  // The /billing GET inside discoverActions is served from the query cache (same URL just fetched).
  const map = await discoverActions(ctx, org, needed)

  if (fingerprint && needed.every((n) => map.has(n))) {
    ctx.creds.set('actionsDeploy', fingerprint)
    ctx.creds.set('actionRoutes', JSON.stringify(Object.fromEntries(map)))
  }

  return map
}

// Walk the billing pages' chunks, reading action name→{hash, path} off each createServerReference call, tagging
// each with the sub-route being scanned (the route that registers it). Stops as soon as every requested name is
// resolved (the cheap common case), capped at MAX_CHUNKS overall.
const discoverActions = async (
  ctx: CollectContext,
  org: string,
  needed: string[]
): Promise<Map<string, ActionEntry>> => {
  const map = new Map<string, ActionEntry>()
  const done = (): boolean => needed.every((n) => map.has(n))
  const scanned = new Set<string>()
  let budget = MAX_CHUNKS

  for (const path of BILLING_PATHS) {
    if (done()) {
      break
    }

    const html = await ctx.client.getText(billingUrl(org, path)).catch(() => '')

    for (const chunk of new Set(html.match(CHUNK_RE) ?? [])) {
      if (done() || budget <= 0) {
        break
      }

      if (scanned.has(chunk)) {
        continue
      }

      scanned.add(chunk)
      budget--
      const js = await ctx.client.getText(`${ORIGIN}${chunk}`).catch(() => '')

      for (const m of js.matchAll(SERVER_REF_RE)) {
        if (needed.includes(m[2]) && !map.has(m[2])) {
          map.set(m[2], { hash: m[1], path })
        }
      }
    }
  }

  const missing = needed.filter((n) => !map.has(n))

  if (missing.length) {
    ctx.log(`cerebras: server actions not found in deploy chunks: ${missing.join(', ')}`)
  }

  return map
}

// A Next server-action POST returns an RSC flight stream of `<id>:<payload>` lines. The action's return value
// is the row referenced by an envelope `{"a":"$@<ref>"}` (re-render) or, absent that, the first concrete row.
// A large payload is split across rows that cross-reference each other: a string `"$<id>"`/`"$@<id>"` points at
// another row, `"$$x"` escapes a literal `$x`, `"$undefined"` is undefined. Resolve those references
// recursively so the caller gets a fully-materialized value. Returns null for an HTML/non-flight body.
export const parseFlightResult = <T>(text: string): T | null => {
  const rows = new Map<string, string>()

  for (const line of text.split('\n')) {
    const i = line.indexOf(':')

    if (i > 0 && /^[0-9a-f]+$/.test(line.slice(0, i))) {
      rows.set(line.slice(0, i), line.slice(i + 1))
    }
  }

  if (rows.size === 0) {
    return null
  }

  const cache = new Map<string, unknown>()

  const resolveValue = (v: unknown): unknown => {
    if (typeof v === 'string') {
      if (v === '$undefined') {
        return undefined
      }

      if (v.startsWith('$$')) {
        return v.slice(1)
      }

      if (v.startsWith('$@') && /^[0-9a-f]+$/.test(v.slice(2))) {
        return resolveRow(v.slice(2))
      }

      if (/^\$[0-9a-f]+$/.test(v)) {
        return resolveRow(v.slice(1))
      }

      return v
    }

    if (Array.isArray(v)) {
      return v.map(resolveValue)
    }

    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, resolveValue(val)]))
    }

    return v
  }

  function resolveRow(id: string): unknown {
    if (cache.has(id)) {
      return cache.get(id)
    }

    const raw = rows.get(id)

    if (raw === undefined) {
      return undefined
    }

    cache.set(id, undefined) // cycle guard
    let parsed: unknown

    try {
      parsed = JSON.parse(raw)
    } catch {
      return undefined
    }

    const resolved = resolveValue(parsed)

    cache.set(id, resolved)

    return resolved
  }

  // The result row: the envelope's `$@<ref>`, else the first concrete (non-module, non-envelope) row.
  for (const raw of rows.values()) {
    const ref = raw.match(/^\{"a":"\$@([0-9a-f]+)"/)?.[1]

    if (ref) {
      return (resolveRow(ref) ?? null) as T | null
    }
  }

  for (const [id, raw] of rows) {
    if (raw && !raw.startsWith('I[') && !raw.startsWith('"$') && !raw.startsWith('{"a":"$@')) {
      return (resolveRow(id) ?? null) as T | null
    }
  }

  return null
}

const callAction = async <T>(
  ctx: CollectContext<CerebrasConfig>,
  org: string,
  actions: Map<string, ActionEntry>,
  name: string,
  args: unknown[]
): Promise<T | null> => {
  const entry = actions.get(name)

  if (!entry) {
    return null
  }

  const { hash } = entry
  const route = billingRouteFor(org, entry.path)

  const res = await ctx.client
    .request<string>({
      url: route.url,
      method: 'POST',
      headers: {
        'Next-Action': hash,
        'Next-Router-State-Tree': route.tree,
        'Content-Type': 'text/plain;charset=UTF-8',
        Accept: 'text/x-component',
        Origin: ORIGIN,
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Dest': 'empty'
      },
      body: JSON.stringify(args),
      referer: route.url,
      responseType: 'text'
    })
    .catch((err: Error) => {
      ctx.log(`cerebras: action ${name} failed — ${err.message}`)

      return null
    })

  if (!res) {
    return null
  }

  const result = parseFlightResult<T>(res.data)

  if (result === null) {
    ctx.log(`cerebras: action ${name} (${hash}) returned no parseable result`, {
      status: res.status,
      body: res.data.slice(0, 600)
    })
  }

  return result
}

// ── billing ───────────────────────────────────────────────────────────────────────────

// Coerce a Stripe-collection field to an array — a server action may hand back `{data}` or null where a list
// was expected, and a missing/odd shape should degrade to empty rather than throw.
const asArray = <T>(v: T[] | null | undefined): T[] => (Array.isArray(v) ? v : [])

// Money is Stripe cents → dollars. currentSpend (the open period's accrued upcoming-invoice line items) is the
// live MTD; invoices are historical (top-ups for prepaid accounts, monthly bills for postpaid).
export const buildCerebrasBilling = (
  rawInvoices: RawCerebrasInvoice[] | null | undefined,
  rawUpcoming: RawLineItem[] | null | undefined,
  rawBalance: RawCreditBalance | null | undefined,
  rawCustomer: RawCustomer | null | undefined,
  rawGrants: RawCreditGrant[] | null | undefined = null
): CerebrasBilling => {
  const invoices: CerebrasInvoice[] = asArray(rawInvoices)
    .map((inv) => ({
      date: epochSecDay(inv.created),
      number: inv.number,
      status: inv.status ?? 'unknown',
      amount: centsToMajor(inv.total ?? inv.amount_due),
      hostedUrl: inv.hosted_invoice_url || undefined,
      pdfUrl: inv.invoice_pdf || undefined
    }))
    .sort(byDayDesc)

  const byLabel = new Map<string, number>()

  for (const li of asArray(rawUpcoming)) {
    const label = li.description ?? 'usage'

    byLabel.set(label, (byLabel.get(label) ?? 0) + (li.amount ?? 0))
  }

  const currentBreakdown = [...byLabel.entries()]
    .map(([label, cents]) => ({ label, amount: centsToMajor(cents) }))
    .sort((a, b) => b.amount - a.amount)

  const creditGrants: CerebrasCreditGrant[] = asArray(rawGrants).map((g) => ({
    name: g.name || 'Credits',
    category: g.category ?? 'paid',
    granted: centsToMajor(g.amount),
    available: centsToMajor(g.available),
    effective: epochSecDay(g.effective_at),
    expires: g.expires_at ? epochSecDay(g.expires_at) : undefined
  }))

  return {
    invoices,
    currentSpend: round2(currentBreakdown.reduce((sum, l) => sum + l.amount, 0)),
    currentBreakdown,
    creditsAvailable: centsToMajor(rawBalance?.available),
    creditsLedger: centsToMajor(rawBalance?.ledger),
    creditGrants,
    accountBalance: centsToMajor(rawCustomer?.balance),
    accountEmail: rawCustomer?.email,
    delinquent: rawCustomer?.delinquent ?? false,
    currency: normalizeCurrency(rawInvoices?.[0]?.currency ?? rawCustomer?.currency),
    latestAmount: invoices[0]?.amount ?? 0
  }
}

// Summary tab — the cross-service-rollup overview (spend.mtd): the accrued-this-period headline + monthly chart
// + a tight row of headline stats. NO tables (the invoice/credit detail lives on Billing).
export const buildCerebrasSummaryResult = (billingData: CerebrasBilling): CapabilityResult =>
  billing.summary({
    // 0 stays (the Overview reads the current-month bar) rather than nulling out and dropping the service from
    // the Overview when the provider rolls its period and the open accrual is momentarily 0.
    currentMtd: billingData.currentSpend,
    currentMtdLabel: 'Accrued this period',
    // Usage-metered spend accruing live over the open period — incomparable with the lumpy invoice series, so
    // skip the month-over-month delta.
    mtdBasis: 'accrued',
    showDelta: false,
    currency: billingData.currency,
    // Invoices are created a day or two into the following month (prior period billed in arrears), so bucket
    // the chart by the incurred month — June's bill under June — leaving the open month for the live accrual
    // (seeded via backfill) instead of last period's settled total.
    invoices: billingData.invoices.map((i) => ({
      date: i.date ? monthMinus(i.date, 1) : i.date,
      amount: i.amount,
      status: i.status,
      hostedUrl: i.hostedUrl ?? null
    })),
    stats: [
      { key: 'credits', label: 'Credits available', role: 'money', value: billingData.creditsAvailable },
      { key: 'latest', label: 'Latest invoice', role: 'money', value: billingData.latestAmount }
    ]
  })

// Billing tab — the financial detail (no chart, no spend headline; Summary owns those): the account/credits
// records, the accrued line-item breakdown, the credit-grant ledger, and the downloadable invoice history.
type AccountRow = {
  email: string | null
  balance: number
  status: string
}
type LineItemRow = {
  label: string
  amount: number
}
type GrantRow = {
  name: string
  category: string
  granted: number
  available: number
  effective: string | null
  expires: string | null
}
type InvoiceRow = {
  date: string | null
  number: string
  amount: number
  status: string
  hostedUrl: string | null
  pdfUrl: string | null
  name: string
}

export const buildCerebrasBillingTab = (billing: CerebrasBilling): CapabilityResult => {
  const ccy = billing.currency

  const account = record<AccountRow>({
    id: 'account',
    fields: [
      { key: 'email', label: 'Billing email', role: 'identifier' },
      { key: 'balance', label: 'Account balance', role: 'money', currency: ccy },
      { key: 'status', label: 'Status', role: 'status' }
    ],
    value: {
      email: billing.accountEmail ?? null,
      balance: billing.accountBalance,
      status: billing.delinquent ? 'Delinquent' : 'Current'
    }
  }).keyvalue({ title: 'Account' })

  const credits = record<{ available: number; granted: number }>({
    id: 'credits',
    fields: [
      { key: 'available', label: 'Credits available', role: 'money', currency: ccy },
      { key: 'granted', label: 'Credits granted (lifetime)', role: 'money', currency: ccy }
    ],
    value: { available: billing.creditsAvailable, granted: billing.creditsLedger }
  }).keyvalue({ title: 'Credits' })

  const lineItems = table<LineItemRow>({
    id: 'lineItems',
    columns: [
      { key: 'label', label: 'Line item', role: 'label' },
      { key: 'amount', label: 'Accrued', role: 'money', currency: ccy }
    ],
    rows: billing.currentBreakdown.map((l) => ({ label: l.label, amount: l.amount }))
  }).table({ title: 'Accrued this period' })

  const grants = table<GrantRow>({
    id: 'grants',
    columns: [
      { key: 'name', label: 'Grant', role: 'label' },
      { key: 'category', label: 'Type', role: 'status' },
      { key: 'granted', label: 'Granted', role: 'money', currency: ccy },
      { key: 'available', label: 'Remaining', role: 'money', currency: ccy },
      { key: 'effective', label: 'Effective', role: 'timestamp' },
      { key: 'expires', label: 'Expires', role: 'timestamp' }
    ],
    rows: billing.creditGrants.map((g) => ({
      name: g.name,
      category: g.category,
      granted: g.granted,
      available: g.available,
      effective: g.effective ?? null,
      expires: g.expires ?? null
    }))
  }).table({ title: 'Credit grants' })

  const invoices = table<InvoiceRow>({
    id: 'invoices',
    columns: [
      { key: 'date', label: 'Date', role: 'timestamp' },
      { key: 'number', label: 'Invoice', role: 'label' },
      { key: 'amount', label: 'Amount', role: 'money', currency: ccy },
      { key: 'status', label: 'Status', role: 'status' },
      { key: 'hostedUrl', label: 'View', role: 'url' },
      { key: 'pdfUrl', role: 'url', hidden: true },
      { key: 'name', role: 'label', hidden: true }
    ],
    rows: billing.invoices.map((i) => ({
      date: i.date ?? null,
      number: i.number || '—',
      amount: i.amount,
      status: i.status,
      hostedUrl: i.hostedUrl ?? null,
      // Prefer the direct PDF for the download; the Stripe-hosted page also serves the PDF, so it's the fallback.
      pdfUrl: i.pdfUrl ?? i.hostedUrl ?? null,
      name: `Invoice ${i.number || i.date || 'unknown'}`
    })),
    // Keyed by invoice number so invoices accumulate history (a status flips over time) past the fetch window.
    key: 'number'
  }).fileTable({ title: 'Invoices', name: 'name', source: { url: 'pdfUrl' }, ext: 'pdf', category: 'Invoices' })

  return capabilityResult({
    sections: [
      account,
      credits,
      billing.currentBreakdown.length ? lineItems : null,
      billing.creditGrants.length ? grants : null,
      invoices
    ]
  })
}

// The org's Stripe customer id, from the `getCustomerBillingId([org])` action, cached: it's stable per org, so
// later refreshes skip the call.
const resolveCustomerId = async (
  ctx: CollectContext<CerebrasConfig>,
  org: string,
  actions: Map<string, ActionEntry>
): Promise<string | undefined> => {
  const cached = ctx.creds.get('customerId')

  if (cached) {
    return cached
  }

  const customerId = await callAction<string>(ctx, org, actions, 'getCustomerBillingId', [org])

  if (customerId) {
    ctx.creds.set('customerId', customerId)
  }

  return customerId ?? undefined
}

// The shared billing fetch (Summary + Billing both call it; the query cache dedupes the chunk GETs + actions).
// Returns the raw server-action bundle (build composes it). The accrued line items are org-keyed so they render
// even when the customer id can't resolve; credits / customer / invoices / grants are customer-keyed and
// best-effort so one failure doesn't blank the tab.
const fetchCerebrasBilling = async (ctx: CollectContext<CerebrasConfig>): Promise<CerebrasBillingRaw> => {
  const org = orgId(ctx)
  const actions = await loadActionMap(ctx, org, [
    'getCustomerBillingId',
    'getCreditBalanceSummary',
    'getThresholds',
    'getCurrentMonthLineItems',
    'listCustomerInvoices',
    'listCreditGrantHistory'
  ])
  const [customerId, lineItems] = await Promise.all([
    resolveCustomerId(ctx, org, actions),
    callAction<{ data?: RawLineItem[] }>(ctx, org, actions, 'getCurrentMonthLineItems', [org])
  ])

  if (!customerId) {
    ctx.log('cerebras: customer id unresolved — billing limited to accrued spend')

    return { invoices: null, upcoming: lineItems?.data ?? null, balance: null, customer: null, grants: null }
  }

  const [balance, customer, invoices, grants] = await Promise.all([
    callAction<{ data?: RawCreditBalance }>(ctx, org, actions, 'getCreditBalanceSummary', [customerId]),
    callAction<RawCustomer>(ctx, org, actions, 'getThresholds', [customerId]),
    callAction<{ data?: RawCerebrasInvoice[] }>(ctx, org, actions, 'listCustomerInvoices', [customerId]),
    callAction<{ data?: RawCreditGrant[] }>(ctx, org, actions, 'listCreditGrantHistory', [customerId])
  ])

  // A concise trace of what resolved, so a blank tab is diagnosable from the logs rather than silent.
  ctx.log('cerebras: billing fetched', {
    invoices: invoices?.data?.length ?? 0,
    grants: grants?.data?.length ?? 0,
    lineItems: lineItems?.data?.length ?? 0,
    hasBalance: Boolean(balance?.data),
    hasCustomer: Boolean(customer)
  })

  return {
    invoices: invoices?.data ?? null,
    upcoming: lineItems?.data ?? null,
    balance: balance?.data ?? null,
    customer: customer ?? null,
    grants: grants?.data ?? null
  }
}

// ── apiKeys (live GraphQL `ListOrganizationApiKeys`) ────────────────────────────────────

// `csk-8p9hk5…vvvx` → `csk-…vvvx` (never surface the full secret).
const maskSecret = (secret?: string): string => (secret ? `csk-…${secret.slice(-4)}` : '—')

export const buildCerebrasKeys = (raw: RawCerebrasApiKey[] | null | undefined): ApiKeysInput => ({
  keys: (raw ?? []).map((k) => ({
    id: k.id ?? '',
    name: k.name || '(unnamed)',
    masked: maskSecret(k.secretKey),
    createdAt: k.createdAt ?? undefined,
    lastUsedAt: k.lastUsedAt ?? undefined,
    revoked: (k.state ?? '').toUpperCase() !== 'ACTIVE'
  }))
})

const LIST_API_KEYS = `query ListOrganizationApiKeys($organizationId: ID!) {
  ListOrganizationApiKeys(organizationId: $organizationId) {
    id name secretKey projectId projectName state createdAt lastUsedAt __typename
  }
}`

const fetchCerebrasKeys = async (ctx: CollectContext<CerebrasConfig>): Promise<RawCerebrasApiKey[]> => {
  const resp = await ctx.client.graphql<{ ListOrganizationApiKeys?: RawCerebrasApiKey[] }>(GQL, {
    operationName: 'ListOrganizationApiKeys',
    query: LIST_API_KEYS,
    variables: { organizationId: orgId(ctx) }
  })

  return resp.ListOrganizationApiKeys ?? []
}

// ── members (live GraphQL `ListOrganizationMembers`) ─────────────────────────────────────

export const buildCerebrasMembers = (raw: RawCerebrasMember[] | null | undefined): MembersInput => ({
  members: (raw ?? []).map((m, i) => ({
    id: m.user?.id ?? m.user?.email ?? `member-${i}`,
    name: m.user?.name || undefined,
    email: m.user?.email || undefined,
    role: m.role ?? undefined
  }))
})

const LIST_MEMBERS = `query ListOrganizationMembers($organizationId: ID!) {
  ListOrganizationMembers(organizationId: $organizationId) {
    user { id name email __typename }
    role projectAdminCount projectMemberCount __typename
  }
}`

const fetchCerebrasMembers = async (ctx: CollectContext<CerebrasConfig>): Promise<RawCerebrasMember[]> => {
  const resp = await ctx.client.graphql<{ ListOrganizationMembers?: RawCerebrasMember[] }>(GQL, {
    operationName: 'ListOrganizationMembers',
    query: LIST_MEMBERS,
    variables: { organizationId: orgId(ctx) }
  })

  return resp.ListOrganizationMembers ?? []
}

// ── usage (live GraphQL — request volume + per-model rate-limit quotas) ──────────────────

const toNum = (v?: string): number => {
  const n = Number(v)

  return Number.isFinite(n) ? n : 0
}

// Counts only (no money — token cost lives on billing).
export const buildCerebrasUsage = (
  totalRequests: number | null | undefined,
  rawGraph: RawGraphPoint[] | null | undefined,
  rawQuotas: RawQuota[] | null | undefined,
  rawModels: RawModel[] | null | undefined,
  periodStart?: string,
  periodEnd?: string
): CerebrasUsage => {
  const modelName = new Map<string, string>()

  for (const m of rawModels ?? []) {
    if (m.id) {
      modelName.set(m.id, m.name || m.id)
    }
  }

  const byDay = new Map<string, number>()

  for (const p of rawGraph ?? []) {
    const day = isoDay(p.timeWindow)

    if (day) {
      byDay.set(day, (byDay.get(day) ?? 0) + (p.requestCount ?? 0))
    }
  }

  const daily = [...byDay.entries()].map(([date, requests]) => ({ date, requests })).sort(byDayAsc)

  const models = (rawQuotas ?? []).map((q) => ({
    modelId: q.modelId ?? '',
    name: modelName.get(q.modelId ?? '') ?? q.modelId ?? '',
    rpm: toNum(q.requestsPerMinute),
    tpm: toNum(q.tokensPerMinute),
    rpd: toNum(q.requestsPerDay),
    maxCompletion: toNum(q.maxCompletionTokens)
  }))

  return {
    totalRequests: totalRequests ?? 0,
    daily,
    models,
    modelCount: (rawModels ?? []).filter((m) => !m.deprecated).length,
    periodStart,
    periodEnd
  }
}

type CerebrasDailyRow = {
  date: string | null
  requests: number
}

type CerebrasQuotaRow = {
  name: string | null
  rpm: number
  tpm: number
  rpd: number
  maxCompletion: number
}

export const buildCerebrasUsageResult = (usageData: CerebrasUsage): CapabilityResult => {
  const series =
    usageData.daily.length > 0 &&
    table<CerebrasDailyRow>({
      id: 'daily',
      columns: [
        { key: 'date', label: 'Date', role: 'timestamp' },
        { key: 'requests', label: 'Requests', role: 'count' }
      ],
      rows: usageData.daily.map((d) => ({ date: d.date, requests: d.requests })),
      key: 'date'
    }).timeseries({ x: 'date', y: 'requests', granularity: 'daily', title: 'Daily requests' })

  const quotas =
    usageData.models.length > 0 &&
    table<CerebrasQuotaRow>({
      id: 'quotas',
      columns: [
        { key: 'name', label: 'Model', role: 'label' },
        { key: 'rpm', label: 'Req/min', role: 'count' },
        { key: 'tpm', label: 'Tok/min', role: 'count' },
        { key: 'rpd', label: 'Req/day', role: 'count' },
        { key: 'maxCompletion', label: 'Max completion', role: 'count' }
      ],
      rows: usageData.models.map((m) => ({
        name: m.name,
        rpm: m.rpm,
        tpm: m.tpm,
        rpd: m.rpd,
        maxCompletion: m.maxCompletion
      })),
      // One quota per model — key on the model name so per-model quotas accumulate.
      key: 'name'
    }).table({ title: 'Rate-limit quotas' })

  return addSections(
    usage.result({
      periodStart: usageData.periodStart,
      periodEnd: usageData.periodEnd,
      metrics: [{ label: 'Requests (30d)', value: usageData.totalRequests, unit: 'requests' }]
    }),
    series,
    quotas
  )
}

const LIST_MODELS = `query ListModels($organizationId: ID, $deprecated: Boolean) {
  ListModels(organizationId: $organizationId, deprecated: $deprecated) { id name deprecated __typename }
}`
const LIST_QUOTAS = `query ListOrganizationEffectiveQuotas($organizationId: ID!, $regionId: ID) {
  ListOrganizationEffectiveQuotas(organizationId: $organizationId, regionId: $regionId) {
    modelId requestsPerMinute tokensPerMinute requestsPerDay maxCompletionTokens __typename
  }
}`
const LIST_PROJECTS = `query ListProjects($organizationId: ID!) { ListProjects(organizationId: $organizationId) { id __typename } }`
const LIST_KEY_IDS = `query ListOrganizationApiKeys($organizationId: ID!) { ListOrganizationApiKeys(organizationId: $organizationId) { id __typename } }`
const REQUEST_COUNT = `query GetOrganizationRequestCount($organizationId: ID!, $projectIds: [ID!], $modelIds: [ID!]!, $apiKeyIds: [ID!]!, $startTime: Date!, $endTime: Date!, $httpCodes: [String!]!, $inputTypes: [String!]!) {
  GetOrganizationRequestCount(organizationId: $organizationId, projectIds: $projectIds, modelIds: $modelIds, apiKeyIds: $apiKeyIds, startTime: $startTime, endTime: $endTime, httpCodes: $httpCodes, inputTypes: $inputTypes)
}`
const GRAPH_DATA = `query ListOrganizationRequestGraphData($organizationId: ID!, $projectIds: [ID!]!, $modelIds: [ID!]!, $apiKeyIds: [ID!]!, $startTime: Date!, $endTime: Date!, $httpCodes: [String!]!, $inputTypes: [String!]!, $timeInterval: String!) {
  ListOrganizationRequestGraphData(organizationId: $organizationId, projectIds: $projectIds, modelIds: $modelIds, apiKeyIds: $apiKeyIds, startTime: $startTime, endTime: $endTime, httpCodes: $httpCodes, inputTypes: $inputTypes, timeInterval: $timeInterval) { timeWindow httpStatus requestCount __typename }
}`

const ids = (arr: Array<{ id?: string }> | undefined): string[] =>
  (arr ?? []).map((x) => x.id).filter((id): id is string => Boolean(id))

// The raw usage wire bundle: request-volume + per-model quotas + the model catalog + the resolved window, the
// inputs buildCerebrasUsage composes.
export type CerebrasUsageRaw = {
  totalRequests: number
  graph: RawGraphPoint[]
  quotas: RawQuota[] | null
  models: RawModel[]
  periodStart?: string
  periodEnd?: string
}

const usageFromRaw = (raw: CerebrasUsageRaw): CerebrasUsage =>
  buildCerebrasUsage(raw.totalRequests, raw.graph, raw.quotas, raw.models, raw.periodStart, raw.periodEnd)

const fetchCerebrasUsage = async (ctx: CollectContext<CerebrasConfig>): Promise<CerebrasUsageRaw> => {
  const org = orgId(ctx)
  const region = ctx.config.regionId?.trim()
  const gql = <T>(query: string, variables: Record<string, unknown>) => ctx.client.graphql<T>(GQL, { query, variables })

  const [projects, keys, models, quotas] = await Promise.all([
    gql<{ ListProjects?: Array<{ id?: string }> }>(LIST_PROJECTS, { organizationId: org }),
    gql<{ ListOrganizationApiKeys?: Array<{ id?: string }> }>(LIST_KEY_IDS, { organizationId: org }),
    gql<{ ListModels?: RawModel[] }>(LIST_MODELS, { organizationId: org, deprecated: false }),
    gql<{ ListOrganizationEffectiveQuotas?: RawQuota[] }>(LIST_QUOTAS, { organizationId: org, regionId: region })
  ])

  const modelList = models.ListModels ?? []
  const end = new Date()
  const start = new Date(end.getTime() - WINDOW_DAYS * MS_PER_DAY)
  const filterVars = {
    organizationId: org,
    projectIds: ids(projects.ListProjects),
    modelIds: ids(modelList),
    apiKeyIds: ids(keys.ListOrganizationApiKeys),
    startTime: start.toISOString(),
    endTime: end.toISOString(),
    httpCodes: HTTP_CODES,
    inputTypes: INPUT_TYPES
  }

  // Request-volume queries may legitimately empty (no traffic); tolerate so the quota table still renders.
  const [count, graph] = await Promise.all([
    gql<{ GetOrganizationRequestCount?: number }>(REQUEST_COUNT, filterVars).catch(() => null),
    gql<{ ListOrganizationRequestGraphData?: RawGraphPoint[] }>(GRAPH_DATA, {
      ...filterVars,
      timeInterval: 'PER_DAY'
    }).catch(() => null)
  ])

  return {
    totalRequests: count?.GetOrganizationRequestCount ?? 0,
    graph: graph?.ListOrganizationRequestGraphData ?? [],
    quotas: quotas.ListOrganizationEffectiveQuotas ?? null,
    models: modelList,
    periodStart: isoDay(filterVars.startTime),
    periodEnd: isoDay(filterVars.endTime)
  }
}

// ── shared ───────────────────────────────────────────────────────────────────────────

// Auto-extracted from the dashboard URL at capture time (creds), overridable via config.
const orgId = (ctx: CollectContext<CerebrasConfig>): string => {
  const org = ctx.config.orgId?.trim() || ctx.creds.get('orgId')

  if (!org) {
    throw new Error('Cerebras: organization ID not captured — set it in Settings (the org_… in your dashboard URL).')
  }

  return org
}

// ── descriptor ───────────────────────────────────────────────────────────────────────

export const cerebrasConfigSchema = defineConfigSchema([
  {
    key: 'orgId',
    label: 'Organization ID',
    kind: 'text',
    placeholder: 'org_…',
    help: 'Auto-captured from your dashboard URL on sign-in. Override only to target a different org (the org_… segment).'
  },
  {
    key: 'regionId',
    label: 'Region ID',
    kind: 'text',
    placeholder: 'us-west-1',
    help: 'Optional — scopes the rate-limit quota lookup to a region.'
  }
])

export type CerebrasConfig = ConfigOf<typeof cerebrasConfigSchema>

export const cerebrasPlugin = definePlugin({
  reportingCurrency: 'USD',
  meta: {
    id: 'cerebras',
    name: 'Cerebras',
    vendor: 'Cerebras',
    category: 'ai',
    color: '#ff6b00',
    description: 'Cerebras Cloud — billing & credits, API request volume, per-model rate-limit quotas, keys, members.',
    homepage: 'https://cloud.cerebras.ai',
    dashboardUrl: 'https://cloud.cerebras.ai/platform'
  },
  session: {
    loginUrl: 'https://cloud.cerebras.ai/',
    // Only the settled app page (the /project/ segment) — a bare-domain or /platform/org_<id> marker fires on
    // the 307 redirect hops before the cookie lands.
    dashboardMarkers: ['/project/'],
    cookieDomains: ['cerebras.ai'],
    requiredCookie: 'authjs.session-token',
    // The settled app URL embeds the org id (/platform/org_<id>/project/…) — capture it so the user needn't type it.
    captureFromUrl: [{ pattern: '/(org_[a-z0-9]+)', storeAs: 'orgId' }]
  },
  auth: { kind: 'cookie' },
  transport: {
    requiresBrowserEngine: true,
    baseUrl: ORIGIN
  },
  config: cerebrasConfigSchema,
  capabilities: [
    defineCapability({
      id: 'summary',
      label: 'Summary',
      fetch: fetchCerebrasBilling,
      build: (raw) => buildCerebrasSummaryResult(billingFromRaw(raw)),
      sample: sampleCerebrasBilling
    }),
    defineCapability({
      id: 'billing',
      label: 'Billing',
      fetch: fetchCerebrasBilling,
      build: (raw) => buildCerebrasBillingTab(billingFromRaw(raw)),
      sample: sampleCerebrasBilling
    }),
    defineCapability({
      id: 'usage',
      label: 'Usage',
      fetch: fetchCerebrasUsage,
      build: (raw) => buildCerebrasUsageResult(usageFromRaw(raw)),
      sample: sampleCerebrasUsage
    }),
    defineCapability({
      id: 'apiKeys',
      label: 'API Keys',
      fetch: fetchCerebrasKeys,
      build: (raw) => keys.result(buildCerebrasKeys(raw)),
      sample: sampleCerebrasKeys
    }),
    defineCapability({
      id: 'members',
      label: 'Members',
      fetch: fetchCerebrasMembers,
      build: (raw) => members.result(buildCerebrasMembers(raw)),
      sample: sampleCerebrasMembers
    })
  ],
  probe: async (ctx) => {
    // Listing API keys is the cheapest authed GraphQL call — a 200 proves the session is live.
    await ctx.client.graphql(GQL, { query: LIST_KEY_IDS, variables: { organizationId: orgId(ctx) } })
  }
})
