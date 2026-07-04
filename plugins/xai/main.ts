import { defineCapability, defineConfigSchema, definePlugin, type CollectContext, type ConfigOf } from '@butinapp/sdk'
import { table, type CapabilityResult } from '@butinapp/sdk/data'
import { billing, keys, type ApiKeysInput } from '@butinapp/sdk/presets'
import { centsToMajor, epochSecDay } from '@butinapp/sdk/util'

import {
  decodeMessage,
  deframeResponse,
  frameMessage,
  getMessage,
  getNumber,
  getRepeatedMessages,
  getRepeatedStrings,
  getString,
  message,
  messageField,
  type ProtoMessage,
  stringField,
  varintField
} from './codec.js'
import { sampleXaiBilling, sampleXaiKeys } from './sample.js'

// The protobuf/gRPC-web codec is re-exported so the contract surface (and the fixture tests) read off this module.
export * from './codec.js'

// xAI developer console (console.x.ai — Grok). The console serves ALL of its data over
// `application/grpc-web+proto`: binary protobuf wrapped in gRPC-Web frames. There is NO JSON API and the
// Next.js RSC routes carry only the page shell, so the only way to read billing/keys is to speak protobuf.
// There is no `.proto` schema — requests are hand-encoded from observed field numbers, and responses are
// walked generically by field number. The field numbers are not a contract — a renamed or renumbered field
// breaks the decode. If a tab breaks, re-check the field numbers against a fresh capture; that is almost always the cause.
//
// AUTH is the console session cookie (the `sso` cookie on x.ai), replayed verbatim (cookie auth). The console
// sits behind Cloudflare and only accepts a real browser, so this uses the Electron
// transport (requiresBrowserEngine) — the request UA must match the sign-in window UA (cf_clearance is bound to
// (IP, UA, TLS identity)). MONEY is in CENTS (line-item cost + spending-limit) → centsToMajor.
//
// The gRPC-web replay path (collect()) is wired to the observed endpoints; the framing/field numbers are
// best-effort and may need adjustment against a live account. The pure decoder + build*() transforms are
// fixture-tested below.

const CONSOLE_ORIGIN = 'https://console.x.ai'
const BILLING_SERVICE = 'prod_mc_billing.UISvc'
const AUTH_SERVICE = 'auth_mgmt.AuthManagement'

// ── billing (ListInvoices · GetAmountToPay · GetSpendingLimits) ─────────────────────────
// No explicit invoice-total field exists — the total is the sum of each invoice's per-model/per-usage line
// items. Money is CENTS (line-item #6 + spending-limit values). Billing month comes from the PDF path, not
// the #31 timestamp (which is the issue date, early in the following month).

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

const MONTH_FROM_PDF_PATH = /\/billing\/(\d{4})-(\d{1,2})-/

// Billing month 'YYYY-MM-01' from the PDF path, falling back to the issue date.
const billingMonth = (pdfPath: string | undefined, issueDate: string | undefined): string | undefined => {
  const m = pdfPath ? MONTH_FROM_PDF_PATH.exec(pdfPath) : null

  if (m) {
    return `${m[1]}-${m[2]!.padStart(2, '0')}-01`
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

// Invoice: #20 id · #21 number · #31 {#1 seconds} issue ts · #40 status · #70 repeated line items · #110 pdf path.
const parseInvoice = (inv: ProtoMessage, teamId: string): XaiInvoice => {
  const lineItems = getRepeatedMessages(inv, 70).map(parseLineItem)
  const issueDate = epochSecDay(getNumber(getMessage(inv, 31) ?? new Map(), 1))
  const pdfPath = getString(inv, 110)
  const code = getNumber(inv, 40)
  // The invoice id (#20, a base64 string ending in '=') is the URL segment of the detail page —
  // encodeURIComponent turns '=' into '%3D'.
  const id = getString(inv, 20)

  return {
    date: billingMonth(pdfPath, issueDate),
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
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))

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

interface TopModelRow {
  label: string
  cost: number
}

// Map the normalized billing report onto a CapabilityResult: the shared billing preset (account stat +
// monthly-spend chart + invoices table + spend.mtd summary), augmented with the current-period top-models
// table and the spending-limit stat. Pure — fixture-tested.
export const buildXaiBillingResult = (report: XaiBillingReport): CapabilityResult => {
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

  // Fold the spending limit (when set) onto the account record so it shows beside the MTD figure.
  if (report.spendingLimit !== undefined) {
    const account = result.datasets.find((d) => d.id === 'account')

    if (account && account.shape === 'record') {
      account.fields.push({ key: 'spendingLimit', label: 'Spending limit', role: 'money' })
      account.value.spendingLimit = report.spendingLimit
    }
  }

  // Current-period top models — a breakdown table of where the unbilled spend is going.
  if (report.topCurrentModels.length) {
    const topModels = table<TopModelRow>({
      id: 'topModels',
      columns: [
        { key: 'label', label: 'Model · usage', role: 'label' },
        { key: 'cost', label: 'Accrued', role: 'money' }
      ],
      rows: report.topCurrentModels.map((m) => ({ label: m.label, cost: m.cost }))
    }).table({ title: 'Current period — top models' })

    result.datasets.push(topModels.dataset)
    result.views = [...(result.views ?? []), topModels.view]
  }

  return result
}

// ── apiKeys (ListApiKeys) ───────────────────────────────────────────────────────────────
// The console only ever returns the masked 'xai-…suffix' hint, never the full secret. Each key carries the
// creator's email/name + the ACL scope strings.

export interface XaiApiKey {
  id: string
  name: string
  keyHint: string // masked hint, e.g. 'xai-…jJaR'
  creatorEmail?: string
  creatorName?: string
  created?: string // 'YYYY-MM-DD' (UTC)
  acls: string[] // scope ACLs, e.g. 'api-key:model:*'
}

// Key: #1 masked hint · #4 name · #5 {#1 seconds} created · #8 id · #10 creator {#3 email, #5 first, #6 last}
//      · #16 repeated ACL strings.
const parseKey = (key: ProtoMessage): XaiApiKey => {
  const creator = getMessage(key, 10)
  const firstName = creator ? getString(creator, 5) : undefined
  const lastName = creator ? getString(creator, 6) : undefined
  const creatorName = [firstName, lastName].filter(Boolean).join(' ') || undefined

  return {
    id: getString(key, 8) ?? '',
    name: getString(key, 4) ?? '(unnamed)',
    keyHint: getString(key, 1) ?? '',
    creatorEmail: creator ? getString(creator, 3) : undefined,
    creatorName,
    created: epochSecDay(getNumber(getMessage(key, 5) ?? new Map(), 1)),
    acls: getRepeatedStrings(key, 16)
  }
}

export interface XaiKeysReport {
  keys: XaiApiKey[]
  totalKeys: number
}

// Pure transform — fixture-tested. ListApiKeys response: repeated #1 = keys. Sorted by created desc.
export const buildKeysReport = (resp: ProtoMessage): XaiKeysReport => {
  const keys = getRepeatedMessages(resp, 1)
    .map(parseKey)
    .sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''))

  return { keys, totalKeys: keys.length }
}

interface KeyDetailRow {
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
      revoked: false
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
      { key: 'acls', label: 'Scopes', role: 'text' }
    ],
    rows: report.keys.map((k) => ({
      name: k.name,
      keyHint: k.keyHint,
      creator: k.creatorName ?? k.creatorEmail ?? null,
      created: k.created ?? null,
      acls: k.acls.join(', ') || null
    }))
  }).table({ title: 'Key details' })

  result.datasets.push(keyDetails.dataset)
  result.views = [...(result.views ?? []), keyDetails.view]

  return result
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
// first data frame. Headers/framing are best-effort — verify against a live account.
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

  if (grpcStatus && grpcStatus !== 0) {
    throw new Error(
      `[xai] ${service}/${method} failed: grpc-status ${grpcStatus}${grpcMessage ? ` — ${grpcMessage}` : ''}`
    )
  }

  return data ? decodeMessage(data) : new Map()
}

// ListInvoices request: `{ #10: teamId, #30: { #1: year, #2: month } }`. The #30 since-filter is pinned to an
// early date so the full invoice history returns.
const listInvoicesBody = (id: string): Buffer =>
  message(stringField(10, id), messageField(30, message(varintField(1, 2024), varintField(2, 5))))

// GetAmountToPay (field 10) / GetSpendingLimits (field 1) request: `{ <field>: teamId }`.
const teamIdBody = (id: string, field: number): Buffer => message(stringField(field, id))

// ListApiKeys request: `{ #1: 1, #2: teamId, #5: 1 }` — the flag fields #1 and #5 have unknown semantics
// (no schema) and are sent verbatim.
const listApiKeysBody = (id: string): Buffer => message(varintField(1, 1), stringField(2, id), varintField(5, 1))

// The three billing RPC responses, decoded, plus the team id (needed to build invoice detail URLs). This is
// the RAW wire-decoded shape the build half transforms — sample.ts synthesizes one via the encoder.
export interface RawXaiBilling {
  invoices: ProtoMessage
  amountToPay: ProtoMessage
  spendingLimits: ProtoMessage
  teamId: string
}

export const buildXaiBilling = (raw: RawXaiBilling): CapabilityResult =>
  buildXaiBillingResult(buildBillingReport(raw.invoices, raw.amountToPay, raw.spendingLimits, raw.teamId))

const fetchXaiBilling = async (ctx: CollectContext<XaiConfig>): Promise<RawXaiBilling> => {
  const id = teamId(ctx)
  const [invoices, amountToPay, spendingLimits] = await Promise.all([
    unary(ctx, BILLING_SERVICE, 'ListInvoices', listInvoicesBody(id)),
    unary(ctx, BILLING_SERVICE, 'GetAmountToPay', teamIdBody(id, 10)),
    unary(ctx, BILLING_SERVICE, 'GetSpendingLimits', teamIdBody(id, 1))
  ])

  return { invoices, amountToPay, spendingLimits, teamId: id }
}

// The ListApiKeys response, decoded — the raw wire shape the build half transforms.
export interface RawXaiKeys {
  keys: ProtoMessage
}

export const buildXaiKeys = (raw: RawXaiKeys): CapabilityResult => buildXaiKeysResult(buildKeysReport(raw.keys))

const fetchXaiKeys = async (ctx: CollectContext<XaiConfig>): Promise<RawXaiKeys> => ({
  keys: await unary(ctx, AUTH_SERVICE, 'ListApiKeys', listApiKeysBody(teamId(ctx)))
})

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
  // console.x.ai sits behind Cloudflare and only accepts a real browser — Electron net.request
  // (the real browser's TLS identity) is required. cf_clearance is bound to (IP, UA, TLS identity), so the replay UA must match the
  // sign-in window UA (injected centrally).
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
      id: 'apiKeys',
      label: 'API Keys',
      fetch: fetchXaiKeys,
      build: buildXaiKeys,
      sample: sampleXaiKeys
    })
  ],
  probe: async (ctx) => {
    // One small gRPC-web call (the spending-limit RPC) proves the console session cookie reaches the API.
    await unary(ctx, BILLING_SERVICE, 'GetSpendingLimits', teamIdBody(teamId(ctx), 1))
  }
})
