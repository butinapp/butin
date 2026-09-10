import { type CollectContext } from '@butinapp/sdk'
import { addSections, capabilityResult, record, table, type CapabilityResult } from '@butinapp/sdk/data'
import { billing } from '@butinapp/sdk/presets'
import { byDayDesc, currentMonthKey, isoDay, parseDollarAmount, round2, squish } from '@butinapp/sdk/util'
import * as cheerio from 'cheerio'

import { type Dashboard, GITHUB_ORIGIN, makeDashboard } from './dashboard.js'

// GitHub Enterprise billing — the money tab. Folds several github.com dashboard surfaces into one report:
//
//   1. payment_history (HTML, cookie-only)  → the transaction history scraped from `<li class="Box-row">`
//      rows (date, id, method, amount, status, receipt/invoice links); paginated.
//   2. billing/usage/total (JSON, nonce'd)  → current-period GROSS metered usage.
//   3. billing/discounts?month&year (JSON)  → current-period INCLUDED usage (sum of each discount's
//      `currentAmount`); NET metered = gross − included.
//   4. licensing (HTML, cookie-only)        → an embedded react-partial JSON blob (`props.ghe`) with the
//      pre-purchased license fee, seat counts, unit cost, next-payment date, pending plan change, and card.
//   5. billing/payment_information (HTML)   → the card expiry ("expiring 8/2026"), a best-effort bonus.
//   6. billing/contacts (HTML)              → the billing contacts (primary email + additional contacts).
//
// MONEY: GitHub amounts are DOLLARS already (no cents conversion). The metered figures are
// high-precision floats (rounded to cents here); the license fee + payment amounts are pre-formatted
// "$1,365.00" strings (parsed with `parseDollarAmount`).
//
// `currentMtd` (the cross-provider spend.mtd summary) = net metered usage so far this period + the
// fixed monthly pre-purchased license fee — the honest "what does GitHub cost this month" figure.

// Page cap to bound a runaway loop (24 pages × 10 rows).
const MAX_PAGES = 24

// --- payment history ---

export interface GitHubPayment {
  /** 'YYYY-MM-DD'. */
  date?: string
  /** Full timestamp from the row's <time title>, e.g. "2026-05-17 13:39:11". */
  timestamp?: string
  /** Short transaction id, e.g. "0F4ETZLG". */
  id: string
  /** e.g. "MasterCard ending in 5587". */
  method: string
  /** Parsed dollar amount. */
  amount: number
  /** Original formatted string, e.g. "$3,199.32". */
  amountFormatted: string
  /** Raw status label text, e.g. "Success" / "Declined". */
  status: string
  /** Absolute receipt URL, if present (declined payments have none). */
  receiptUrl?: string
  /** Absolute invoice-download URL, if present. */
  invoiceUrl?: string
}

/** The pre-purchased user-license subscription (Enterprise / Advanced Security). */
export interface GitHubLicenseSummary {
  monthlyAmount: number
  monthlyFormatted: string
  isMonthly: boolean
  unitCost?: string
  seatsBillable?: number
  seatsConsumed?: number
  seatsPurchased?: number
  /** Next payment / term-end date, 'YYYY-MM-DD'. */
  nextPaymentDate?: string
  pendingChange?: {
    changeType?: string
    effectiveDate?: string
    newPrice?: string
    newSeatCount?: number
    planName?: string
  }
}

export interface GitHubPaymentMethod {
  cardType?: string
  last4?: string
  expiry?: string
}

export interface GitHubBillingContact {
  email: string
  primary: boolean
}

// --- raw shapes (only the fields we use) ---

export interface RawUsageTotal {
  usage?: { totalGrossAmount?: number }
}

export interface RawDiscount {
  currentAmount?: number
  name?: string | null
}

export interface RawDiscounts {
  discounts?: RawDiscount[]
}

/** The `props.ghe` blob embedded in the licensing page's react-partial. */
export interface RawGheLicensing {
  billingTermEndDate?: string
  currentPayment?: string
  enterpriseLicensesBillable?: number
  enterpriseLicensesConsumed?: number
  enterpriseLicensesPurchased?: number
  isMonthly?: boolean
  unitCost?: string
  paymentMethod?: {
    last_four?: string
    card_type?: string
    credit_card?: boolean
    paypal?: boolean
  } | null
  pendingCycleChange?: {
    changeType?: string
    effectiveDate?: string
    newPrice?: string
    newSeatCount?: number
    planDisplayName?: string
    planDuration?: string
  } | null
}

// --- data-view row shapes ---

interface MeteredRecord {
  gross: number
  included: number
  net: number
}

interface TotalsRecord {
  totalPaid: number
  succeeded: number
  declined: number
  transactions: number
}

interface PaymentRow {
  date: string | null
  id: string
  amount: number
  status: string
  method: string | null
  receipt: string | null
  invoice: string | null
  // Carried for the download filename (files.name), not rendered as a column.
  name: string
}

interface LicenseRecord {
  monthly: number
  term: string
  seats: string | null
  unitCost: string | null
  nextPayment: string | null
  pending: string | null
}

interface PaymentMethodRecord {
  card: string
  expiry: string | null
}

interface ContactRow {
  email: string
  primary: string | null
}

const absolute = (href?: string): string | undefined => {
  if (!href) {
    return undefined
  }

  return href.startsWith('http') ? href : `${GITHUB_ORIGIN}${href}`
}

/** Total page count from the pagination nav, defaulting to 1. */
export const parseTotalPages = (html: string): number => {
  const $ = cheerio.load(html)
  const total = $('.paginate-container .current').attr('data-total-pages')
  const n = total ? parseInt(total, 10) : 1

  return Number.isFinite(n) && n > 0 ? n : 1
}

/** Parse the payment rows out of one payment-history HTML page. */
export const parsePaymentHistory = (html: string): GitHubPayment[] => {
  const $ = cheerio.load(html)
  const payments: GitHubPayment[] = []

  $('li.Box-row').each((_, row) => {
    const $row = $(row)
    const $time = $row.find('.date time').first()
    const id = $row.find('.id code span').first().text().trim()

    if (!id) {
      return // not a transaction row
    }

    const amountFormatted = $row.find('.amount').first().text().trim()

    payments.push({
      date: $time.text().trim() || undefined,
      timestamp: $time.attr('title') || undefined,
      id,
      method: squish($row.find('.method').first().text()),
      amount: parseDollarAmount(amountFormatted),
      amountFormatted: amountFormatted || '—',
      status: $row.find('.status .Label').first().text().trim() || 'unknown',
      receiptUrl: absolute($row.find('.receipt a').first().attr('href')),
      invoiceUrl: absolute($row.find('invoice-download').first().attr('data-url'))
    })
  })

  return payments
}

/** Sum of every discount's applied amount = the current-period "included usage". */
export const sumIncludedUsage = (discounts: RawDiscounts): number =>
  (discounts.discounts ?? []).reduce((sum, d) => sum + (d.currentAmount ?? 0), 0)

// Pull the `props.ghe` license blob out of the licensing page. GitHub embeds it in a
// `<script type="application/json" data-target="react-partial.embeddedData">` scoped to the
// `licensing-enterprise-overview` react-partial. Returns null if the partial isn't found (shape
// drift / session expired) so the report degrades to "no license info" rather than throwing.
export const extractGheLicensing = (html: string): RawGheLicensing | null => {
  const anchor = html.indexOf('licensing-enterprise-overview')
  const search = anchor >= 0 ? anchor : 0
  const marker = 'react-partial.embeddedData">'
  const start = html.indexOf(marker, search)

  if (start < 0) {
    return null
  }

  const from = start + marker.length
  const end = html.indexOf('</script>', from)

  if (end < 0) {
    return null
  }

  try {
    const parsed = JSON.parse(html.slice(from, end)) as { props?: { ghe?: RawGheLicensing } }

    return parsed.props?.ghe ?? null
  } catch {
    return null
  }
}

/** "expiring 8/2026" anywhere in the payment-information page → "8/2026". */
export const extractCardExpiry = (html: string): string | undefined => {
  const m = html.match(/expiring\s+(\d{1,2}\/\d{2,4})/i)

  return m ? m[1] : undefined
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/

// Scrape the billing contacts. Each contact is a `<div class="Box-row">` carrying a person icon
// (`.octicon-person`), the email text, and an optional "Primary" `.Label`. De-duped by email.
export const parseContacts = (html: string): GitHubBillingContact[] => {
  const $ = cheerio.load(html)
  const seen = new Map<string, GitHubBillingContact>()

  $('.Box-row').each((_, row) => {
    const $row = $(row)

    if ($row.find('.octicon-person').length === 0) {
      return // not a contact row
    }

    const match = $row.text().match(EMAIL_RE)

    if (!match) {
      return
    }

    const email = match[0]
    const primary = /primary/i.test($row.find('.Label').text())
    const existing = seen.get(email)

    if (existing) {
      existing.primary = existing.primary || primary
    } else {
      seen.set(email, { email, primary })
    }
  })

  // Primary first, then alphabetical.
  return Array.from(seen.values()).sort(
    (a, b) => Number(b.primary) - Number(a.primary) || a.email.localeCompare(b.email)
  )
}

export const buildLicenseSummary = (ghe: RawGheLicensing | null): GitHubLicenseSummary | null => {
  if (!ghe || ghe.currentPayment == null) {
    return null
  }

  const pending = ghe.pendingCycleChange

  return {
    monthlyAmount: parseDollarAmount(ghe.currentPayment),
    monthlyFormatted: ghe.currentPayment,
    isMonthly: ghe.isMonthly ?? true,
    unitCost: ghe.unitCost || undefined,
    seatsBillable: ghe.enterpriseLicensesBillable,
    seatsConsumed: ghe.enterpriseLicensesConsumed,
    seatsPurchased: ghe.enterpriseLicensesPurchased,
    nextPaymentDate: ghe.billingTermEndDate || undefined,
    pendingChange: pending
      ? {
          changeType: pending.changeType || undefined,
          effectiveDate: pending.effectiveDate || undefined,
          newPrice: pending.newPrice || undefined,
          newSeatCount: pending.newSeatCount,
          planName: pending.planDisplayName || undefined
        }
      : undefined
  }
}

export const buildPaymentMethod = (ghe: RawGheLicensing | null, expiry?: string): GitHubPaymentMethod | null => {
  const pm = ghe?.paymentMethod

  if (!pm && !expiry) {
    return null
  }

  const method: GitHubPaymentMethod = {
    cardType: pm?.card_type || undefined,
    last4: pm?.last_four || undefined,
    expiry: expiry || undefined
  }

  return method.cardType || method.last4 || method.expiry ? method : null
}

export interface BuildBillingArgs {
  payments: GitHubPayment[]
  totalPages: number
  pagesFetched: number
  usageTotal: RawUsageTotal
  discounts: RawDiscounts
  ghe: RawGheLicensing | null
  cardExpiry?: string
  contacts: GitHubBillingContact[]
}

// "MasterCard •••• 5587", or '—' when no card is on file.
const formatCard = (pm: GitHubPaymentMethod): string =>
  [pm.cardType, pm.last4 ? `•••• ${pm.last4}` : null].filter(Boolean).join(' ') || '—'

const formatSeats = (l: GitHubLicenseSummary): string | null =>
  l.seatsPurchased != null ? `${l.seatsConsumed ?? '?'}/${l.seatsPurchased} seats` : null

const formatPending = (l: GitHubLicenseSummary): string | null => {
  const c = l.pendingChange

  if (!c || (c.newSeatCount == null && !c.newPrice)) {
    return null
  }

  const what = c.newSeatCount != null ? `${c.newSeatCount} seats` : c.newPrice

  return `↓ ${what}${c.effectiveDate ? ` on ${c.effectiveDate}` : ''}`
}

// Shared computation behind both the Summary and the Billing detail tabs: status counts, the monthly-paid
// series (successful payments only), net metered usage, the license/payment-method surfaces, and the MTD.
interface GithubComputed {
  paymentsSorted: GitHubPayment[]
  successfulInvoices: { date?: string; amount: number; status: string }[]
  gross: number
  included: number
  net: number
  totalPaid: number
  successCount: number
  declinedCount: number
  txCount: number
  license: GitHubLicenseSummary | null
  paymentMethod: GitHubPaymentMethod | null
  contacts: GitHubBillingContact[]
  currentMtd: number | null
  plan: string | null
}

const computeGithubBilling = (args: BuildBillingArgs): GithubComputed => {
  const { payments, usageTotal, discounts, ghe, cardExpiry, contacts } = args

  let totalPaid = 0
  let successCount = 0
  let declinedCount = 0
  const successfulInvoices: { date?: string; amount: number; status: string }[] = []

  for (const p of payments) {
    const status = p.status.toLowerCase()

    if (status === 'success') {
      successCount++
      totalPaid += p.amount
      successfulInvoices.push({ date: p.date, amount: p.amount, status: 'success' })
    } else if (status === 'declined') {
      declinedCount++
    }
  }

  const gross = usageTotal.usage?.totalGrossAmount ?? 0
  const included = sumIncludedUsage(discounts)
  const net = Math.max(0, gross - included)
  const license = buildLicenseSummary(ghe)
  const paymentMethod = buildPaymentMethod(ghe, cardExpiry)

  // MTD = net metered usage so far + the fixed monthly license fee. Null only when we got NO billing
  // signal at all (every summary fetch failed) — mirrors the cross-provider Overview source.
  const hasSignal = gross > 0 || included > 0 || license != null

  return {
    paymentsSorted: [...payments].sort(byDayDesc),
    successfulInvoices,
    gross,
    included,
    net,
    totalPaid,
    successCount,
    declinedCount,
    txCount: payments.length,
    license,
    paymentMethod,
    contacts,
    currentMtd: hasSignal ? round2(net + (license?.monthlyAmount ?? 0)) : null,
    plan: license ? `${license.monthlyFormatted}${license.isMonthly ? '/mo' : '/yr'}` : null
  }
}

// --- Summary tab (its spend.mtd summary is what the cross-service Overview rolls up) ---
// The shared billing.summary preset gives the headline account stat (currentMtd = net metered usage +
// the monthly license fee) + the monthly-paid chart (successful payments) + the spend.mtd summary; we add
// the plan + transaction count as stats and the metered gross/included/net breakdown as a second stat band.
export const buildGithubSummary = (args: BuildBillingArgs): CapabilityResult => {
  const c = computeGithubBilling(args)

  const result = billing.summary({
    currentMtd: c.currentMtd,
    // currentMtd is net metered usage so far + the fixed monthly license fee — a running open-period figure,
    // so the open month (no payment posted yet) is seeded from its captured peak via backfill. The payment
    // history bars stay dated by payment date (settled charges), which the accrual backfill never overwrites.
    mtdBasis: 'accrued',
    monthlyTitle: 'Monthly payments',
    invoices: c.successfulInvoices,
    stats: [
      { key: 'plan', label: 'Plan', role: 'label', value: c.plan },
      { key: 'transactions', label: 'Transactions', role: 'count', value: c.txCount }
    ]
  })

  const metered = record<MeteredRecord>({
    id: 'metered',
    fields: [
      { key: 'gross', label: 'Metered usage', role: 'money' },
      { key: 'included', label: 'Included usage', role: 'money' },
      { key: 'net', label: 'Net usage', role: 'money' }
    ],
    value: { gross: round2(c.gross), included: round2(c.included), net: round2(c.net) }
  })
  const meteredStat = metered.stat({ title: 'Metered usage' })

  return addSections(result, meteredStat)
}

// --- Billing tab (renders via the generic renderer but is NOT the Overview rollup) ---
// The financial detail: the payment-history table as a DOWNLOADABLE table (each row's invoice link is the
// file URL; the host adds selection + Download all/selected + per-row Open + on-disk size — no separate
// documents tab; receipts stay click-through links), the payment totals, and the optional license /
// payment-method / contacts surfaces. The headline (MTD / metered / monthly chart) lives on Summary.
export const buildGithubBilling = (args: BuildBillingArgs): CapabilityResult => {
  const c = computeGithubBilling(args)

  const totals = record<TotalsRecord>({
    id: 'totals',
    fields: [
      { key: 'totalPaid', label: 'Total paid', role: 'money' },
      { key: 'succeeded', label: 'Succeeded', role: 'count' },
      { key: 'declined', label: 'Declined', role: 'count' },
      { key: 'transactions', label: 'Transactions', role: 'count' }
    ],
    value: {
      totalPaid: round2(c.totalPaid),
      succeeded: c.successCount,
      declined: c.declinedCount,
      transactions: c.txCount
    }
  })

  const payments = table<PaymentRow>({
    id: 'payments',
    columns: [
      { key: 'date', label: 'Date', role: 'timestamp' },
      { key: 'id', label: 'Transaction', role: 'identifier' },
      { key: 'amount', label: 'Amount', role: 'money' },
      { key: 'status', label: 'Status', role: 'status' },
      { key: 'method', label: 'Method', role: 'text' },
      { key: 'receipt', label: 'Receipt', role: 'url' },
      { key: 'invoice', label: 'Invoice', role: 'url' },
      { key: 'name', role: 'label', hidden: true }
    ],
    rows: c.paymentsSorted.map((p) => ({
      date: p.date ?? null,
      id: p.id,
      amount: p.amount,
      status: p.status,
      method: p.method || null,
      receipt: p.receiptUrl ?? null,
      invoice: p.invoiceUrl ?? null,
      name: `Invoice ${p.date || p.id}`
    })),
    // The transaction id is each payment's stable identity, so a payment accumulates its status/amount in the ledger.
    key: 'id'
  })

  const license = c.license
    ? record<LicenseRecord>({
        id: 'license',
        fields: [
          { key: 'monthly', label: 'License fee', role: 'money' },
          { key: 'term', label: 'Term', role: 'text' },
          { key: 'seats', label: 'Seats', role: 'text' },
          { key: 'unitCost', label: 'Unit cost', role: 'text' },
          { key: 'nextPayment', label: 'Next payment', role: 'text' },
          { key: 'pending', label: 'Pending change', role: 'text' }
        ],
        value: {
          monthly: c.license.monthlyAmount,
          term: c.license.isMonthly ? 'Monthly' : 'Annual',
          seats: formatSeats(c.license),
          unitCost: c.license.unitCost ?? null,
          nextPayment: c.license.nextPaymentDate ?? null,
          pending: formatPending(c.license)
        }
      })
    : null

  const paymentMethod = c.paymentMethod
    ? record<PaymentMethodRecord>({
        id: 'paymentMethod',
        fields: [
          { key: 'card', label: 'Card', role: 'text' },
          { key: 'expiry', label: 'Expiry', role: 'text' }
        ],
        value: { card: formatCard(c.paymentMethod), expiry: c.paymentMethod.expiry ?? null }
      })
    : null

  const contacts =
    c.contacts.length > 0
      ? table<ContactRow>({
          id: 'contacts',
          columns: [
            { key: 'email', label: 'Email', role: 'identifier' },
            { key: 'primary', label: 'Primary', role: 'text' }
          ],
          rows: c.contacts.map((contact) => ({ email: contact.email, primary: contact.primary ? 'Primary' : null })),
          // The email is each contact's identity (parseContacts dedupes by it), so contacts accumulate in the ledger.
          key: 'email'
        })
      : null

  return capabilityResult({
    sections: [
      totals.stat({ title: 'Payments' }),
      payments.fileTable({
        title: 'Payment history',
        name: 'name',
        source: { url: 'invoice' },
        ext: 'pdf',
        category: 'Invoices'
      }),
      license?.keyvalue({ title: 'Pre-purchased licenses' }),
      paymentMethod?.keyvalue({ title: 'Payment method' }),
      contacts?.table({ title: 'Billing contacts' })
    ]
  })
}

// Walk the paginated payment-history HTML and return every transaction row (capped at MAX_PAGES).
// Page 1 is un-caught — a dead session 401s here and propagates so core can clear the cookie and
// re-prompt Magic Login; the remaining pages are best-effort. Rows are newest-first within a page AND
// across pages, so once a fetched page's rows are ALL at/older than `since`, every later page is too —
// the walk stops there (that page is still kept; the union merge dedupes it against what's stored).
// `since` undefined (first run / forced refetch) never counts as stale, so the walk covers every page.
// Sequential by construction — the early-stop only works page by page, so this can't run pages concurrently.
export const fetchAllPayments = async (
  dash: Dashboard,
  since?: string
): Promise<{ payments: GitHubPayment[]; totalPages: number; pagesFetched: number }> => {
  const paymentHistoryPath = `${dash.billingBase}/payment_history`
  const firstHtml = await dash.getHtml(paymentHistoryPath)
  const totalPages = parseTotalPages(firstHtml)
  const payments = parsePaymentHistory(firstHtml)
  const maxPage = Math.min(totalPages, MAX_PAGES)

  const isStale = (rows: GitHubPayment[]): boolean =>
    since != null && rows.length > 0 && rows.every((p) => (isoDay(p.timestamp) ?? '') <= since)

  let lastPage = payments
  let pagesFetched = 1

  for (let page = 2; page <= maxPage && !isStale(lastPage); page++) {
    lastPage = await dash
      .getHtml(paymentHistoryPath, { page })
      .then(parsePaymentHistory)
      .catch(() => [] as GitHubPayment[])
    payments.push(...lastPage)
    pagesFetched++
  }

  return { payments, totalPages, pagesFetched }
}

// Summary + Billing both fold the SAME surfaces (payment history + the five best-effort summaries), so
// `loadGithubBilling` fetches them once into BuildBillingArgs and shares the in-flight promise across both
// collects, with a short TTL so a near-simultaneous burst — or a refresh-all — dedupes while a deliberate
// Refresh seconds later still re-fetches. Page 1 of payment history is load-bearing (a dead session 401s
// there and clears the cookie); the rest are best-effort.
//
// The cache is keyed by `ctx.since` (not a constant), because Billing's incremental run and Summary's plain
// collect want DIFFERENT payment scopes: Billing walks only the pages past its watermark, Summary always
// needs the full history for its monthly-paid trend. Sharing one slot would let whichever capability runs
// first (refresh-all runs Billing before Summary) hand its scoped payments to the other.
const FETCH_TTL_MS = 5_000
const billingCache = new Map<string, { at: number; promise: Promise<BuildBillingArgs> }>()

export const loadGithubBilling = (ctx: CollectContext): Promise<BuildBillingArgs> => {
  const cacheKey = ctx.since ?? 'full'
  const hit = billingCache.get(cacheKey)

  if (hit && Date.now() - hit.at < FETCH_TTL_MS) {
    return hit.promise
  }

  const promise = (async (): Promise<BuildBillingArgs> => {
    const dash = makeDashboard(ctx)
    const [year, month] = currentMonthKey().split('-').map(Number)

    const { payments, totalPages, pagesFetched } = await fetchAllPayments(dash, ctx.since)

    const [usageTotal, discounts, licensingHtml, paymentInfoHtml, contactsHtml] = await Promise.all([
      dash.getJson<RawUsageTotal>(`${dash.billingBase}/usage/total`).catch(() => ({}) as RawUsageTotal),
      dash
        .getJson<RawDiscounts>(`${dash.billingBase}/discounts`, { month, year, reloadKey: 0 })
        .catch(() => ({ discounts: [] }) as RawDiscounts),
      dash.getHtml(dash.licensingPath).catch(() => ''),
      dash.getHtml(`${dash.billingBase}/payment_information`).catch(() => ''),
      dash.getHtml(`${dash.billingBase}/contacts`).catch(() => '')
    ])

    return {
      payments,
      totalPages,
      pagesFetched,
      usageTotal,
      discounts,
      ghe: extractGheLicensing(licensingHtml),
      cardExpiry: extractCardExpiry(paymentInfoHtml),
      contacts: parseContacts(contactsHtml)
    }
  })()
  const entry = { at: Date.now(), promise }

  billingCache.set(cacheKey, entry)
  void promise.catch(() => {
    if (billingCache.get(cacheKey) === entry) {
      billingCache.delete(cacheKey)
    }
  })

  return promise
}
