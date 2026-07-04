import { defineCapability, definePlugin, type BrowserPage, type CollectContext } from '@butinapp/sdk'
import { capabilityResult, record, table, type CapabilityResult, type MonthPoint } from '@butinapp/sdk/data'
import { capitalize } from '@butinapp/sdk/libs'
import { billing } from '@butinapp/sdk/presets'
import { epochMsDay, parseFrAmount, round2 } from '@butinapp/sdk/util'

import { sampleVidetronAccounts, sampleVidetronBillingDetail, sampleVidetronMobile } from './sample.js'

// ── constants ───────────────────────────────────────────────────────────────────────
// The "My Account" SPA the user signs into (Okta → Keycloak "marvel" realm OIDC). Booted offscreen by core
// to mint the in-memory Bearer (spa-bearer). Its data API is the "marvel" backend on zone.videotron.com.
const PORTAL_URL = 'https://moncompte.videotron.com'
const ZONE_BASE = 'https://zone.videotron.com'

// The LEGACY "espace client" platform (`monespace`). Videotron splits one customer across two backends —
// internet/cable on the modern marvel API above, MOBILE (and pre-migration invoice history) on monespace —
// each its own host with its OWN minted Bearer. Wired as a secondary `backend` so `ctx.clientFor('monespace')`
// reaches it. Its SPA mints the monespace Bearer when booted; the offscreen boot rides the same SSO session.
const MONESPACE_BASE = 'https://monespace.videotron.com'
const MONESPACE_BOOT_URL = `${MONESPACE_BASE}/client/residential/Customer-Centre`

// The legacy invoice list + PDFs live behind monespace's Struts `/secur/` OIDC filter, whose session is
// short-lived + server-side: a real browser tab holds it open, but a one-shot headless net.request finds it
// already torn down ("Redirect To Login" — the cookies replay but the servlet auto-logs-out the bare request).
// So the invoice list + per-row PDFs run through the live offscreen browser (`ctx.browser`), which navigates
// the real page (Sec-Fetch-*, runs the JS handshake) and holds the session warm. The DisplayFacture servlet
// drives both the list (dispatch=displayFacture) and each PDF (dispatch=displayFacturePdf).
const MONESPACE_INVOICE_FORM = `${MONESPACE_BASE}/client/user-management/residentiel/secur/DisplayFactureForm.do`
const LEGACY_LIST_URL = `${MONESPACE_INVOICE_FORM}?dispatch=displayFacture&appId=EC`

// Every per-user dollar amount is already CAD dollars on the wire (e.g. 91.98), not cents.
const CURRENCY = 'CAD'

// webRequest filter for the Bearer-capture interceptor: the SPA attaches its OIDC access token only on
// calls to the marvel backend, so that's where core lifts the `Authorization: Bearer …` off the wire.
const AUTH_CAPTURE_URL_PATTERNS = ['https://zone.videotron.com/*']

// monespace attaches its (different) Bearer only on its `/rest/*` API calls. Both monespace backends boot the
// same SPA (so the legacy backend's boot also establishes the /client session cookies in the partition).
const MONESPACE_AUTH_CAPTURE_URL_PATTERNS = ['https://monespace.videotron.com/rest/*']

// ── types ─────────────────────────────────────────────────────────────────────────
// The marvel backend wraps single-object + list payloads in a { data, operationResult } envelope on most
// endpoints; a few (billingAccounts, inquireBillingAccountsWithInvoiceInfo) return the array bare.
interface Envelope<T> {
  data: T
}

interface RawUser {
  customerId: number
  name?: string
  uname?: string
  firstName?: string
  lastName?: string
}

export interface RawInvoiceInfo {
  invoiceNumber?: string
  invoiceDate?: number // epoch ms
  dueDate?: number // epoch ms
  dueAmount?: number // CAD dollars
  openAmount?: number
  totalPayableAmount?: number
  isoCurrencyCode?: string
  docIdFr?: string // the document id `marvel/invoice/document` needs to return the invoice PDF
}

// monespace `/rest/api/invoices/last` — the current mobile invoice (dates already 'YYYY-MM-DD').
interface RawMonespaceInvoice {
  invoiceDate?: string
  amount?: number // CAD dollars
  balance?: number
  payment?: number
  dueDate?: string
  availableOnline?: boolean
}

// monespace `/rest/api/wcc/dashboard/customer` — the mobile dashboard rollup (payment + period + balance).
interface RawWccDashboard {
  payment?: { data?: { automaticWithdrawal?: boolean } }
  account?: { data?: { startDate?: string; endDate?: string; nbDaysLeftInPeriod?: number; services?: string[] } }
  billing?: { data?: { balance?: number; dueDate?: string } }
}

// monespace `/rest/api/user` — the legacy account identity.
interface RawMonespaceUser {
  accountNumber?: string
  firstname?: string
  lastname?: string
}

// What the mobile tab gathers from the monespace Bearer API before normalizing.
export interface MobileBundle {
  last: RawMonespaceInvoice
  dashboard?: RawWccDashboard
  user?: RawMonespaceUser
}

interface RawInvoiceAccount {
  accountId: number
  acctNo?: string
  invoiceInfo?: RawInvoiceInfo
}

export interface RawFinancialInfo {
  currentBalance?: number // CAD dollars
  lastInvoiceAmount?: number
  monthlyPayment?: number
  paymentDueDate?: number // epoch ms
  recentCreditRating?: string
}

// `activeBillingAccountsWithInvoiceInfoList` — one paged year of real billed invoices, each with a docIdFr.
interface RawInvoiceListEntry {
  invoiceInfo?: RawInvoiceInfo
  acctNo?: string
}
interface RawInvoiceListPage {
  content?: RawInvoiceListEntry[]
}

export interface RawPlanAccount {
  customerBillingAccount?: {
    acctNo?: string
    statusName?: string
    invoiceAccountId?: number
  }
  serviceAddress?: { addrDesc?: string }
  familyCategoryShortCode?: string
}

// What billing's collect() gathers before normalizing: the financial standing + the real invoice history.
export interface BillingBundle {
  financial: RawFinancialInfo
  invoices: RawInvoiceInfo[] // newest-first off the wire; build*() sorts ascending
}

// The full raw billing fetch carries the resolved invoice billing-account id alongside the bundle — the id is
// discovered (not a wire field) and the invoices table needs it for the per-row PDF fetchFile.
export interface BillingRaw {
  bundle: BillingBundle
  billingAccountId: string
}

// The Billing tab's raw fetch: the marvel billing bundle + the legacy mobile invoice links, merged into one
// downloadable invoice table by build. (`LegacyInvoiceLink` is the scraped per-PDF ref, defined below.)
export interface BillingDetailRaw {
  billing: BillingRaw
  mobileLinks: LegacyInvoiceLink[]
}

// ── shared discovery ─────────────────────────────────────────────────────────────────
// Every per-user endpoint is keyed by the customer id (cid) and/or the invoice billing account id, neither
// of which the renderer knows. /auth/inquireUser is the cheap bootstrap that resolves the cid; the invoice
// account id then comes off the billing-accounts list.

const fetchCustomerId = async (ctx: CollectContext): Promise<number> => {
  const me = await ctx.client.get<Envelope<RawUser>>(`${ZONE_BASE}/auth/inquireUser`)
  const cid = me?.data?.customerId

  if (!cid) {
    throw new Error('could not resolve customerId from /auth/inquireUser')
  }

  return cid
}

// The invoice (parent) account carries the embedded current-invoice info and is the id the financial +
// payment-history endpoints expect. Pick the account that actually has invoiceInfo, else the first one.
const fetchInvoiceAccount = async (ctx: CollectContext, customerId: number): Promise<RawInvoiceAccount> => {
  const accounts = await ctx.client.get<RawInvoiceAccount[]>(
    `${ZONE_BASE}/integration/inquireBillingAccountsWithInvoiceInfo/${customerId}`
  )
  const list = Array.isArray(accounts) ? accounts : []
  const account = list.find((a) => a.invoiceInfo) ?? list[0]

  if (!account?.accountId) {
    throw new Error('no billing account returned for customer')
  }

  return account
}

// The real billed-invoice history for a set of years (one page each — a year of monthly bills is well under
// one page of 25). Each entry carries the docIdFr the PDF endpoint needs, so this one list drives BOTH the
// billing invoices table/chart and the Documents tab. De-duped by docIdFr across the per-year queries.
const fetchInvoiceInfoList = async (
  ctx: CollectContext,
  customerId: number,
  billingAccountId: number,
  years: number[]
): Promise<RawInvoiceInfo[]> => {
  const pages = await Promise.all(
    years.map((year) =>
      ctx.client
        .post<RawInvoiceListPage>(`${ZONE_BASE}/marvel/customer/activeBillingAccountsWithInvoiceInfoList`, {
          customerId,
          billingAccountId,
          year,
          page: 1,
          size: 25
        })
        .then((r) => (r?.content ?? []).map((e) => e.invoiceInfo).filter((i): i is RawInvoiceInfo => Boolean(i)))
        .catch(() => [] as RawInvoiceInfo[])
    )
  )

  const byDoc = new Map<string, RawInvoiceInfo>()

  for (const inv of pages.flat()) {
    byDoc.set(inv.docIdFr ?? inv.invoiceNumber ?? String(inv.invoiceDate), inv)
  }

  return [...byDoc.values()]
}

// ── billing: financial standing + the real invoice history (the headline tab) ─────────

// The account headline stat: the most recent statement's amount (no live month-to-date accrual on a consumer
// telecom bill) + the month-over-month delta + an (always-null) plan slot.
interface BillingAccountRow {
  currentMtd: number | null
  momDelta: number
  plan: string | null
}

// The financial standing the invoice list can't show — its own keyvalue record (on the Billing tab).
interface BalanceRow {
  currentBalance: number | null
  dueDate: string | null
  creditRating: string | null
}

// One downloadable invoice row, ACROSS both surfaces. `date`/`amount`/`status`/`type` render (status is null
// for a legacy mobile invoice — its list has no paid/open state). `type` is the groupBy key (its
// values head the collapsible sections). The rest ride hidden for the capability's fetchFile to replay the
// right download: marvel invoices via `docId` + `billingAccountId` (POST), legacy mobile invoices via the
// scraped `dateFacturation`/`medium`/`resourceVersion` (browser).
interface InvoiceRow {
  date: string | null
  amount: number | null
  status: string | null
  type: string
  name: string
  docId: string | null
  billingAccountId: string
  dateFacturation: string
  medium: string
  resourceVersion: string
}

// The two invoice types share one downloadable table, so their groupBy section headers read as the literal
// the user sees ("Invoice" / "Mobile invoice").
const INVOICE_TYPE = 'Invoice'
const MOBILE_INVOICE_TYPE = 'Mobile invoice'

// The real billed marvel invoices, oldest-first (reads like a statement). openAmount 0 = settled. Feeds the
// Summary chart/spark AND the Billing table.
const sortedMarvelInvoices = (invoices: RawInvoiceInfo[]): RawInvoiceInfo[] =>
  invoices
    .filter((i) => i.invoiceDate)
    .sort((a, b) => (epochMsDay(a.invoiceDate) ?? '').localeCompare(epochMsDay(b.invoiceDate) ?? ''))

// Summary tab — the at-a-glance headline: the current-month stat + the monthly-spend chart (the Overview
// spark), and the ONLY tab that emits the spend.mtd rollup. No tables, no balance — Billing owns the detail.
export const buildBillingSummary = (
  { invoices }: BillingBundle,
  mobileLinks: LegacyInvoiceLink[] = []
): CapabilityResult => {
  // The monthly spend history sums BOTH billed surfaces per month — the marvel invoices and the legacy mobile
  // bills — so a month with an internet bill AND a mobile bill reads as their total, not the marvel line alone.
  const months = billing.monthlySpend([
    ...sortedMarvelInvoices(invoices).map((i) => ({
      date: epochMsDay(i.invoiceDate) ?? undefined,
      amount: i.totalPayableAmount ?? i.dueAmount ?? 0,
      status: (i.openAmount ?? 0) > 0 ? 'Open' : 'Paid'
    })),
    ...mobileLinks.map((l) => ({ date: l.date ?? undefined, amount: l.amount ?? 0, status: 'Paid' }))
  ])
  // The headline is the latest billed month's total — the SUM of that month's invoices (internet + mobile),
  // read straight off the monthly rollup, not a single lastInvoiceAmount field.
  const currentMtd = months.at(-1)?.amount ?? null
  // An invoiced figure IS the latest month in the series, so it's compared against the prior month.
  const baseline = months.at(-2)
  const momDelta = currentMtd != null && baseline ? round2(currentMtd - baseline.amount) : undefined

  const account = record<BillingAccountRow>({
    id: 'account',
    fields: [
      { key: 'currentMtd', label: 'This month', role: 'money', currency: CURRENCY },
      ...(momDelta !== undefined
        ? [{ key: 'momDelta' as const, label: 'Δ vs last month', role: 'money' as const, currency: CURRENCY }]
        : []),
      { key: 'plan', label: 'Plan', role: 'label' }
    ] as never,
    value: { currentMtd, momDelta: momDelta ?? 0, plan: null } as never
  })

  const monthly = table<MonthPoint>({
    id: 'monthly',
    columns: [
      { key: 'month', label: 'Month', role: 'timestamp' },
      { key: 'amount', label: 'Spend', role: 'money', currency: CURRENCY }
    ],
    rows: months,
    key: 'month'
  })

  return capabilityResult({
    sections: [
      account.stat(),
      monthly.timeseries({ x: 'month', y: 'amount', granularity: 'monthly', title: 'Monthly spend' })
    ],
    summaries:
      currentMtd != null
        ? [
            monthly.summary({
              section: 'spend',
              label: 'This month',
              value: currentMtd,
              currency: CURRENCY,
              basis: 'invoiced',
              x: 'month',
              y: 'amount'
            })
          ]
        : undefined
  })
}

// Billing tab — the money DETAIL + receipts: every invoice (marvel + legacy mobile) in ONE downloadable table
// grouped by type, plus the account's financial standing. No chart/stat/summary — Summary owns those.
export const buildBillingDetail = (
  { financial, invoices }: BillingBundle,
  billingAccountId: string,
  mobileLinks: LegacyInvoiceLink[]
): CapabilityResult => {
  // Marvel invoices carry an amount + status + the docIdFr its PDF POST needs. Newest-first within the group.
  const marvelRows: InvoiceRow[] = [...sortedMarvelInvoices(invoices)].reverse().map((i) => ({
    date: epochMsDay(i.invoiceDate) ?? null,
    amount: i.totalPayableAmount ?? i.dueAmount ?? 0,
    status: (i.openAmount ?? 0) > 0 ? 'Open' : 'Paid',
    type: INVOICE_TYPE,
    name: `Invoice ${epochMsDay(i.invoiceDate) ?? 'unknown'}`,
    docId: i.docIdFr ?? null,
    billingAccountId,
    dateFacturation: '',
    medium: '',
    resourceVersion: ''
  }))

  // The legacy mobile list exposes a date + the billed amount + the scraped PDF params (no paid/open status).
  const mobileRows: InvoiceRow[] = mobileLinks.map((l) => ({
    date: l.date,
    amount: l.amount,
    status: null,
    type: MOBILE_INVOICE_TYPE,
    name: `Mobile invoice ${l.date}`,
    docId: null,
    billingAccountId: '',
    dateFacturation: l.dateFacturation,
    medium: l.medium,
    resourceVersion: l.resourceVersion
  }))

  const invoicesTable = table<InvoiceRow>({
    id: 'invoices',
    columns: [
      { key: 'date', label: 'Date', role: 'timestamp' },
      { key: 'amount', label: 'Amount', role: 'money', currency: CURRENCY },
      { key: 'status', label: 'Status', role: 'status' },
      { key: 'type', label: 'Type', role: 'label' },
      { key: 'name', role: 'label', hidden: true },
      { key: 'docId', role: 'identifier', hidden: true },
      { key: 'billingAccountId', role: 'identifier', hidden: true },
      { key: 'dateFacturation', role: 'identifier', hidden: true },
      { key: 'medium', role: 'identifier', hidden: true },
      { key: 'resourceVersion', role: 'identifier', hidden: true }
    ],
    rows: [...marvelRows, ...mobileRows]
  })

  const balance = record<BalanceRow>({
    id: 'balance',
    fields: [
      { key: 'currentBalance', label: 'Current balance', role: 'money', currency: CURRENCY },
      { key: 'dueDate', label: 'Payment due', role: 'timestamp' },
      { key: 'creditRating', label: 'Credit rating', role: 'text' }
    ],
    value: {
      currentBalance: financial.currentBalance ?? null,
      dueDate: epochMsDay(financial.paymentDueDate) ?? null,
      creditRating: financial.recentCreditRating ?? null
    }
  })

  return capabilityResult({
    sections: [
      // Both invoice types are downloadable here, grouped by type (the `type` column heads the sections). The
      // PDF bytes come from the capability's fetchFile (marvel POST or legacy browser), so the source is fetch.
      invoicesTable.fileTable({
        title: 'Invoices',
        name: 'name',
        source: { fetch: true },
        ext: 'pdf',
        category: 'Invoices',
        groupBy: 'type'
      }),
      balance.keyvalue()
    ]
  })
}

const fetchBilling = async (ctx: CollectContext): Promise<BillingRaw> => {
  const customerId = await fetchCustomerId(ctx)
  const account = await fetchInvoiceAccount(ctx, customerId)
  const billingAccountId = account.accountId

  const financial = await ctx.client
    .get<Envelope<RawFinancialInfo>>(`${ZONE_BASE}/marvel/customer/inquire/customerFinancialInfo/${billingAccountId}`)
    .then((r) => r?.data ?? {})
    .catch(() => ({}) as RawFinancialInfo)

  // This year + the two prior cover the modern platform's full invoice run (older bills are on monespace).
  const thisYear = new Date().getUTCFullYear()
  const invoices = await fetchInvoiceInfoList(ctx, customerId, billingAccountId, [thisYear, thisYear - 1, thisYear - 2])

  return { bundle: { financial, invoices }, billingAccountId: String(billingAccountId) }
}

// The PDF for one invoice row — POST marvel/invoice/document keyed by the row's hidden docIdFr + billing
// account (the capability's per-row file fetch; rows with no docIdFr have no downloadable PDF).
const fetchBillingInvoicePdf = (ctx: CollectContext, row: Record<string, unknown>): Promise<Uint8Array> => {
  if (row.docId == null) {
    throw new Error('no PDF available for this invoice')
  }

  return fetchInvoicePdf(ctx, String(row.docId), String(row.billingAccountId))
}

// ── accounts: the services on the account (the "My plan" surface) ─────────────────────

// The marvel platform tags each billing account with a coarse family short-code; humanize the ones we've
// seen and title-case anything new. The parent invoice account carries no family — it's the bill itself.
const FAMILY_LABELS: Record<string, string> = {
  INTERNET: 'Internet',
  MOBILE: 'Mobile',
  WIRELESS: 'Mobile',
  TV: 'TV',
  TELE: 'TV',
  TELEPHONE: 'Home phone',
  PHONE: 'Home phone'
}

const familyLabel = (code?: string): string => {
  if (!code) {
    return 'Billing account'
  }

  return FAMILY_LABELS[code.toUpperCase()] ?? capitalize(code)
}

interface AccountRow {
  account: string
  service: string
  status: string
  address: string
}

export const buildAccountsResult = (accounts: RawPlanAccount[]): CapabilityResult => {
  const rows: AccountRow[] = accounts.map((a) => ({
    account: a.customerBillingAccount?.acctNo ?? '—',
    service: familyLabel(a.familyCategoryShortCode),
    status: a.customerBillingAccount?.statusName ?? '—',
    address: a.serviceAddress?.addrDesc ?? '—'
  }))

  return capabilityResult({
    sections: [
      table<AccountRow>({
        id: 'accounts',
        columns: [
          { key: 'account', label: 'Account', role: 'identifier' },
          { key: 'service', label: 'Service', role: 'label' },
          { key: 'status', label: 'Status', role: 'status' },
          { key: 'address', label: 'Service address', role: 'text' }
        ],
        rows
      }).table({ title: 'Services' })
    ]
  })
}

const fetchAccounts = async (ctx: CollectContext): Promise<RawPlanAccount[]> => {
  const customerId = await fetchCustomerId(ctx)
  const accounts = await ctx.client.get<RawPlanAccount[]>(
    `${ZONE_BASE}/marvel/customer/inquire/billingAccounts/${customerId}?withPlanInformation=true&withOnboardingInformation=true`
  )

  return Array.isArray(accounts) ? accounts : []
}

// ── mobile: the bill + account standing on the legacy monespace backend (different host + token) ──

interface MobileRow {
  amount: number | null
  balance: number | null
  dueDate: string | null
  autoWithdrawal: string | null
  billingPeriod: string | null
  accountNumber: string | null
}

export const buildMobileResult = ({ last, dashboard, user }: MobileBundle): CapabilityResult => {
  const period = dashboard?.account?.data
  const auto = dashboard?.payment?.data?.automaticWithdrawal
  const amount = last.amount ?? dashboard?.billing?.data?.balance ?? null

  const mobile = record<MobileRow>({
    id: 'mobile',
    fields: [
      { key: 'amount', label: 'Current bill', role: 'money', currency: CURRENCY },
      { key: 'balance', label: 'Balance', role: 'money', currency: CURRENCY },
      { key: 'dueDate', label: 'Payment due', role: 'timestamp' },
      { key: 'autoWithdrawal', label: 'Automatic withdrawal', role: 'text' },
      { key: 'billingPeriod', label: 'Billing period', role: 'text' },
      { key: 'accountNumber', label: 'Account', role: 'identifier' }
    ],
    value: {
      amount,
      balance: last.balance ?? dashboard?.billing?.data?.balance ?? null,
      dueDate: last.dueDate ?? dashboard?.billing?.data?.dueDate ?? null,
      autoWithdrawal: auto == null ? null : auto ? 'Yes' : 'No',
      billingPeriod: period?.startDate && period?.endDate ? `${period.startDate} → ${period.endDate}` : null,
      accountNumber: user?.accountNumber ?? null
    }
  })

  return capabilityResult({
    sections: [mobile.keyvalue()],
    summaries:
      amount != null
        ? [{ section: 'other', label: 'Mobile bill', value: amount, role: 'money', currency: CURRENCY }]
        : undefined
  })
}

const fetchMobile = async (ctx: CollectContext): Promise<MobileBundle> => {
  const m = ctx.clientFor('monespace')
  // Best-effort secondary calls — one failing read shouldn't blank the whole tab.
  const [last, dashboard, user] = await Promise.all([
    m.get<RawMonespaceInvoice>(`${MONESPACE_BASE}/rest/api/invoices/last`).catch(() => ({}) as RawMonespaceInvoice),
    m.get<RawWccDashboard>(`${MONESPACE_BASE}/rest/api/wcc/dashboard/customer`).catch(() => undefined),
    m.get<RawMonespaceUser>(`${MONESPACE_BASE}/rest/api/user`).catch(() => undefined)
  ])

  return { last: last ?? {}, dashboard, user }
}

// ── mobile invoice PDFs: scraped from the legacy DisplayFacture list, downloaded per link ────

// One downloadable legacy invoice. The DisplayFacture list page renders every invoice as an
// `<a href=…displayFacturePdf&dateFacturation=…&date=…&medium=…&resourceVersion=…>` — the four params the
// PDF servlet needs. resourceVersion varies per era (older bills use an older template), so it's per-link.
// Each history row also carries the billed amount (`data-total="$X"`), so the table shows it without a fetch.
export interface LegacyInvoiceLink {
  dateFacturation: string
  date: string
  medium: string
  resourceVersion: string
  amount: number | null
}

export const parseLegacyInvoiceLinks = (html: string): LegacyInvoiceLink[] => {
  // The list arrives two ways: the raw servlet HTML (literal `&` in the href) or, via the live browser's
  // `page.html()`, the SERIALIZED DOM (outerHTML re-encodes the href's `&` as `&amp;`). Decode so the regexes
  // match both.
  const decoded = html.replace(/&amp;/g, '&')

  // Each history row puts its amount on `<tr … data-total="$X">` just before its displayFacturePdf link; map
  // the amount onto the link by dateFacturation. (The featured current-invoice link has no such row — it
  // de-dupes with the newest history row, which carries the amount.) parseFrAmount reads both en `$63.87` and
  // fr `63,87 $`.
  const amountByDate = new Map<string, number | null>()

  for (const m of decoded.matchAll(/data-total="([^"]*)"[\s\S]{0,800}?displayFacturePdf&dateFacturation=(\d+)/g)) {
    const amount = parseFrAmount(m[1]!)

    amountByDate.set(m[2]!, amount > 0 ? amount : null)
  }

  const re = /displayFacturePdf&dateFacturation=(\d+)&date=([\d-]+)&medium=(\w+)&resourceVersion=(\w+)/g
  const byDate = new Map<string, LegacyInvoiceLink>()

  for (const m of decoded.matchAll(re)) {
    byDate.set(m[1]!, {
      dateFacturation: m[1]!,
      date: m[2]!,
      medium: m[3]!,
      resourceVersion: m[4]!,
      amount: amountByDate.get(m[1]!) ?? null
    })
  }

  return [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date)) // newest first
}

// Drive the live browser to the invoice list and hand the caller the SETTLED page. The list load resolves at
// the transient "Redirect To Login" page; the page's own JS then runs the /secur/ OIDC handshake and the
// window lands on the real list a couple seconds later — so re-read the document until the invoice links
// appear (or the budget runs out), parsing the settled page, not the login page. Reused by the list collector
// and each per-row PDF download (both need the warm, settled session).
const withLegacyList = <T>(ctx: CollectContext, use: (page: BrowserPage, html: string) => Promise<T>): Promise<T> => {
  if (!ctx.browser) {
    throw new Error('Videotron: mobile invoices need the live app browser session — not available here.')
  }

  return ctx.browser.open(LEGACY_LIST_URL, async (page) => {
    // executeJavaScript can reject mid-navigation (the handshake hops) — treat that as "not settled yet".
    const read = (): Promise<string> => page.html().catch(() => '')
    let html = await read()

    // The offscreen handshake settles in ~2–4s, but the Struts servlet is slow — poll up to ~12s.
    for (let i = 0; i < 24 && !/displayFacturePdf/.test(html); i++) {
      await new Promise((r) => setTimeout(r, 500))
      html = await read()
    }

    return use(page, html)
  })
}

// One legacy invoice PDF — from inside the settled list page (so the /secur/ session is warm), download the
// PDF as a real navigation with the list as referer.
const fetchMobileInvoicePdf = (ctx: CollectContext, row: Record<string, unknown>): Promise<Uint8Array> => {
  const url =
    `${MONESPACE_INVOICE_FORM}?dispatch=displayFacturePdf&dateFacturation=${row.dateFacturation}` +
    `&date=${row.date}&medium=${row.medium}&resourceVersion=${row.resourceVersion}`

  return withLegacyList(ctx, (page) => page.download(url, { referer: LEGACY_LIST_URL }))
}

// The legacy mobile invoices, read through the live browser (the /secur/ session can't be replayed headless),
// as scraped link refs the Billing tab folds into its invoice table. Off Electron (no ctx.browser) there's
// nothing to read → empty list; the demo path draws from the sample instead.
const fetchMobileLinks = (ctx: CollectContext): Promise<LegacyInvoiceLink[]> => {
  if (!ctx.browser) {
    ctx.log('mobile invoices: live browser session unavailable — skipping')

    return Promise.resolve([])
  }

  return withLegacyList(ctx, (_page, html) => {
    // No links after the settle budget = the page never left the login/redirect state — log a fingerprint so a
    // live re-run shows the real cause (still on login, an error page, or changed markup) instead of a silent empty.
    if (!/displayFacturePdf/.test(html)) {
      ctx.log('mobile invoices: no invoice links after settle', {
        title: /<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? '?',
        length: html.length
      })
    }

    return Promise.resolve(parseLegacyInvoiceLinks(html))
  })
}

// One invoice PDF: POST marvel/invoice/document returns the bytes directly per docIdFr. The capability's
// fetchFile (fetchBillingInvoicePdf) calls this with the row's hidden docId + billing account.
const fetchInvoicePdf = async (
  ctx: CollectContext,
  documentId: string,
  billingAccountId: string
): Promise<Uint8Array> => {
  const res = await ctx.client.request<ArrayBuffer>({
    url: `${ZONE_BASE}/marvel/invoice/document`,
    method: 'POST',
    body: { documentId, billingAccountId, inquiredBy: 'ui' },
    responseType: 'arraybuffer',
    // The endpoint returns application/pdf — overriding the transport's default `Accept: application/json`
    // is REQUIRED here (the server 406s the json Accept against a pdf response).
    headers: { Accept: 'application/pdf' }
  })

  return new Uint8Array(res.data)
}

// ── billing detail: the marvel invoices + the legacy mobile list, merged ──────────────

// The Billing tab fetches both surfaces: the marvel billing bundle (API) and the legacy mobile invoice links
// (live browser). The query cache dedupes the marvel fetch it shares with the Summary tab.
const fetchBillingDetail = async (ctx: CollectContext): Promise<BillingDetailRaw> => {
  const [billing, mobileLinks] = await Promise.all([fetchBilling(ctx), fetchMobileLinks(ctx)])

  return { billing, mobileLinks }
}

// One merged-table row → its PDF, by type: a marvel invoice POSTs marvel/invoice/document; a legacy mobile
// invoice downloads through the live browser.
const fetchBillingFile = (ctx: CollectContext, row: Record<string, unknown>): Promise<Uint8Array> =>
  row.type === MOBILE_INVOICE_TYPE ? fetchMobileInvoicePdf(ctx, row) : fetchBillingInvoicePdf(ctx, row)

// ── descriptor ──────────────────────────────────────────────────────────────────────
export const videotronPlugin = definePlugin({
  reportingCurrency: 'CAD',
  meta: {
    id: 'videotron',
    name: 'Videotron',
    vendor: 'Vidéotron',
    category: 'other',
    color: '#ffe512',
    description: 'Your Videotron account — balance, invoice history + PDFs, the mobile bill, and your services.',
    homepage: 'https://www.videotron.com',
    dashboardUrl: `${PORTAL_URL}/compte/sommaire`
  },
  // Sign in by hand (Okta password/MFA → Keycloak SSO). The OIDC round-trip ends back on the portal host
  // (`moncompte.videotron.com/…`, the SPA then strips the `#code=…&session_state=…` callback fragment), so the
  // RETURN to that host — never visited during the SSO hop, which lives on eca-sso/auth.videotron.com — is the
  // authed marker, gated by a `*.videotron.com` SSO cookie. The SSO session spans the *.videotron.com hosts, so
  // capture the whole jar — core replays it into the offscreen boot.
  session: {
    loginUrl: PORTAL_URL,
    dashboardMarkers: ['moncompte.videotron.com/'],
    cookieDomains: ['videotron.com'],
    // Keycloak sets KEYCLOAK_IDENTITY only once SSO has completed, so it's the precise authed gate — it keeps
    // the host marker from matching the brief unauthenticated portal load before the redirect to eca-sso/auth.
    requiredCookie: 'KEYCLOAK_IDENTITY'
  },
  // The Bearer is a short-lived OIDC access token the SPA mints in memory (silent-renew), never replayable
  // from a stored refresh token in Node. Core boots the SPA offscreen on the shared partition, captures the
  // Authorization header off the marvel calls, caches it, and re-mints on 401.
  auth: {
    kind: 'spa-bearer',
    bootUrl: `${PORTAL_URL}/compte/sommaire`,
    authCaptureUrlPatterns: AUTH_CAPTURE_URL_PATTERNS,
    clearOnStatuses: [401]
  },
  // node (not electron): the marvel calls send an `Origin`/`Referer` pair Electron's net.request forbids.
  // The backend 400s any request missing `Collation` (UI locale) or `Content-Type: application/json` — both
  // ride on 100% of the real calls (even GETs), so they're app-required, not telemetry. sendCookie:false —
  // the marvel API is purely Bearer-authed (the live browser sends it ZERO cookies); replaying the captured
  // cross-`*.videotron.com` SSO jar (~8.5 KB) just blows the 8 KB header limit → 400.
  transport: {
    engine: 'node',
    baseUrl: ZONE_BASE,
    sendCookie: false,
    defaultHeaders: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Collation: 'en',
      Origin: PORTAL_URL,
      Referer: `${PORTAL_URL}/`
    }
  },
  // The legacy monespace platform — a second host with its OWN spa-bearer (minted by booting its own SPA).
  // Same captured SSO session; its `/rest/*` API is Bearer-only too, so sendCookie:false here as well. (The
  // legacy Struts invoice servlet has no backend — it can't be replayed headless, so it runs through
  // `ctx.browser` instead; see the mobile-invoices collectors above.)
  backends: {
    monespace: {
      auth: {
        kind: 'spa-bearer',
        bootUrl: MONESPACE_BOOT_URL,
        authCaptureUrlPatterns: MONESPACE_AUTH_CAPTURE_URL_PATTERNS,
        clearOnStatuses: [401]
      },
      transport: {
        engine: 'node',
        baseUrl: MONESPACE_BASE,
        sendCookie: false,
        defaultHeaders: { Accept: 'application/json' }
      }
    }
  },
  capabilities: [
    // Summary owns the headline (stat + monthly chart summing marvel + mobile per month + the spend rollup);
    // Billing owns the detail (the merged invoice table — marvel + legacy mobile, grouped by type, each row
    // downloadable via fetchFile — + the balance). Both fetch both surfaces; the query cache dedupes the shared
    // marvel + mobile-links calls.
    defineCapability({
      id: 'summary',
      label: 'Summary',
      fetch: fetchBillingDetail,
      build: (raw) => buildBillingSummary(raw.billing.bundle, raw.mobileLinks),
      sample: sampleVidetronBillingDetail
    }),
    defineCapability({
      id: 'billing',
      label: 'Billing',
      fetch: fetchBillingDetail,
      build: (raw) => buildBillingDetail(raw.billing.bundle, raw.billing.billingAccountId, raw.mobileLinks),
      sample: sampleVidetronBillingDetail,
      fetchFile: fetchBillingFile
    }),
    defineCapability({
      id: 'mobile',
      label: 'Mobile',
      fetch: fetchMobile,
      build: buildMobileResult,
      sample: sampleVidetronMobile
    }),
    defineCapability({
      id: 'accounts',
      label: 'Services',
      fetch: fetchAccounts,
      build: buildAccountsResult,
      sample: sampleVidetronAccounts
    })
  ],
  // Cheapest authed call: resolving the cid forces the offscreen spa-bearer mint, so a success proves the
  // whole replay path is live without fetching any per-account data.
  probe: async (ctx) => {
    await fetchCustomerId(ctx)
  }
})
