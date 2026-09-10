import { defineCapability, defineConfigSchema, definePlugin, type CollectContext, type ConfigOf } from '@butinapp/sdk'
import { addSections, table, type CapabilityResult } from '@butinapp/sdk/data'
import { DateTime } from '@butinapp/sdk/libs'
import { billing, keys, members, usage, type ApiKeysInput } from '@butinapp/sdk/presets'
import {
  byDayAsc,
  byDayDesc,
  centsToMajor,
  epochSecDay,
  fullName,
  getReportingZone,
  monthKey,
  round2
} from '@butinapp/sdk/util'

import {
  decodeMessage,
  deframeResponse,
  frameMessage,
  getMessage,
  getNumber,
  getPackedDoubles,
  getRepeatedMessages,
  getRepeatedStrings,
  getString,
  message,
  messageField,
  type ProtoMessage,
  stringField,
  varintField
} from './codec.js'
import { sampleXaiBilling, sampleXaiKeys, sampleXaiMembers, sampleXaiUsage } from './sample.js'

// The protobuf/gRPC-web codec is re-exported so the contract surface (and the fixture tests) read off this module.
export * from './codec.js'

// xAI developer console (console.x.ai — Grok). There is no JSON API. The console reads its data two ways, and
// so does this plugin:
//
//   1. gRPC-Web (`application/grpc-web+proto`) for everything the browser fetches — billing, usage, members.
//      There is no `.proto` schema, so requests are hand-encoded by field number and responses walked the same
//      way. Field numbers are not a contract: a renumbered field breaks the decode, and each message numbers
//      its OWN fields (the team id is #10 on the invoice RPCs, #1 on the rest — there is no global convention).
//      If a tab breaks, re-check its field numbers against a fresh capture; that is almost always the cause.
//   2. The page's RSC flight for what the browser never fetches. The console's server prefetches some calls and
//      dehydrates them into the HTML, and those are NOT routed on the browser-facing gRPC gateway at all — it
//      answers them 200 with an empty body. `apiKeys` is one, so it reads the page (see its section).
//
// AUTH is the console session cookie (the `sso` cookie on x.ai), replayed verbatim (cookie auth). The
// console's edge verifies a real browser, so this uses the Electron transport (requiresBrowserEngine) — the
// request UA must match the sign-in window UA (cf_clearance is bound to (IP, UA, TLS identity)).
//
// MONEY ARRIVES IN TWO UNITS: invoice/amount-to-pay line items are CENTS (→ centsToMajor), while the usage
// analytics buckets are already dollars, as packed doubles. Normalize per call site, not globally.

const CONSOLE_ORIGIN = 'https://console.x.ai'
const BILLING_SERVICE = 'prod_mc_billing.UISvc'
const AUTH_SERVICE = 'auth_mgmt.AuthManagement'

// ── billing (ListInvoices · GetAmountToPay · GetBillingInfo · GetSpendingLimits) ────────
// No explicit invoice-total field exists — the total is the sum of each invoice's per-model/per-usage line
// items. Money is CENTS here (line-item #6 + the spending-limit values), unlike the usage buckets below.

export interface XaiLineItem {
  region?: string
  model?: string // e.g. 'Chat grok-4.3'
  usageType?: string // e.g. 'Completion text tokens'
  quantity: number
  cost: number // dollars
}

export interface XaiInvoice {
  date?: string // billing month 'YYYY-MM-01'
  number?: string // human invoice number, e.g. 'YUEZ-NHMC-G645'
  status: string
  amount: number // dollars (sum of line items)
  lineItemCount: number
  hostedUrl?: string // deep link to the console invoice detail page (where the PDF download lives)
}

export interface XaiModelSpend {
  label: string // '<model> · <usageType>'
  cost: number
}

export interface XaiBillingReport {
  invoices: XaiInvoice[]
  totalBilled: number
  currentPeriodAccrued: number // current unbilled period (GetAmountToPay), dollars
  topCurrentModels: XaiModelSpend[]
  spendingLimit?: number // dollars
}

// Inferred invoice status enum (#40): the current/most-recent month reads 1, finalized past months read 2.
const STATUS_BY_CODE: Record<number, string> = { 1: 'open', 2: 'paid' }

// Billing month 'YYYY-MM-01' from the invoice's own billing period (#120 → #10 {year, month}), falling back to
// the issue date. The period is authoritative: the issue date lands early in the FOLLOWING month, and a prepaid
// credit invoice carries no period at all.
const billingMonth = (period: ProtoMessage | undefined, issueDate: string | undefined): string | undefined => {
  const year = period ? getNumber(period, 1) : undefined
  const month = period ? getNumber(period, 2) : undefined

  if (year !== undefined && month !== undefined) {
    return `${monthKey(year, month)}-01`
  }

  return issueDate ? `${issueDate.slice(0, 7)}-01` : undefined
}

// Line item: #1 region · #2 model · #3 usageType · #4 unit price · #5 quantity · #6 cost (CENTS) · #7 source.
const parseLineItem = (item: ProtoMessage): XaiLineItem => ({
  region: getString(item, 1),
  model: getString(item, 2),
  usageType: getString(item, 3),
  quantity: getNumber(item, 5) ?? 0,
  cost: centsToMajor(getNumber(item, 6) ?? 0)
})

// Invoice: #20 id · #21 number · #31 {#1 seconds} issue ts · #40 status · #70 repeated line items · #110 pdf
// path · #120 {#10 {#1 year, #2 month}} billing period.
const parseInvoice = (inv: ProtoMessage, teamId: string): XaiInvoice => {
  const lineItems = getRepeatedMessages(inv, 70).map(parseLineItem)
  const issueDate = epochSecDay(getNumber(getMessage(inv, 31) ?? new Map(), 1))
  const period = getMessage(getMessage(inv, 120) ?? new Map(), 10)
  const code = getNumber(inv, 40)
  // The invoice id (#20, a base64 string ending in '=') is the URL segment of the detail page —
  // encodeURIComponent turns '=' into '%3D'.
  const id = getString(inv, 20)

  return {
    date: billingMonth(period, issueDate),
    number: getString(inv, 21),
    status: (code !== undefined && STATUS_BY_CODE[code]) || 'unknown',
    amount: lineItems.reduce((sum, li) => sum + li.cost, 0),
    lineItemCount: lineItems.length,
    hostedUrl: id ? `${CONSOLE_ORIGIN}/team/${teamId}/settings/billing/invoices/${encodeURIComponent(id)}` : undefined
  }
}

// Pure transform — fixture-tested. Builds the billing report from the three decoded RPC responses.
export const buildBillingReport = (
  invoicesResp: ProtoMessage,
  amountToPayResp: ProtoMessage,
  spendingLimitsResp: ProtoMessage,
  teamId: string
): XaiBillingReport => {
  // ListInvoices response: repeated #1 = invoices.
  const invoices = getRepeatedMessages(invoicesResp, 1)
    .map((inv) => parseInvoice(inv, teamId))
    .sort(byDayDesc)

  // GetAmountToPay wraps the current period's line items in an outer #1 message, items repeated under #1 inside.
  const currentWrapper = getMessage(amountToPayResp, 1)
  const currentItems = currentWrapper ? getRepeatedMessages(currentWrapper, 1).map(parseLineItem) : []
  const currentPeriodAccrued = currentItems.reduce((sum, li) => sum + li.cost, 0)

  // Line items split by region (and other dimensions), so the same model/usage pair recurs — aggregate first.
  const byLabel = new Map<string, number>()

  for (const li of currentItems) {
    const label = [li.model, li.usageType].filter(Boolean).join(' · ')

    byLabel.set(label, (byLabel.get(label) ?? 0) + li.cost)
  }

  const topCurrentModels: XaiModelSpend[] = [...byLabel.entries()]
    .map(([label, cost]) => ({ label, cost }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 8)

  // GetSpendingLimits: `{ #1: { #2: {#1: cents}, #5: {#1: cents} } }`. Both observed equal; take #2 as the limit.
  const limitWrapper = getMessage(spendingLimitsResp, 1)
  const limitCents = limitWrapper ? getNumber(getMessage(limitWrapper, 2) ?? new Map(), 1) : undefined
  const spendingLimit = limitCents !== undefined ? centsToMajor(limitCents) : undefined

  return {
    invoices,
    totalBilled: invoices.reduce((sum, i) => sum + i.amount, 0),
    currentPeriodAccrued,
    topCurrentModels,
    spendingLimit
  }
}

// GetBillingInfo: `{ #10: { #20: <name>, #30: <email> } }` — the contact the receipts go to.
export const billingEmail = (resp: ProtoMessage): string | undefined =>
  getString(getMessage(resp, 10) ?? new Map(), 30) || undefined

interface TopModelRow {
  label: string
  cost: number
}

// Map the normalized billing report onto a CapabilityResult: the shared billing preset (account stat +
// monthly-spend chart + invoices table + spend.mtd summary), augmented with the current-period top-models
// table and the spending-limit stat. Pure — fixture-tested.
export const buildXaiBillingResult = (report: XaiBillingReport, email?: string): CapabilityResult => {
  const result = billing.result({
    currentMtd: report.currentPeriodAccrued,
    // Usage-metered spend accruing live over the open period.
    mtdBasis: 'accrued',
    invoices: report.invoices.map((i) => ({
      date: i.date,
      amount: i.amount,
      status: i.status,
      hostedUrl: i.hostedUrl ?? null
    }))
  })
  const account = result.datasets.find((d) => d.id === 'account')

  // Fold the spending limit (when set) and the billing contact onto the account record, beside the MTD figure.
  if (account?.shape === 'record') {
    if (report.spendingLimit !== undefined) {
      account.fields.push({ key: 'spendingLimit', label: 'Spending limit', role: 'money' })
      account.value.spendingLimit = report.spendingLimit
    }

    if (email) {
      account.fields.push({ key: 'billingEmail', label: 'Billing contact', role: 'identifier' })
      account.value.billingEmail = email
    }
  }

  // Current-period top models — a breakdown table of where the unbilled spend is going.
  const topModels = report.topCurrentModels.length
    ? table<TopModelRow>({
        id: 'topModels',
        columns: [
          { key: 'label', label: 'Model · usage', role: 'label' },
          { key: 'cost', label: 'Accrued', role: 'money' }
        ],
        rows: report.topCurrentModels.map((m) => ({ label: m.label, cost: m.cost }))
      }).table({ title: 'Current period — top models' })
    : null

  return addSections(result, topModels)
}

// ── usage (AnalyzeBillingItems) ─────────────────────────────────────────────────────────
// The console's own usage chart. One request asks for a date range at a granularity plus the metrics it wants
// by name; each daily bucket answers with a PACKED double per metric, positionally in the order requested. The
// values are already in MAJOR units (dollars) — unlike the invoice line items, which are cents.

// The metrics requested, in wire order — a bucket's packed doubles line up with this list index-for-index.
const USAGE_METRICS = ['usd', 'items', 'units'] as const
// Granularity: daily buckets.
const USAGE_DAILY = 3
const USAGE_WINDOW_DAYS = 30

export interface XaiUsageDay {
  date: string
  cost: number
  requests: number
  units: number
}

export interface XaiUsageReport {
  days: XaiUsageDay[]
  totalCost: number
  totalRequests: number
  totalUnits: number
}

// Pure transform — fixture-tested. Response: `{ #1: { #2: repeated { #1: {#1 seconds}, #2: packed doubles } } }`.
export const buildUsageReport = (resp: ProtoMessage): XaiUsageReport => {
  const buckets = getRepeatedMessages(getMessage(resp, 1) ?? new Map(), 2)
  const days: XaiUsageDay[] = []

  for (const bucket of buckets) {
    const date = epochSecDay(getNumber(getMessage(bucket, 1) ?? new Map(), 1))
    const [cost = 0, requests = 0, units = 0] = getPackedDoubles(bucket, 2)

    if (date) {
      days.push({ date, cost: round2(cost), requests, units })
    }
  }

  days.sort(byDayAsc)

  return {
    days,
    totalCost: round2(days.reduce((sum, d) => sum + d.cost, 0)),
    totalRequests: days.reduce((sum, d) => sum + d.requests, 0),
    totalUnits: days.reduce((sum, d) => sum + d.units, 0)
  }
}

// Pure transform — fixture-tested. The trailing-window meters plus the daily cost trend.
export const buildXaiUsageResult = (report: XaiUsageReport): CapabilityResult =>
  usage.result({
    periodStart: report.days[0]?.date,
    periodEnd: report.days.at(-1)?.date,
    metrics: [
      { label: 'Requests', value: report.totalRequests, unit: 'calls', cost: report.totalCost },
      { label: 'Units', value: report.totalUnits, unit: 'tokens' }
    ],
    daily: report.days.map((d) => ({ date: d.date, cost: d.cost })),
    dailyTitle: 'Daily spend'
  })

export interface RawXaiUsage {
  usage: ProtoMessage
}

export const buildXaiUsage = (raw: RawXaiUsage): CapabilityResult => buildXaiUsageResult(buildUsageReport(raw.usage))

// AnalyzeBillingItems request: `{ #1: { #1: {#1 start, #2 end, #3 tz}, #2: granularity, #3: repeated {#1 metric,
// #2: 1} }, #2: teamId }`. The bounds are wall-clock strings read in the named zone, so the days bucket on the
// user's own calendar rather than UTC's.
const analyzeBillingItemsBody = (id: string, now: DateTime): Buffer => {
  const stamp = (d: DateTime): string => d.toFormat('yyyy-MM-dd HH:mm:ss')

  return message(
    messageField(
      1,
      message(
        messageField(
          1,
          message(
            stringField(1, stamp(now.minus({ days: USAGE_WINDOW_DAYS }).startOf('day'))),
            stringField(2, stamp(now.endOf('day'))),
            stringField(3, now.zoneName ?? 'UTC')
          )
        ),
        varintField(2, USAGE_DAILY),
        ...USAGE_METRICS.map((m) => messageField(3, message(stringField(1, m), varintField(2, 1))))
      )
    ),
    stringField(2, id)
  )
}

const fetchXaiUsage = async (ctx: CollectContext<XaiConfig>): Promise<RawXaiUsage> => ({
  usage: await unary(
    ctx,
    BILLING_SERVICE,
    'AnalyzeBillingItems',
    analyzeBillingItemsBody(teamId(ctx), DateTime.now().setZone(getReportingZone()))
  )
})

// ── members (ListSubscriptionAssignments) ───────────────────────────────────────────────
// The roster the console's own Team-members page renders: who holds a seat of each product. There is no
// list-products call to walk (it answers empty), so each product in the console's catalog is asked in turn and
// the people are unioned by user id — the same person holding two seats is one row.

// The product ids the console asks for on its Team-members page.
const SEAT_PRODUCT_IDS = ['prd_V6Gd', 'prd_UCd6']

export interface XaiMember {
  id: string
  name?: string
  email?: string
}

// PublicUser: #1 userId · #3 email · #4 profileImage · #5 givenName · #6 familyName · #7 profileImageUrl.
const parseMember = (user: ProtoMessage): XaiMember => {
  const name = fullName(getString(user, 5), getString(user, 6))

  return { id: getString(user, 1) ?? '', name: name || undefined, email: getString(user, 3) }
}

// Pure transform — fixture-tested. Each response is `{ #1: repeated { #1: PublicUser } }`; one per product.
export const buildMembersReport = (responses: ProtoMessage[]): XaiMember[] => {
  const byId = new Map<string, XaiMember>()

  for (const resp of responses) {
    for (const assignment of getRepeatedMessages(resp, 1)) {
      const user = getMessage(assignment, 1)
      const member = user && parseMember(user)

      if (member && member.id && !byId.has(member.id)) {
        byId.set(member.id, member)
      }
    }
  }

  return [...byId.values()].sort((a, b) => (a.name ?? a.email ?? '').localeCompare(b.name ?? b.email ?? ''))
}

export const buildXaiMembersResult = (list: XaiMember[]): CapabilityResult => members.result({ members: list })

export interface RawXaiMembers {
  assignments: ProtoMessage[]
}

export const buildXaiMembers = (raw: RawXaiMembers): CapabilityResult =>
  buildXaiMembersResult(buildMembersReport(raw.assignments))

// ListSubscriptionAssignments request: `{ #1: teamId, #2: { #1: productId } }`.
const fetchXaiMembers = async (ctx: CollectContext<XaiConfig>): Promise<RawXaiMembers> => {
  const id = teamId(ctx)

  return {
    assignments: await Promise.all(
      SEAT_PRODUCT_IDS.map((productId) =>
        unary(
          ctx,
          BILLING_SERVICE,
          'ListSubscriptionAssignments',
          message(stringField(1, id), messageField(2, message(stringField(1, productId))))
        )
      )
    )
  }
}

// ── apiKeys (server-rendered into the page) ─────────────────────────────────────────────
// ListApiKeys is NOT reachable over gRPC-Web: the browser-facing gateway does not route it — it answers 200
// with an empty body, not even a status trailer — because the console never calls it from the client. Its
// server renders the keys into the page instead, so the PAGE is the API here.
//
// Next.js streams the RSC flight as a run of `self.__next_f.push([1,"<js string literal>"])` calls; joining the
// decoded literals reassembles a dehydrated query cache in which each response sits as JSON keyed by FIELD
// NAME. That is the whole reason to read the page rather than the wire: a protobuf response would need field
// numbers, which cannot be observed for a call the browser never makes.

const FLIGHT_PUSH = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g

// Reassemble the RSC flight from a page's HTML.
export const readFlight = (html: string): string => {
  let flight = ''

  for (const [, literal] of html.matchAll(FLIGHT_PUSH)) {
    try {
      flight += JSON.parse(literal!) as string
    } catch {
      // Not a well-formed string literal, so not flight data — skip it.
    }
  }

  return flight
}

// The end index (exclusive) of the JSON object opening at `start`, tracking quotes so a brace inside a string
// value cannot close the scan early.
const objectEnd = (s: string, start: number): number => {
  let depth = 0

  for (let i = start; i < s.length; i++) {
    if (s[i] === '"') {
      i++

      while (i < s.length && s[i] !== '"') {
        i += s[i] === '\\' ? 2 : 1
      }
    } else if (s[i] === '{') {
      depth++
    } else if (s[i] === '}' && --depth === 0) {
      return i + 1
    }
  }

  return -1
}

// The dehydrated message of a given protobuf type, parsed out of the flight. protobuf-es serializes `$typeName`
// as the object's first key, so the marker's own opening brace is the object's.
export const findFlightMessage = <T>(flight: string, typeName: string): T | undefined => {
  const at = flight.indexOf(`"$typeName":"${typeName}"`)
  const start = at < 0 ? -1 : flight.lastIndexOf('{', at)
  const end = start < 0 ? -1 : objectEnd(flight, start)

  if (end < 0) {
    return undefined
  }

  try {
    return JSON.parse(flight.slice(start, end)) as T
  } catch {
    return undefined
  }
}

// The flight encodes a protobuf int64 as a BigInt token — `"$n1783696231"`.
const flightSeconds = (value?: string): number | undefined => (value ? Number(value.replace(/^\$n/, '')) : undefined)

// One key as the page carries it. The console only ever renders the masked 'xai-…suffix' hint, never the secret.
export interface RawXaiApiKey {
  redactedApiKey?: string
  name?: string
  userId?: string
  apiKeyId?: string
  disabled?: boolean
  aclStrings?: string[]
  createTime?: { seconds?: string }
}

export interface XaiApiKey {
  id: string
  name: string
  keyHint: string // masked hint, e.g. 'xai-…jJaR'
  creatorEmail?: string
  creatorName?: string
  created?: string // 'YYYY-MM-DD' (UTC)
  acls: string[] // scope ACLs, e.g. 'api-key:model:*'
  disabled: boolean
}

export interface XaiKeysReport {
  keys: XaiApiKey[]
  totalKeys: number
}

// Pure transform — fixture-tested. A key names only its creator's `userId`, so the roster resolves it to a
// person; a key made by someone since removed from the team keeps its id and shows no creator.
export const buildKeysReport = (raw: RawXaiKeys): XaiKeysReport => {
  const people = new Map(raw.members.map((m) => [m.id, m]))
  const keys = raw.keys
    .map((k) => {
      const creator = k.userId ? people.get(k.userId) : undefined

      return {
        id: k.apiKeyId ?? '',
        name: k.name || '(unnamed)',
        keyHint: k.redactedApiKey ?? '',
        creatorEmail: creator?.email,
        creatorName: creator?.name,
        created: epochSecDay(flightSeconds(k.createTime?.seconds)),
        acls: k.aclStrings ?? [],
        disabled: k.disabled === true
      }
    })
    .sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''))

  return { keys, totalKeys: keys.length }
}

interface KeyDetailRow {
  // The key id — hidden, the ledger key so each key's creator/scope history accumulates past the fetch window.
  id: string
  name: string
  keyHint: string
  creator: string | null
  created: string | null
  acls: string | null
}

// Map the keys report onto the shared apiKeys preset. The masked hint becomes the key column; the inventory
// table also surfaces the creator + ACL scopes via the generic renderer. Pure — fixture-tested.
export const buildXaiKeysResult = (report: XaiKeysReport): CapabilityResult => {
  const base: ApiKeysInput = {
    keys: report.keys.map((k) => ({
      id: k.id,
      name: k.name,
      masked: k.keyHint,
      createdAt: k.created,
      revoked: k.disabled
    }))
  }
  const result = keys.result(base)

  // The preset's table doesn't carry creator/ACLs; append a richer inventory table so they aren't lost.
  const keyDetails = table<KeyDetailRow>({
    id: 'keyDetails',
    columns: [
      { key: 'name', label: 'Name', role: 'label' },
      { key: 'keyHint', label: 'Key', role: 'label' },
      { key: 'creator', label: 'Creator', role: 'label' },
      { key: 'created', label: 'Created', role: 'timestamp' },
      { key: 'acls', label: 'Scopes', role: 'text' },
      { key: 'id', role: 'identifier', hidden: true }
    ],
    rows: report.keys.map((k, i) => ({
      // The console key id is present on every key; a per-row synthetic id backs the rare gap so the key stays unique.
      id: k.id || `key-${i}`,
      name: k.name,
      keyHint: k.keyHint,
      creator: k.creatorName ?? k.creatorEmail ?? null,
      created: k.created ?? null,
      acls: k.acls.join(', ') || null
    })),
    key: 'id'
  }).table({ title: 'Key details' })

  return addSections(result, keyDetails)
}

// ── transport (gRPC-web replay — best-effort; needs live verification) ──────────────────

// The team id lives in config (the convention is "config holds hardcoded ids, not secrets"). It's the
// `8a438a3b-…` segment of the console URL.
const teamId = (ctx: CollectContext<XaiConfig>): string => {
  const id = ctx.config.teamId?.trim()

  if (!id) {
    throw new Error('xAI: set the Team ID in Settings (the UUID in your console.x.ai/team/<id>/ URL).')
  }

  return id
}

// Issue one unary gRPC-web call: frame the request body, POST it as the gRPC-web content type, read the
// response as binary, deframe it, surface a non-zero grpc-status (a failure even on HTTP 200), then decode the
// first data frame.
const unary = async (
  ctx: CollectContext<XaiConfig>,
  service: string,
  method: string,
  body: Buffer
): Promise<ProtoMessage> => {
  const res = await ctx.client.request<ArrayBuffer>({
    url: `${CONSOLE_ORIGIN}/${service}/${method}`,
    method: 'POST',
    body: frameMessage(body),
    responseType: 'arraybuffer',
    headers: {
      'content-type': 'application/grpc-web+proto',
      accept: 'application/grpc-web+proto',
      'x-grpc-web': '1',
      'x-user-agent': 'connect-es/2.1.1',
      origin: CONSOLE_ORIGIN,
      referer: `${CONSOLE_ORIGIN}/`
    }
  })

  const { message: data, grpcStatus, grpcMessage } = deframeResponse(Buffer.from(res.data))

  if (grpcStatus !== undefined && grpcStatus !== 0) {
    throw new Error(
      `[xai] ${service}/${method} failed: grpc-status ${grpcStatus}${grpcMessage ? ` — ${grpcMessage}` : ''}`
    )
  }

  // No data frame AND no status trailer means the body was never gRPC-Web (an edge challenge page, a sign-in
  // redirect, a JSON error). Decoding that to an empty message would render every tab as 0 while reporting
  // success, so fail instead. A trailer with status 0 and no data frame IS a legitimate empty result (a month
  // with no invoices) and returns an empty map.
  if (!data && grpcStatus === undefined) {
    throw new Error(
      `[xai] ${service}/${method}: response is not gRPC-Web (${res.data.byteLength} bytes) — the session may be stale`
    )
  }

  return data ? decodeMessage(data) : new Map()
}

// ListInvoices request: `{ #10: teamId, #30: { #1: year, #2: month } }`. #30 is the since-filter, pinned to an
// early month so the full invoice history returns in one call.
const listInvoicesBody = (id: string): Buffer =>
  message(stringField(10, id), messageField(30, message(varintField(1, 2024), varintField(2, 5))))

// A request whose only field is the team id. The field number is per-message, not global: the invoice/amount
// RPCs carry it at #10, the rest at #1.
const teamIdBody = (id: string, field: number): Buffer => message(stringField(field, id))

// A call whose result enriches a tab but must never fail it — the spending limit is absent on a team that has
// not set one, and the console itself renders that as simply nothing.
const readOptional = async (
  ctx: CollectContext<XaiConfig>,
  service: string,
  method: string,
  body: Buffer
): Promise<ProtoMessage> => {
  try {
    return await unary(ctx, service, method, body)
  } catch (err) {
    ctx.log(`${method} failed: ${err instanceof Error ? err.message : String(err)}`)

    return new Map()
  }
}

// The billing RPC responses, decoded, plus the team id (needed to build invoice detail URLs). This is the RAW
// wire-decoded shape the build half transforms — sample.ts synthesizes one via the encoder.
export interface RawXaiBilling {
  invoices: ProtoMessage
  amountToPay: ProtoMessage
  spendingLimits: ProtoMessage
  billingInfo: ProtoMessage
  teamId: string
}

export const buildXaiBilling = (raw: RawXaiBilling): CapabilityResult =>
  buildXaiBillingResult(
    buildBillingReport(raw.invoices, raw.amountToPay, raw.spendingLimits, raw.teamId),
    billingEmail(raw.billingInfo)
  )

const fetchXaiBilling = async (ctx: CollectContext<XaiConfig>): Promise<RawXaiBilling> => {
  const id = teamId(ctx)
  const [invoices, amountToPay, billingInfo, spendingLimits] = await Promise.all([
    unary(ctx, BILLING_SERVICE, 'ListInvoices', listInvoicesBody(id)),
    unary(ctx, BILLING_SERVICE, 'GetAmountToPay', teamIdBody(id, 10)),
    unary(ctx, BILLING_SERVICE, 'GetBillingInfo', teamIdBody(id, 1)),
    readOptional(ctx, BILLING_SERVICE, 'GetSpendingLimits', teamIdBody(id, 1))
  ])

  return { invoices, amountToPay, spendingLimits, billingInfo, teamId: id }
}

// The ListApiKeys response, decoded — the raw wire shape the build half transforms.
export interface RawXaiKeys {
  keys: RawXaiApiKey[]
  // The roster the key's `userId` resolves against — the page names the creator by id only.
  members: XaiMember[]
}

export const buildXaiKeys = (raw: RawXaiKeys): CapabilityResult => buildXaiKeysResult(buildKeysReport(raw))

const fetchXaiKeys = async (ctx: CollectContext<XaiConfig>): Promise<RawXaiKeys> => {
  const [html, assignments] = await Promise.all([
    ctx.client.getText(`${CONSOLE_ORIGIN}/team/${teamId(ctx)}`),
    fetchXaiMembers(ctx)
  ])
  const resp = findFlightMessage<{ apiKeys?: RawXaiApiKey[] }>(readFlight(html), 'auth_mgmt.ListApiKeysResponse')

  if (!resp) {
    throw new Error('[xai] the team page carried no ListApiKeys data — the session may be stale')
  }

  return { keys: resp.apiKeys ?? [], members: buildMembersReport(assignments.assignments) }
}

// ── descriptor ──────────────────────────────────────────────────────────────────────
export const xaiConfigSchema = defineConfigSchema([
  {
    key: 'teamId',
    label: 'Team ID',
    kind: 'text',
    placeholder: '8a438a3b-…',
    help: 'The team UUID in your console.x.ai/team/<id>/ URL. Auto-detected at sign-in; set it only to override.'
  }
])

export type XaiConfig = ConfigOf<typeof xaiConfigSchema>

export const xaiPlugin = definePlugin({
  reportingCurrency: 'USD',
  meta: {
    id: 'xai',
    name: 'xAI',
    vendor: 'xAI',
    category: 'ai',
    color: '#000000',
    description: 'xAI (Grok) developer console — billing invoices, current-period spend, and API keys.',
    homepage: 'https://x.ai',
    dashboardUrl: 'https://console.x.ai'
  },
  session: {
    loginUrl: 'https://console.x.ai/',
    dashboardMarkers: ['/team/'],
    cookieDomains: ['x.ai'],
    requiredCookie: 'sso',
    // Auto-extract the team id from the dashboard URL (console.x.ai/team/<uuid>/).
    captureFromUrl: [{ pattern: '/team/([0-9a-fA-F-]{36})', storeAs: 'teamId' }]
  },
  auth: { kind: 'cookie' },
  // The console's edge verifies a real browser, so replay needs the browser engine's own TLS identity.
  // cf_clearance is bound to (IP, UA, TLS identity), so the replay UA must match the sign-in window UA
  // (injected centrally).
  transport: {
    requiresBrowserEngine: true,
    baseUrl: CONSOLE_ORIGIN
  },
  config: xaiConfigSchema,
  capabilities: [
    defineCapability({
      id: 'billing',
      label: 'Billing',
      fetch: fetchXaiBilling,
      build: buildXaiBilling,
      sample: sampleXaiBilling
    }),
    defineCapability({
      id: 'usage',
      label: 'Usage',
      fetch: fetchXaiUsage,
      build: buildXaiUsage,
      sample: sampleXaiUsage
    }),
    defineCapability({
      id: 'apiKeys',
      label: 'API Keys',
      fetch: fetchXaiKeys,
      build: buildXaiKeys,
      sample: sampleXaiKeys
    }),
    defineCapability({
      id: 'members',
      label: 'Members',
      fetch: fetchXaiMembers,
      build: buildXaiMembers,
      sample: sampleXaiMembers
    })
  ],
  probe: async (ctx) => {
    // The billing-contact RPC is the cheapest call that answers with the team's own data, so a decodable
    // response proves the console session cookie reaches the API.
    await unary(ctx, BILLING_SERVICE, 'GetBillingInfo', teamIdBody(teamId(ctx), 1))
  }
})
