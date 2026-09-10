import {
  definePlugin,
  defineCapability,
  type AuthAttachment,
  type AuthContext,
  type ButinClient,
  type CollectContext
} from '@butinapp/sdk'
import { capabilityResult, record, table, type CapabilityResult } from '@butinapp/sdk/data'
import { billing } from '@butinapp/sdk/presets'
import { centsToMajor, isoDay, round2, startCase } from '@butinapp/sdk/util'

import { sampleOxioAccount, sampleOxioBilling, sampleOxioPlan, sampleOxioSummary } from './sample.js'

// oxio (oxio.ca) — a Québec residential internet provider. The client portal (account.oxio.ca) is a Next.js
// SPA; every read is a POST to ONE GraphQL endpoint on the gaiia billing platform oxio runs on.
//
// AUTH: signing in POSTs a `Login` mutation whose `accessToken` the SPA writes into a plain `access_token`
// cookie on account.oxio.ca, then echoes as a bare `authorization` header (NO `Bearer` prefix) on every API
// call. The API host is a different origin and receives no cookie at all — so the credential is a cookie
// VALUE lifted into a header, which is the `cookie-csrf` resolve() shape. NOTE the token is a one-HOUR JWT
// with no refresh path, so replay only works within an hour of the capture; past that the API 401s, core
// wipes the session, and the UI asks to reconnect (see meta.troubleshooting).
//
// TRANSPORT: plain Node axios. The API answers `access-control-allow-origin: *` and accepts a plain client,
// and the calls set `Origin`/`Referer` (forbidden on Electron net.request), so there is no browser-engine need.
//
// MONEY is CAD in CENTS on every field (`price`, `balanceDue`, `amountRemaining`, `refererAmountInCents`),
// normalized to dollars at the edge. Dates arrive either as a plain 'YYYY-MM-DD' day or a full ISO instant.

const PORTAL_ORIGIN = 'https://account.oxio.ca'
const API_ORIGIN = 'https://api.gaiia.com'
const API_PATH = '/api'
// oxio's tenant on the multi-tenant gaiia platform — a constant of this surface, required on every call to
// scope the request to oxio's accounts.
const TENANT_ID = '8a56e12f-7743-4ecc-9475-4fb191e7bc04'
// One page of invoice history. The connection exposes cursors but the input's cursor field is not part of the
// portal's own traffic, so history is read in a single page; the invoices table is keyed, so older invoices
// accumulate on disk past this window rather than falling out of the report.
const INVOICE_PAGE_SIZE = 24

// ── types: the GraphQL wire shapes (only the fields the queries below select) ────────

export interface RawOxioContact {
  firstName?: string | null
  lastName?: string | null
  email?: string | null
  homePhone?: string | null
  mobilePhone?: string | null
}

export interface RawOxioAddress {
  line1?: string | null
  locality?: string | null
  region?: string | null
  postalCode?: string | null
}

/** A product's display name per language, keyed `product.<slug>.<name|description|features>`. */
export interface RawOxioTranslation {
  languageId?: string | null
  key?: string | null
  value?: string | null
}

export interface RawOxioProduct {
  slug?: string | null
  name?: string | null
  productCategory?: { slug?: string | null } | null
  translations?: RawOxioTranslation[] | null
  /** Free-form per-category spec; an internet plan carries `provider` + the up/down speeds in kbps. */
  rawSpecificationValue?: Record<string, unknown> | null
}

export interface RawOxioSubscription {
  /** ISO instant the subscription ended; null while it is active. */
  unassignedAt?: string | null
  version?: { id?: string | null; price?: number | null; product?: RawOxioProduct | null } | null
}

export interface RawOxioAccount {
  status?: string | null
  /** The customer number shown on the bill, zero-padded there to 8 digits. */
  gaiiaId?: number | null
  createdAt?: string | null
  referralCode?: string | null
  internetProvider?: string | null
  primaryContact?: RawOxioContact | null
  physicalAddress?: RawOxioAddress | null
  mailingAddress?: RawOxioAddress | null
  internetRequests?: { type?: string | null; status?: string | null }[] | null
  operations?: { id?: string | null; type?: string | null; status?: string | null }[] | null
  communicationPreferences?: {
    smsMessagingEnabled?: boolean | null
    emailMessagingEnabled?: boolean | null
    languagePreference?: string | null
  } | null
  clientPortalUser?: { username?: string | null; passwordLastModifiedAt?: string | null } | null
  productSubscriptions?: { edges?: ({ node?: RawOxioSubscription | null } | null)[] | null } | null
}

export interface RawOxioBillingParameters {
  billDay?: number | null
  nextBillDate?: string | null
  availableFunds?: number | null
  nextRecurringChargeAmount?: number | null
  nextRecurringChargeTaxes?: number | null
  balanceDue?: number | null
  totalBalance?: number | null
  isDelinquent?: boolean | null
}

export interface RawOxioPaymentMethod {
  id?: string | null
  createdAt?: string | null
  autoPaymentEnabled?: boolean | null
  creditCard?: {
    brand?: string | null
    maskedIdentificationNumber?: string | null
    expirationMonth?: number | null
    expirationYear?: number | null
  } | null
  bankAccount?: { maskedIdentificationNumber?: string | null } | null
}

export interface RawOxioInvoice {
  id?: string | null
  /** Still owed on this bill, in cents — the list carries no grand total. */
  amountRemaining?: number | null
  invoiceNumber?: string | null
  /** Start of the billing cycle, 'YYYY-MM-DD'. */
  fromDate?: string | null
  /** The object key the download mutation exchanges for a signed URL. */
  s3Key?: string | null
  dueDate?: string | null
}

export interface RawOxioReferral {
  id?: string | null
  firstName?: string | null
  lastName?: string | null
  refereeEmail?: string | null
  refereeSms?: string | null
  status?: string | null
  sentOn?: string | null
  creditWillBeAppliedOn?: string | null
  refererAmountInCents?: number | null
}

/** Summary + Plan + Account all read the account; Summary + Billing both read the billing parameters. */
export interface OxioSummaryRaw {
  account: RawOxioAccount | null
  params: RawOxioBillingParameters | null
}

export interface OxioBillingRaw {
  params: RawOxioBillingParameters | null
  invoices: RawOxioInvoice[]
  paymentMethods: RawOxioPaymentMethod[]
}

export interface OxioPlanRaw {
  account: RawOxioAccount | null
}

export interface OxioAccountRaw {
  account: RawOxioAccount | null
  referrals: RawOxioReferral[]
}

// ── auth: the API token lifted out of the portal's cookie jar ────────────────────────

/** The `access_token` cookie the portal's SPA writes after sign-in — the raw JWT the API expects. */
export const extractOxioToken = (cookie: string | undefined): string | undefined =>
  cookie?.match(/(?:^|;\s*)access_token=([^;]+)/)?.[1]

// Attach the token as a bare `authorization` header. No cookie is returned: the API host is cross-origin and
// the portal sends it none, so replaying the (analytics-heavy) jar there would be dead weight. A missing token
// means the capture predates sign-in — let the API answer 401 so core clears the session and re-prompts.
const resolveOxioAuth = async (ctx: AuthContext): Promise<AuthAttachment> => {
  const token = extractOxioToken(ctx.creds.get('cookie'))

  return { headers: token ? { authorization: token } : {} }
}

// ── the GraphQL endpoint ────────────────────────────────────────────────────────────

// Every operation goes to the one endpoint, named the way the portal names it — the gateway keys its routing and
// logging off `operationName`.
const gql = <T>(
  client: ButinClient,
  operationName: string,
  query: string,
  variables: Record<string, unknown> = {},
  opts: { cache?: boolean } = {}
): Promise<T> => client.graphql<T>(API_PATH, { operationName, query, variables, ...opts })

const ACCOUNT_QUERY = `query OwnAuthenticatedEntity {
  ownAuthenticatedEntity {
    __typename
    id
    ... on OwnAuthenticatedAccount {
      account {
        status
        gaiiaId
        createdAt
        referralCode
        internetProvider
        primaryContact { firstName lastName email homePhone mobilePhone }
        physicalAddress { line1 locality region postalCode }
        mailingAddress { line1 locality region postalCode }
        internetRequests { type status }
        operations { id type status }
        communicationPreferences { smsMessagingEnabled emailMessagingEnabled languagePreference }
        clientPortalUser { username passwordLastModifiedAt }
        productSubscriptions {
          edges {
            node {
              unassignedAt
              version {
                id
                price
                product {
                  slug
                  name
                  productCategory { slug }
                  translations { languageId key value }
                  rawSpecificationValue
                }
              }
            }
          }
        }
      }
    }
  }
}`

const BILLING_PARAMETERS_QUERY = `query OwnAccountBillingParameters {
  ownAccountBillingParameters {
    billDay
    nextBillDate
    availableFunds
    nextRecurringChargeAmount
    nextRecurringChargeTaxes
    balanceDue
    totalBalance
    isDelinquent
  }
}`

const INVOICES_QUERY = `query OwnInvoices($input: OwnInvoicesQueryInput!) {
  ownInvoices(input: $input) {
    edges { node { id amountRemaining invoiceNumber fromDate s3Key dueDate } }
  }
}`

const PAYMENT_METHODS_QUERY = `query OwnPaymentMethods($input: OwnPaymentMethodsQueryInput!) {
  ownPaymentMethods(input: $input) {
    edges {
      node {
        id
        createdAt
        autoPaymentEnabled
        creditCard { brand maskedIdentificationNumber expirationMonth expirationYear }
        bankAccount { maskedIdentificationNumber }
      }
    }
  }
}`

const REFERRALS_QUERY = `query OwnReferralInvitations {
  ownReferralInvitations {
    id
    firstName
    lastName
    refereeEmail
    refereeSms
    status
    sentOn
    creditWillBeAppliedOn
    refererAmountInCents
  }
}`

const INVOICE_URL_QUERY = `query ownInvoice($input: OwnInvoiceQueryInput!) {
  ownInvoice(input: $input) { url }
}`

const PROBE_QUERY = `query OwnAuthenticatedEntity { ownAuthenticatedEntity { __typename id } }`

type EntityResponse = { ownAuthenticatedEntity?: { account?: RawOxioAccount | null } | null }
type Connection<T> = { edges?: ({ node?: T | null } | null)[] | null }

const nodesOf = <T>(connection: Connection<T> | null | undefined): T[] =>
  (connection?.edges ?? []).flatMap((e) => (e?.node ? [e.node] : []))

const loadAccount = async (ctx: CollectContext): Promise<RawOxioAccount | null> =>
  (await gql<EntityResponse>(ctx.client, 'OwnAuthenticatedEntity', ACCOUNT_QUERY)).ownAuthenticatedEntity?.account ??
  null

const loadBillingParameters = async (ctx: CollectContext): Promise<RawOxioBillingParameters | null> =>
  (
    await gql<{ ownAccountBillingParameters?: RawOxioBillingParameters | null }>(
      ctx.client,
      'OwnAccountBillingParameters',
      BILLING_PARAMETERS_QUERY
    )
  ).ownAccountBillingParameters ?? null

// ── shared account normalizers ──────────────────────────────────────────────────────

const subscriptionsOf = (account: RawOxioAccount | null): RawOxioSubscription[] =>
  nodesOf(account?.productSubscriptions)

/** A subscription is live until it is unassigned — the ended ones stay in the list as service history. */
const isActive = (sub: RawOxioSubscription): boolean => !sub.unassignedAt

/**
 * A product's user-facing name. The bare `name` is oxio's internal one ('Cogeco100_QC'); the customer-facing
 * one is the English `…name` translation ('Internet: ⬇️ 100 Mbps ⬆️ 10 Mbps [QC]').
 */
export const oxioProductName = (product: RawOxioProduct | null | undefined): string => {
  const translated = product?.translations?.find((t) => t.languageId === 'en' && t.key?.endsWith('.name'))?.value

  return translated?.trim() || product?.name?.trim() || product?.slug?.trim() || 'Unknown'
}

const specNumber = (product: RawOxioProduct | null | undefined, key: string): number | null => {
  const value = product?.rawSpecificationValue?.[key]

  return typeof value === 'number' ? value : null
}

const kbpsToMbps = (kbps: number | null): number | null => (kbps == null ? null : round2(kbps / 1000))

/** The active internet plan — the subscription that carries the recurring service, not an add-on or a credit. */
const internetPlanOf = (subs: RawOxioSubscription[]): RawOxioSubscription | undefined =>
  subs.filter(isActive).find((s) => s.version?.product?.productCategory?.slug === 'internet-plan')

/** The recurring monthly charge = the prices of every live subscription, in dollars. */
export const oxioMonthlyCharge = (subs: RawOxioSubscription[]): number | null => {
  const live = subs.filter(isActive)

  return live.length ? round2(live.reduce((sum, s) => sum + centsToMajor(s.version?.price), 0)) : null
}

/** The customer number as it reads on the bill — zero-padded to 8 digits. */
export const oxioAccountNumber = (account: RawOxioAccount | null): string | null =>
  account?.gaiiaId == null ? null : String(account.gaiiaId).padStart(8, '0')

const formatAddress = (address: RawOxioAddress | null | undefined): string | null => {
  const parts = [address?.line1, address?.locality, [address?.region, address?.postalCode].filter(Boolean).join(' ')]
    .map((p) => p?.trim())
    .filter(Boolean)

  return parts.length ? parts.join(', ') : null
}

// ── Summary: the recurring charge + where the account stands ────────────────────────

export const buildOxioSummary = (raw: OxioSummaryRaw): CapabilityResult => {
  const subs = subscriptionsOf(raw.account)
  const plan = internetPlanOf(subs)
  const params = raw.params

  return billing.summary({
    currentMtd: oxioMonthlyCharge(subs),
    currentMtdLabel: 'Monthly charge',
    // The live subscriptions' recurring price. Taxes and one-off credits are applied on the bill itself and
    // aren't exposed by the API, so this is the plan charge rather than the invoice total.
    currentMtdCaption: 'before taxes and credits',
    mtdBasis: 'flat',
    // Omitted (not em-dashed) when nothing is subscribed — there is no plan to name.
    plan: plan ? oxioProductName(plan.version?.product) : undefined,
    // The invoice list carries only what is still OWED on each bill, never its total, so there is no per-month
    // spend to chart from it. The monthly bars accrue instead from the captured recurring charge, which core
    // backfills for an accrual basis — an empty chart on the first fetch that fills in month by month.
    invoices: [],
    stats: [
      {
        key: 'balanceDue',
        label: 'Balance due',
        role: 'money',
        value: params ? centsToMajor(params.balanceDue) : null
      },
      { key: 'nextBill', label: 'Next bill', role: 'timestamp', value: isoDay(params?.nextBillDate) ?? null },
      { key: 'status', label: 'Status', role: 'status', value: raw.account?.status ?? null },
      { key: 'accountNumber', label: 'Account', role: 'identifier', value: oxioAccountNumber(raw.account) }
    ]
  })
}

const fetchOxioSummary = async (ctx: CollectContext): Promise<OxioSummaryRaw> => ({
  account: await loadAccount(ctx),
  params: await loadBillingParameters(ctx)
})

// ── Billing: the cycle, how it is paid, and every bill PDF ──────────────────────────

interface OxioCycleRow {
  billDay: number | null
  nextBillDate: string | null
  nextCharge: number | null
  taxes: number | null
  balanceDue: number | null
  totalBalance: number | null
  availableFunds: number | null
  paymentStatus: string | null
}

interface OxioPaymentRow {
  id: string
  method: string
  last4: string | null
  expires: string | null
  autoPay: string
  createdAt: string | null
}

interface OxioInvoiceRow {
  id: string
  fromDate: string | null
  invoiceNumber: string | null
  dueDate: string | null
  balance: number | null
  status: string
  // Hidden — the download key the mint call needs, and the saved file's name.
  s3Key: string | null
  name: string
}

const cardExpiry = (month?: number | null, year?: number | null): string | null =>
  month && year ? `${String(month).padStart(2, '0')}/${year}` : null

export const buildOxioBilling = (raw: OxioBillingRaw): CapabilityResult => {
  const params = raw.params
  const cycle = record<OxioCycleRow>({
    id: 'cycle',
    fields: [
      { key: 'nextBillDate', label: 'Next bill', role: 'timestamp' },
      { key: 'billDay', label: 'Bill day', role: 'count' },
      { key: 'nextCharge', label: 'Next charge', role: 'money' },
      { key: 'taxes', label: 'Taxes', role: 'money' },
      { key: 'balanceDue', label: 'Balance due', role: 'money' },
      { key: 'totalBalance', label: 'Total balance', role: 'money' },
      { key: 'availableFunds', label: 'Available funds', role: 'money' },
      { key: 'paymentStatus', label: 'Payment status', role: 'status' }
    ],
    value: {
      nextBillDate: isoDay(params?.nextBillDate) ?? null,
      billDay: params?.billDay ?? null,
      nextCharge: params ? centsToMajor(params.nextRecurringChargeAmount) : null,
      taxes: params ? centsToMajor(params.nextRecurringChargeTaxes) : null,
      balanceDue: params ? centsToMajor(params.balanceDue) : null,
      totalBalance: params ? centsToMajor(params.totalBalance) : null,
      availableFunds: params ? centsToMajor(params.availableFunds) : null,
      paymentStatus: params == null ? null : params.isDelinquent ? 'Delinquent' : 'Current'
    }
  })

  const payments = table<OxioPaymentRow>({
    id: 'paymentMethods',
    columns: [
      { key: 'method', label: 'Method', role: 'category' },
      { key: 'last4', label: 'Last 4', role: 'identifier' },
      { key: 'expires', label: 'Expires', role: 'text' },
      { key: 'autoPay', label: 'Auto-pay', role: 'status', badges: { Enabled: 'success', Disabled: 'neutral' } },
      { key: 'createdAt', label: 'Added', role: 'timestamp' },
      { key: 'id', role: 'identifier', hidden: true }
    ],
    rows: raw.paymentMethods.map((pm) => ({
      id: pm.id ?? '',
      method: pm.creditCard?.brand ? startCase(pm.creditCard.brand) : 'Bank account',
      last4: pm.creditCard?.maskedIdentificationNumber ?? pm.bankAccount?.maskedIdentificationNumber ?? null,
      expires: cardExpiry(pm.creditCard?.expirationMonth, pm.creditCard?.expirationYear),
      autoPay: pm.autoPaymentEnabled ? 'Enabled' : 'Disabled',
      createdAt: isoDay(pm.createdAt) ?? null
    })),
    key: 'id'
  })

  const invoices = table<OxioInvoiceRow>({
    id: 'invoices',
    columns: [
      { key: 'fromDate', label: 'Date', role: 'timestamp' },
      { key: 'invoiceNumber', label: 'Invoice', role: 'identifier' },
      { key: 'dueDate', label: 'Due', role: 'timestamp' },
      // What is still owed on the bill, not its total — the connection exposes no grand total.
      { key: 'balance', label: 'Balance', role: 'money' },
      { key: 'status', label: 'Status', role: 'status', badges: { Outstanding: 'warning' } },
      { key: 's3Key', role: 'identifier', hidden: true },
      { key: 'id', role: 'identifier', hidden: true },
      { key: 'name', role: 'label', hidden: true }
    ],
    rows: raw.invoices.map((inv) => ({
      id: inv.id ?? inv.invoiceNumber ?? inv.fromDate ?? '',
      fromDate: inv.fromDate ?? null,
      invoiceNumber: inv.invoiceNumber ?? null,
      dueDate: inv.dueDate ?? null,
      balance: centsToMajor(inv.amountRemaining),
      status: (inv.amountRemaining ?? 0) > 0 ? 'Outstanding' : 'Paid',
      s3Key: inv.s3Key ?? null,
      name: `Invoice ${inv.fromDate ?? inv.invoiceNumber ?? 'unknown'}`
    })),
    key: 'id'
  })

  return capabilityResult({
    sections: [
      cycle.keyvalue({ title: 'Billing cycle' }),
      raw.paymentMethods.length > 0 ? payments.table({ title: 'Payment methods' }) : null,
      // Each bill's PDF lives behind a short-lived signed URL the API mints per download, so the bytes come
      // from fetchFile rather than a URL column.
      invoices.fileTable({ title: 'Invoices', name: 'name', source: { fetch: true }, ext: 'pdf', category: 'Invoices' })
    ]
  })
}

const fetchOxioBilling = async (ctx: CollectContext): Promise<OxioBillingRaw> => {
  const params = await loadBillingParameters(ctx)
  const invoices = await gql<{ ownInvoices?: Connection<RawOxioInvoice> | null }>(
    ctx.client,
    'OwnInvoices',
    INVOICES_QUERY,
    {
      input: { first: INVOICE_PAGE_SIZE }
    }
  )
  const paymentMethods = await gql<{ ownPaymentMethods?: Connection<RawOxioPaymentMethod> | null }>(
    ctx.client,
    'OwnPaymentMethods',
    PAYMENT_METHODS_QUERY,
    { input: {} }
  )

  return {
    params,
    invoices: nodesOf(invoices.ownInvoices),
    paymentMethods: nodesOf(paymentMethods.ownPaymentMethods)
  }
}

const isPdf = (bytes: Uint8Array): boolean =>
  bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46

const fetchOxioInvoicePdf = async (ctx: CollectContext, row: Record<string, unknown>): Promise<Uint8Array> => {
  const key = typeof row.s3Key === 'string' ? row.s3Key : ''

  if (!key) {
    throw new Error('oxio: no document key on this invoice row')
  }

  // The minted URL expires in 30 seconds, so this call must never be served from (or written to) the query
  // cache — a replayed URL would already be dead.
  const minted = await gql<{ ownInvoice?: { url?: string | null } | null }>(
    ctx.client,
    'ownInvoice',
    INVOICE_URL_QUERY,
    { input: { key } },
    { cache: false }
  )
  const url = minted.ownInvoice?.url

  if (!url) {
    throw new Error(`oxio: no download URL for invoice ${key}`)
  }

  // The URL carries its own AWS signature; presenting the API's `authorization` header alongside it makes S3
  // reject the request for using two auth mechanisms, so both the header and the jar are dropped for this hop.
  const res = await ctx.client.request<ArrayBuffer>({
    url,
    responseType: 'arraybuffer',
    sendAuth: false,
    sendCookie: false,
    headers: { Accept: 'application/pdf,*/*' }
  })
  const bytes = new Uint8Array(res.data)

  ctx.log(`oxio: downloaded invoice ${key} (${bytes.length}b)`)

  // A non-PDF body is an expired-URL error document — fail loudly rather than save it as a bill.
  if (!isPdf(bytes)) {
    throw new Error(`oxio: invoice ${key} download wasn't a PDF (${bytes.length}b)`)
  }

  return bytes
}

// ── Plan: what the subscription actually buys ───────────────────────────────────────

interface OxioServiceRow {
  plan: string | null
  provider: string | null
  download: number | null
  upload: number | null
  devices: number | null
  price: number | null
  address: string | null
}

interface OxioSubscriptionRow {
  product: string
  category: string | null
  price: number | null
  status: string
  ended: string | null
}

interface OxioRequestRow {
  type: string
  status: string | null
}

export const buildOxioPlan = (raw: OxioPlanRaw): CapabilityResult => {
  const account = raw.account
  const subs = subscriptionsOf(account)
  const plan = internetPlanOf(subs)
  const product = plan?.version?.product

  const service = record<OxioServiceRow>({
    id: 'service',
    fields: [
      { key: 'plan', label: 'Plan', role: 'label' },
      { key: 'provider', label: 'Network', role: 'label' },
      { key: 'download', label: 'Download (Mbps)', role: 'count' },
      { key: 'upload', label: 'Upload (Mbps)', role: 'count' },
      { key: 'devices', label: 'Supported devices', role: 'count' },
      { key: 'price', label: 'Price', role: 'money' },
      { key: 'address', label: 'Service address', role: 'text' }
    ],
    value: {
      plan: product ? oxioProductName(product) : null,
      provider: account?.internetProvider ? startCase(account.internetProvider) : null,
      download: kbpsToMbps(specNumber(product, 'downloadSpeedInKbps')),
      upload: kbpsToMbps(specNumber(product, 'maxUploadSpeedInKbps')),
      devices: specNumber(product, 'supportedDevices'),
      price: plan ? centsToMajor(plan.version?.price) : null,
      address: formatAddress(account?.physicalAddress)
    }
  })

  const subscriptions = table<OxioSubscriptionRow>({
    id: 'subscriptions',
    columns: [
      { key: 'product', label: 'Product', role: 'label' },
      { key: 'category', label: 'Category', role: 'category' },
      { key: 'price', label: 'Price', role: 'money' },
      { key: 'status', label: 'Status', role: 'status', badges: { Ended: 'neutral' } },
      { key: 'ended', label: 'Ended', role: 'timestamp' }
    ],
    // Every subscription the account ever held comes back on each fetch, so this list is authoritative as-is.
    rows: subs.map((sub) => ({
      product: oxioProductName(sub.version?.product),
      category: sub.version?.product?.productCategory?.slug ?? null,
      price: centsToMajor(sub.version?.price),
      status: isActive(sub) ? 'Active' : 'Ended',
      ended: isoDay(sub.unassignedAt) ?? null
    }))
  })

  // The provisioning trail behind the service: the account-level operations plus the internet install/transfer
  // requests, which the API keeps as two lists of the same thing.
  const requestRows: OxioRequestRow[] = [
    ...(account?.operations ?? []).map((op) => ({ type: startCase(op.type ?? 'Unknown'), status: op.status ?? null })),
    ...(account?.internetRequests ?? []).map((r) => ({
      type: startCase(r.type ?? 'Unknown'),
      status: r.status ?? null
    }))
  ]
  const requests = table<OxioRequestRow>({
    id: 'requests',
    columns: [
      { key: 'type', label: 'Request', role: 'category' },
      { key: 'status', label: 'Status', role: 'status' }
    ],
    rows: requestRows
  })

  return capabilityResult({
    sections: [
      service.keyvalue({ title: 'Internet service' }),
      subs.length > 0 ? subscriptions.table({ title: 'Subscriptions' }) : null,
      requestRows.length > 0 ? requests.table({ title: 'Service requests' }) : null
    ]
  })
}

const fetchOxioPlan = async (ctx: CollectContext): Promise<OxioPlanRaw> => ({ account: await loadAccount(ctx) })

// ── Account: who the account belongs to, and its referrals ──────────────────────────

interface OxioHolderRow {
  name: string | null
  email: string | null
  mobilePhone: string | null
  homePhone: string | null
  username: string | null
  createdAt: string | null
  passwordChanged: string | null
  language: string | null
  notifications: string | null
  referralCode: string | null
}

interface OxioAddressRow {
  service: string | null
  mailing: string | null
}

interface OxioReferralRow {
  id: string
  name: string | null
  contact: string | null
  status: string | null
  sentOn: string | null
  credit: number | null
  creditOn: string | null
}

/** The channels oxio is allowed to message on, as one line; null when the account exposes no preferences. */
const notificationChannels = (prefs: RawOxioAccount['communicationPreferences']): string | null => {
  if (!prefs) {
    return null
  }

  const enabled = [prefs.emailMessagingEnabled ? 'Email' : null, prefs.smsMessagingEnabled ? 'SMS' : null].filter(
    Boolean
  )

  return enabled.length ? enabled.join(' · ') : 'None'
}

const fullName = (first?: string | null, last?: string | null): string | null =>
  [first?.trim(), last?.trim()].filter(Boolean).join(' ') || null

export const buildOxioAccount = (raw: OxioAccountRaw): CapabilityResult => {
  const account = raw.account
  const contact = account?.primaryContact

  const holder = record<OxioHolderRow>({
    id: 'holder',
    fields: [
      { key: 'name', label: 'Name', role: 'label' },
      { key: 'email', label: 'Email', role: 'text' },
      { key: 'mobilePhone', label: 'Mobile', role: 'text' },
      { key: 'homePhone', label: 'Home phone', role: 'text' },
      { key: 'username', label: 'Username', role: 'text' },
      { key: 'createdAt', label: 'Customer since', role: 'timestamp' },
      { key: 'passwordChanged', label: 'Password changed', role: 'timestamp' },
      { key: 'language', label: 'Language', role: 'label' },
      { key: 'notifications', label: 'Notifications', role: 'text' },
      { key: 'referralCode', label: 'Referral code', role: 'identifier' }
    ],
    value: {
      name: fullName(contact?.firstName, contact?.lastName),
      email: contact?.email ?? null,
      mobilePhone: contact?.mobilePhone ?? null,
      homePhone: contact?.homePhone ?? null,
      username: account?.clientPortalUser?.username ?? null,
      createdAt: isoDay(account?.createdAt) ?? null,
      passwordChanged: isoDay(account?.clientPortalUser?.passwordLastModifiedAt) ?? null,
      language: account?.communicationPreferences?.languagePreference?.toUpperCase() ?? null,
      notifications: notificationChannels(account?.communicationPreferences),
      referralCode: account?.referralCode ?? null
    }
  })

  const addresses = record<OxioAddressRow>({
    id: 'addresses',
    fields: [
      { key: 'service', label: 'Service address', role: 'text' },
      { key: 'mailing', label: 'Mailing address', role: 'text' }
    ],
    value: { service: formatAddress(account?.physicalAddress), mailing: formatAddress(account?.mailingAddress) }
  })

  const referrals = table<OxioReferralRow>({
    id: 'referrals',
    columns: [
      { key: 'name', label: 'Name', role: 'label' },
      { key: 'contact', label: 'Contact', role: 'text' },
      { key: 'status', label: 'Status', role: 'status' },
      { key: 'sentOn', label: 'Sent', role: 'timestamp' },
      { key: 'credit', label: 'Credit', role: 'money' },
      { key: 'creditOn', label: 'Credit applied', role: 'timestamp' },
      { key: 'id', role: 'identifier', hidden: true }
    ],
    rows: raw.referrals.map((r) => ({
      id: r.id ?? '',
      name: fullName(r.firstName, r.lastName),
      contact: r.refereeEmail ?? r.refereeSms ?? null,
      status: r.status ?? null,
      sentOn: isoDay(r.sentOn) ?? null,
      credit: centsToMajor(r.refererAmountInCents),
      creditOn: isoDay(r.creditWillBeAppliedOn) ?? null
    })),
    key: 'id'
  })

  return capabilityResult({
    sections: [
      holder.keyvalue({ title: 'Account holder' }),
      addresses.keyvalue({ title: 'Addresses' }),
      raw.referrals.length > 0 ? referrals.table({ title: 'Referrals' }) : null
    ]
  })
}

const fetchOxioAccount = async (ctx: CollectContext): Promise<OxioAccountRaw> => {
  const account = await loadAccount(ctx)
  // Best-effort: a referral-less account still renders the holder + addresses.
  const referrals = await gql<{ ownReferralInvitations?: RawOxioReferral[] | null }>(
    ctx.client,
    'OwnReferralInvitations',
    REFERRALS_QUERY
  ).catch(() => null)

  return { account, referrals: referrals?.ownReferralInvitations ?? [] }
}

// ── i18n ────────────────────────────────────────────────────────────────────────────
// oxio is a Québec service whose own portal is French-first; these are the labels this plugin emits that the
// app's shared en→fr dictionary doesn't already carry.
const OXIO_FR: Record<string, string> = {
  'Monthly charge': 'Frais mensuels',
  'before taxes and credits': 'avant taxes et crédits',
  'Balance due': 'Solde dû',
  'Total balance': 'Solde total',
  'Available funds': 'Fonds disponibles',
  'Next bill': 'Prochaine facture',
  'Bill day': 'Jour de facturation',
  Taxes: 'Taxes',
  'Billing cycle': 'Cycle de facturation',
  'Payment methods': 'Modes de paiement',
  Method: 'Mode',
  'Auto-pay': 'Paiement automatique',
  Enabled: 'Activé',
  Disabled: 'Désactivé',
  Added: 'Ajouté',
  Current: 'À jour',
  Delinquent: 'En souffrance',
  Invoice: 'Facture',
  Due: 'Échéance',
  Balance: 'Solde',
  Paid: 'Payée',
  Outstanding: 'Impayée',
  'Internet service': 'Service Internet',
  Network: 'Réseau',
  'Download (Mbps)': 'Téléchargement (Mbit/s)',
  'Upload (Mbps)': 'Téléversement (Mbit/s)',
  'Supported devices': 'Appareils pris en charge',
  Price: 'Prix',
  'Service address': 'Adresse du service',
  Subscriptions: 'Abonnements',
  Category: 'Catégorie',
  Active: 'Actif',
  Ended: 'Terminé',
  'Service requests': 'Demandes de service',
  Request: 'Demande',
  'Account holder': 'Titulaire du compte',
  Mobile: 'Cellulaire',
  'Home phone': 'Téléphone résidentiel',
  'Password changed': 'Mot de passe modifié',
  Language: 'Langue',
  Notifications: 'Notifications',
  None: 'Aucune',
  'Referral code': 'Code de référence',
  Referrals: 'Références',
  Addresses: 'Adresses',
  'Mailing address': 'Adresse postale',
  Contact: 'Contact',
  Sent: 'Envoyée',
  Credit: 'Crédit',
  'Credit applied': 'Crédit appliqué'
}

// ── descriptor ──────────────────────────────────────────────────────────────────────

export const oxioPlugin = definePlugin({
  reportingCurrency: 'CAD',
  meta: {
    id: 'oxio',
    name: 'oxio',
    vendor: 'oxio',
    category: 'utilities',
    color: '#2f2e2e',
    homepage: 'https://oxio.ca',
    dashboardUrl: `${PORTAL_ORIGIN}/`,
    description: 'oxio internet — the recurring charge, billing cycle, payment methods, plan, and bill PDFs.',
    messages: { fr: OXIO_FR },
    troubleshooting: {
      'session-expired': {
        hint: 'oxio issues a one-hour API token with no refresh, so the connection lapses quickly. Reconnect, then refresh right away.'
      }
    }
  },
  session: {
    loginUrl: `${PORTAL_ORIGIN}/`,
    // The portal is locale-routed — the signed-in area is /fr/espace-client/… or /en/client-portal/….
    dashboardMarkers: ['/espace-client/', '/client-portal/'],
    cookieDomains: ['oxio.ca'],
    // The SPA writes the API token here once sign-in completes; without it the jar is still pre-login.
    requiredCookie: 'access_token'
  },
  // The credential is the `access_token` cookie value, replayed as the API's `authorization` header — the
  // cookie-value-into-a-header shape (see resolveOxioAuth).
  auth: { kind: 'cookie-csrf', resolve: resolveOxioAuth },
  transport: {
    baseUrl: API_ORIGIN,
    // The portal's own cross-origin call headers; the tenant id scopes every request to oxio's accounts.
    defaultHeaders: { Origin: PORTAL_ORIGIN, Referer: `${PORTAL_ORIGIN}/`, 'x-tenant-id': TENANT_ID }
  },
  capabilities: [
    defineCapability({
      id: 'summary',
      label: 'Summary',
      fetch: fetchOxioSummary,
      build: buildOxioSummary,
      sample: sampleOxioSummary
    }),
    defineCapability({
      id: 'billing',
      label: 'Billing',
      fetch: fetchOxioBilling,
      build: buildOxioBilling,
      sample: sampleOxioBilling,
      fetchFile: fetchOxioInvoicePdf
    }),
    defineCapability({ id: 'plan', label: 'Plan', fetch: fetchOxioPlan, build: buildOxioPlan, sample: sampleOxioPlan }),
    defineCapability({
      id: 'account',
      label: 'Account',
      fetch: fetchOxioAccount,
      build: buildOxioAccount,
      sample: sampleOxioAccount
    })
  ],
  // The smallest authed query there is — it returns the account id and nothing else.
  probe: async (ctx) => {
    await gql(ctx.client, 'OwnAuthenticatedEntity', PROBE_QUERY)
  }
})
