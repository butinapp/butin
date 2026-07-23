import {
  defineCapability,
  definePlugin,
  type AuthAttachment,
  type AuthContext,
  type CollectContext
} from '@butinapp/sdk'
import { capabilityResult, record, table, type CapabilityResult } from '@butinapp/sdk/data'
import { billing, usage } from '@butinapp/sdk/presets'
import { centsToMajor, currentMonthKey, epochSecDay, isoDay, round2 } from '@butinapp/sdk/util'

import { sampleChatgptBilling, sampleChatgptMembers, sampleChatgptUsage } from './sample.js'

// ChatGPT workspace (chatgpt.com admin). Four tabs:
//   1. Summary — the overview the cross-service Overview rolls up (spend.mtd): the current-month seat spend
//      headline + seat/credit/renewal stat cards + the monthly-spend chart. Account detail + invoices live on Billing.
//   2. Billing — the financial detail: the account record (plan, payment card, billing contact, credit grant)
//      + the downloadable Stripe invoice history (cents→USD).
//   3. Usage — the per-member Codex leaderboard (credits → USD at the invoice-derived $0.04/credit rate,
//      tokens, lines of code), each row badged with its workspace seat type, plus org totals.
//   4. Members — the full workspace roster (everyone who holds a seat): name, email, seat type.
// Summary + Billing share one billing fetch; Usage + Members share one workspace-roster fetch (the query
// cache dedupes both).
//
// AUTH is multi-step: the chatgpt.com session cookie → GET /api/auth/session yields a short-lived Bearer
// accessToken → used against /backend-api/*. The workspace account id(s) come from
// /backend-api/accounts/check (structure === 'workspace'). Modeled as auth.kind 'minted-jwt' whose resolve()
// reads the session endpoint and returns the accessToken as the Bearer.
//
// The per-member Codex usage leaderboard lives on a DIFFERENT host — admin.openai.com — behind its own
// cookie session (oai-access-token), not the chatgpt.com Bearer. It's wired as the secondary `admin` backend
// (cookie auth) so `ctx.clientFor('admin')` replays whatever admin.openai.com cookies the shared partition
// holds; the Usage tab degrades to the roster with zeroed usage when that surface isn't authed.
//
// The edge only accepts a real browser on every surface → Electron transport. MONEY: invoice `total` is Stripe
// CENTS → centsToMajor; the credit grant amounts are already USD-dollar strings → Number(); Codex credits →
// USD via CODEX_CREDIT_USD.

const ORIGIN = 'https://chatgpt.com'
const ADMIN_ORIGIN = 'https://admin.openai.com'
const SESSION_PATH = `${ORIGIN}/api/auth/session`
const ACCOUNTS_CHECK = `${ORIGIN}/backend-api/accounts/check/v4-2023-04-27?timezone_offset_min=0`
const INVOICE_PAGE_LIMIT = 100
const MAX_INVOICE_PAGES = 40
// Workspace-roster pagination: one page is 100 members; the backstop caps a runaway walk.
const MEMBER_PAGE_LIMIT = 100
const MAX_MEMBER_PAGES = 50

// Voided / uncollectible invoices were never actually paid (a void is usually a same-day reissue), so they
// contribute $0 to spend — otherwise they double-count in the monthly trend and the cross-service Overview.
// They still appear in the invoice table with their status badge. Everything else counts at face value,
// including negative `subscription_update` proration adjustments.
const NON_SPEND_STATUSES = new Set(['void', 'uncollectible'])

// USD per Codex credit. The leaderboard reports usage in *credits*, not dollars; the conversion comes from
// the workspace Stripe line item "ChatGPT Credits (per credit)", billed at unit_amount 4¢ → $0.04/credit.
// Treating credits as 1:1 dollars overstates ~25×.
export const CODEX_CREDIT_USD = 0.04

// ── types: Raw* wire shapes + normalized domain types (the data dictionary) ────────────

interface RawSession {
  accessToken?: string
}

interface RawAccountEntry {
  account?: { account_id?: string | null; name?: string | null; structure?: string; plan_type?: string }
}
interface RawAccountsCheck {
  accounts?: Record<string, RawAccountEntry>
}

// billing
export interface RawSubscription {
  plan_type?: string
  seats_in_use?: number
  seats_entitled?: number
  billing_period?: string | null
  active_until?: string | null
  will_renew?: boolean
  billing_currency?: string
  is_delinquent?: boolean
}
export interface RawSeatTypeCounts {
  seat_type_counts?: Record<string, number>
}
export interface RawRemainingBalance {
  balance?: string
  expiring_balance_details?: Array<{
    amount_granted?: string
    amount_remaining?: string
    expiry_date?: string
    grant_type?: string
  }>
}
export interface RawInvoice {
  id?: string
  number?: string | null
  created?: number // epoch seconds
  total?: number // cents
  amount_due?: number // cents
  currency?: string
  status?: string
  billing_reason?: string | null
  hosted_invoice_url?: string | null
  invoice_pdf?: string | null
}
export interface RawInvoices {
  data?: RawInvoice[]
  has_more?: boolean // Stripe-style cursor flag
}
// A Stripe invoice hoisted to the top level with the workspace it belongs to (`accountId`) and its ISO-day
// (`createdIso`) stamped on — the flat, id-keyed history core unions incrementally, then the build regroups by
// `accountId`. Stripe's `id` is globally unique across accounts, so it's a safe union key.
export interface FlatChatgptInvoice extends RawInvoice {
  accountId: string
  createdIso: string // YYYY-MM-DD (= epochSecDay(created))
}
export interface RawPaymentMethod {
  id?: string
  type?: string
  card?: { brand?: string; last4?: string; exp_month?: number; exp_year?: number } | null
}
export interface RawPaymentMethods {
  payment_methods?: RawPaymentMethod[]
  default_payment_method_id?: string | null // the card actually charged
}
export interface RawBillingInfo {
  name?: string | null
  address?: {
    line1?: string | null
    line2?: string | null
    city?: string | null
    state?: string | null
    postal_code?: string | null
    country?: string | null
  } | null
}

// The billing fetch's raw shape: every workspace's assembled bundle + the flat top-level invoice history + the
// capture timestamp (so the pure build is deterministic — MTD and the monthly trend key off it). The invoices
// live at the top level (not per bundle) so `billing` can union them incrementally by Stripe id. Summary +
// Billing share this raw.
export interface RawChatgptBilling {
  bundles: RawWorkspaceBundle[]
  invoices: FlatChatgptInvoice[]
  capturedAt: string
}

// One workspace's billing bundle (assembled in collect()) — subscription/seat/balance detail. Its invoices are
// hoisted to RawChatgptBilling.invoices, keyed back by accountId.
export interface RawWorkspaceBundle {
  accountId: string
  name: string
  planType: string
  subscription: RawSubscription
  seatTypeCounts: RawSeatTypeCounts
  remainingBalance: RawRemainingBalance
  paymentMethods?: RawPaymentMethods
  billingInfo?: RawBillingInfo
}

export interface InvoiceRow {
  id: string
  number: string | null
  date: string // YYYY-MM-DD
  amount: number // USD
  currency: string
  status: string
  billingReason: string | null
  hostedUrl: string | null
  pdfUrl: string | null
}
export interface SubscriptionInfo {
  planType: string
  seatsInUse: number
  seatsEntitled: number
  billingPeriod: string | null
  renewsAt: string | null // YYYY-MM-DD
  willRenew: boolean
  currency: string
  delinquent: boolean
  seatTypes: Record<string, number>
}
export interface CreditInfo {
  balance: number // remaining prepaid credit (USD)
  granted: number // original grant (USD)
  grantType: string
  expiryDate: string | null // YYYY-MM-DD
}
export interface PaymentMethodInfo {
  brand: string
  last4: string
  expMonth: number | null
  expYear: number | null
}
export interface BillingContactInfo {
  name: string | null
  address: string | null
}
export interface WorkspaceBilling {
  accountId: string
  name: string
  subscription: SubscriptionInfo
  credit: CreditInfo | null
  paymentMethod: PaymentMethodInfo | null
  billingContact: BillingContactInfo | null
  invoices: InvoiceRow[]
}
export interface WorkspaceBillingReport {
  capturedAt: string
  workspaces: WorkspaceBilling[]
  currentMtd: number | null
}

// usage
export interface RawLeaderboardRow {
  user_id: string
  display_name?: string | null
  email?: string | null
  value?: number // tokens over the window
  credits_used?: number
  lines_of_code?: number
  rank?: number
}
export interface RawLeaderboard {
  metric?: string
  window?: string
  rows?: RawLeaderboardRow[]
}
export interface RawFreshness {
  min_timestamp_across_data_source?: string
  generated_at?: string
}
export interface RawCodexBundle {
  leaderboard: RawLeaderboard
  freshness: RawFreshness
}

// The usage fetch's raw shape: the Codex leaderboard bundle (admin.openai.com) + the workspace seat roster
// (chatgpt.com) it joins on + the capture timestamp/window (so the pure build is deterministic).
export interface RawChatgptUsage {
  leaderboard: RawLeaderboard
  freshness: RawFreshness
  roster: WorkspaceMember[]
  capturedAt: string
  window: string
}

// workspace roster (chatgpt.com /backend-api/accounts/<id>/users) — the seat directory
export interface RawWorkspaceUser {
  id?: string
  seat_type?: string | null
  email?: string | null
  name?: string | null
}
export interface RawWorkspaceUsers {
  items?: RawWorkspaceUser[]
}

// One workspace member. The user id is the same id space as the Codex leaderboard's, so the Usage tab joins
// on it to badge each active member with their seat type. 'default' = a flat ChatGPT seat, 'usage_based' = a
// metered Codex seat.
export interface WorkspaceMember {
  userId: string
  seatType: string
  email: string | null
  name: string | null
}

export interface CodexMember {
  userId: string
  email: string | null
  name: string | null
  seatType: string | null
  tokens: number
  credits: number
  codexUsd: number // credits × CODEX_CREDIT_USD
  linesOfCode: number
}
export interface CodexReport {
  capturedAt: string
  dataAsOf: string // data day (YYYY-MM-DD) — snapshot dedup key
  window: string
  members: CodexMember[]
  totalTokens: number
  totalCredits: number
  totalCodexUsd: number
  totalLinesOfCode: number
  activeMembers: number
}

// ── billing (workspace seat subscription + invoices + credit) ──────────

const invoiceAmount = (inv: RawInvoice): number =>
  NON_SPEND_STATUSES.has(inv.status ?? '') ? 0 : centsToMajor(inv.total ?? inv.amount_due ?? 0)

// The card actually charged (default_payment_method_id), else the first card on file.
export const pickDefaultPaymentMethod = (raw: RawPaymentMethods | undefined): PaymentMethodInfo | null => {
  const methods = raw?.payment_methods ?? []
  const chosen = methods.find((m) => m.id && m.id === raw?.default_payment_method_id) ?? methods[0]
  const card = chosen?.card

  if (!card) {
    return null
  }

  return {
    brand: card.brand ?? 'card',
    last4: card.last4 ?? '',
    expMonth: card.exp_month ?? null,
    expYear: card.exp_year ?? null
  }
}

// Company name + a one-line address (line1, line2, "postal city", state, country).
export const buildBillingContact = (raw: RawBillingInfo | undefined): BillingContactInfo | null => {
  const a = raw?.address
  const address = a
    ? [a.line1, a.line2, [a.postal_code, a.city].filter(Boolean).join(' '), a.state, a.country]
        .map((p) => (p == null ? '' : String(p).trim()))
        .filter(Boolean)
        .join(', ')
    : ''

  if (!raw?.name && !address) {
    return null
  }

  return { name: raw?.name ?? null, address: address || null }
}

// Raw per-workspace bundles → the normalized billing report. Invoice `total` is Stripe cents → centsToMajor; the
// credit grant amounts are already USD-dollar strings → Number(). MTD = what was actually charged this calendar
// month across workspaces (seat-cycle bill + prepaid top-ups).
export const buildWorkspaceBilling = (
  bundles: RawWorkspaceBundle[],
  invoices: FlatChatgptInvoice[],
  capturedAt: string
): WorkspaceBillingReport => {
  const workspaces: WorkspaceBilling[] = bundles.map((b) => {
    const sub = b.subscription
    const grant = b.remainingBalance.expiring_balance_details?.[0]
    const credit: CreditInfo | null = grant
      ? {
          balance: Number(grant.amount_remaining ?? b.remainingBalance.balance ?? 0),
          granted: Number(grant.amount_granted ?? 0),
          grantType: grant.grant_type ?? '',
          expiryDate: isoDay(grant.expiry_date) ?? null
        }
      : null

    const invoiceRows: InvoiceRow[] = invoices
      .filter((i) => i.accountId === b.accountId)
      .map((inv) => ({
        id: inv.id ?? '',
        number: inv.number ?? null,
        date: epochSecDay(inv.created) ?? '',
        amount: invoiceAmount(inv),
        currency: (inv.currency ?? 'usd').toUpperCase(),
        status: inv.status ?? 'unknown',
        billingReason: inv.billing_reason ?? null,
        hostedUrl: inv.hosted_invoice_url ?? null,
        pdfUrl: inv.invoice_pdf ?? null
      }))
      .sort((a, b2) => b2.date.localeCompare(a.date))

    return {
      accountId: b.accountId,
      name: b.name,
      subscription: {
        planType: sub.plan_type ?? b.planType,
        seatsInUse: sub.seats_in_use ?? 0,
        seatsEntitled: sub.seats_entitled ?? 0,
        billingPeriod: sub.billing_period ?? null,
        renewsAt: isoDay(sub.active_until) ?? null,
        willRenew: sub.will_renew ?? false,
        currency: sub.billing_currency ?? 'USD',
        delinquent: sub.is_delinquent ?? false,
        seatTypes: b.seatTypeCounts.seat_type_counts ?? {}
      },
      credit,
      paymentMethod: pickDefaultPaymentMethod(b.paymentMethods),
      billingContact: buildBillingContact(b.billingInfo),
      invoices: invoiceRows
    }
  })

  // The capture month in the reporting zone — capturedAt is a UTC instant, so slicing it raw would read the
  // next month near the boundary and miss the current month's seat spend.
  const currentMonth = currentMonthKey(new Date(capturedAt))
  const monthSpend = workspaces
    .flatMap((w) => w.invoices)
    .filter((inv) => inv.date.slice(0, 7) === currentMonth)
    .reduce((sum, inv) => sum + inv.amount, 0)

  // 0 stays (the Overview reads the current-month bar) rather than nulling out and dropping the service from the
  // Overview when the current month has no seat invoice yet.
  return { capturedAt, workspaces, currentMtd: round2(monthSpend) }
}

// Summary tab — the overview the cross-service Overview rolls up (spend.mtd): the current-month seat-spend
// headline, the plan + seat/credit/renewal stat cards, and the monthly-spend chart (off all workspaces'
// invoices). The account detail + the invoice history are the Billing tab's detail — not here. workspaces[0]
// drives the stat band; the chart/MTD aggregate across all workspaces defensively.
export const buildChatgptSummaryResult = (report: WorkspaceBillingReport): CapabilityResult => {
  const primary = report.workspaces[0]
  const allInvoices = report.workspaces.flatMap((w) => w.invoices)
  const sub = primary?.subscription
  const credit = primary?.credit
  const currency = sub?.currency ?? 'USD'

  const seatLabel = sub ? `${sub.seatsInUse} / ${sub.seatsEntitled}` : null

  return billing.summary({
    currentMtd: report.currentMtd,
    currency,
    // The seat-subscription spend is the sum of this calendar month's workspace invoices (basis 'invoiced');
    // the per-seat unit price isn't exposed in the subscription payload, so no baseFee is split out.
    mtdBasis: 'invoiced',
    plan: sub?.planType,
    invoices: allInvoices.map((i) => ({
      date: i.date || undefined,
      amount: i.amount,
      status: i.status,
      hostedUrl: i.hostedUrl,
      pdfUrl: i.pdfUrl
    })),
    stats: [
      { key: 'seats', label: 'Seats', role: 'label', value: seatLabel },
      { key: 'credit', label: 'Credit balance', role: 'money', currency, value: credit?.balance ?? null },
      { key: 'renews', label: 'Renews', role: 'timestamp', value: sub?.renewsAt ?? null }
    ]
  })
}

interface AccountInfoRow {
  card: string | null
  cardExpiry: string | null
  billedTo: string | null
  billingAddress: string | null
  grant: number | null
  grantExpiry: string | null
}

interface InvoiceTableRow {
  date: string | null
  number: string | null
  amount: number
  status: string
  pdfUrl: string | null
  // Hidden — carried for the download filename, declared not smuggled.
  name: string
  // Hidden — the Stripe invoice id (globally unique, non-null), the ledger accumulation key. `number` can be null.
  id: string
}

// Billing tab — the financial detail (not the Overview rollup; the headline + chart live on Summary): the
// account record (payment card, billing contact, credit grant) and the downloadable Stripe invoice history.
export const buildChatgptBillingTab = (report: WorkspaceBillingReport): CapabilityResult => {
  const primary = report.workspaces[0]
  const allInvoices = report.workspaces.flatMap((w) => w.invoices)
  const credit = primary?.credit
  const currency = primary?.subscription.currency ?? 'USD'
  const pm = primary?.paymentMethod
  const contact = primary?.billingContact

  const accountValue: AccountInfoRow = {
    card: pm ? `${pm.brand} ···· ${pm.last4}` : null,
    cardExpiry: pm && pm.expMonth && pm.expYear ? `${String(pm.expMonth).padStart(2, '0')}/${pm.expYear}` : null,
    billedTo: contact?.name ?? null,
    billingAddress: contact?.address ?? null,
    grant: credit && credit.granted ? credit.granted : null,
    grantExpiry: credit?.expiryDate ?? null
  }
  const hasAccount = Object.values(accountValue).some((v) => v !== null)

  const account = record<AccountInfoRow>({
    id: 'accountInfo',
    fields: [
      { key: 'card', label: 'Payment method', role: 'label' },
      { key: 'cardExpiry', label: 'Expires', role: 'label' },
      { key: 'billedTo', label: 'Billed to', role: 'label' },
      { key: 'billingAddress', label: 'Billing address', role: 'text' },
      { key: 'grant', label: 'Credit granted', role: 'money', currency },
      { key: 'grantExpiry', label: 'Credit expires', role: 'timestamp' }
    ],
    value: accountValue
  })

  const sorted = [...allInvoices].sort((a, b) => b.date.localeCompare(a.date))
  const invoices = table<InvoiceTableRow>({
    id: 'invoices',
    columns: [
      { key: 'date', label: 'Date', role: 'timestamp' },
      { key: 'number', label: 'Number', role: 'identifier' },
      { key: 'amount', label: 'Amount', role: 'money', currency },
      { key: 'status', label: 'Status', role: 'status' },
      { key: 'pdfUrl', label: 'PDF', role: 'url' },
      { key: 'name', role: 'label', hidden: true },
      { key: 'id', role: 'identifier', hidden: true }
    ],
    rows: sorted.map((i) => ({
      date: i.date || null,
      number: i.number,
      amount: i.amount,
      status: i.status,
      pdfUrl: i.pdfUrl ?? i.hostedUrl ?? null,
      name: `Invoice ${i.number || i.date || 'unknown'}`,
      id: i.id
    })),
    // Keyed by the Stripe invoice id so invoices accumulate history (a status flips over time) past the fetch window.
    key: 'id'
  })

  // Each row's invoice PDF is a selectable file the host downloads (else its hosted URL).
  const invoiceFiles = invoices.fileTable({
    title: 'Invoices',
    name: 'name',
    source: { url: 'pdfUrl' },
    ext: 'pdf',
    category: 'Invoices'
  })

  return capabilityResult({
    sections: [hasAccount ? account.keyvalue({ title: 'Account' }) : null, allInvoices.length ? invoiceFiles : null]
  })
}

// ── usage (per-member Codex leaderboard) ────────────────────────────────────────────────

// YYYY-MM-DD of the freshness timestamp (empty string if absent).
const dataDay = (freshness: RawFreshness): string =>
  isoDay(freshness.min_timestamp_across_data_source ?? freshness.generated_at) ?? ''

// Convert Codex credits to USD via the invoice-derived per-credit price.
export const codexCreditsToUsd = (credits: number): number => round2(credits * CODEX_CREDIT_USD)

// Join leaderboard rows to the workspace roster by user_id to badge each with its seat type and fill
// email/name (an unmatched row — an active member who no longer holds a seat — keeps its display_name + null
// email + null seat), convert credits → USD, and sum org totals.
export const buildCodexReport = (
  raw: RawCodexBundle,
  roster: Map<string, WorkspaceMember>,
  capturedAt: string,
  window: string
): CodexReport => {
  const members: CodexMember[] = (raw.leaderboard.rows ?? []).map((row) => {
    const seat = roster.get(row.user_id)
    const credits = row.credits_used ?? 0

    return {
      userId: row.user_id,
      email: seat?.email ?? row.email ?? null,
      name: seat?.name ?? row.display_name ?? null,
      seatType: seat?.seatType ?? null,
      tokens: row.value ?? 0,
      credits,
      codexUsd: codexCreditsToUsd(credits),
      linesOfCode: row.lines_of_code ?? 0
    }
  })

  const totalCredits = members.reduce((s, m) => s + m.credits, 0)

  return {
    capturedAt,
    dataAsOf: dataDay(raw.freshness),
    window,
    members,
    totalTokens: members.reduce((s, m) => s + m.tokens, 0),
    totalCredits,
    totalCodexUsd: codexCreditsToUsd(totalCredits),
    totalLinesOfCode: members.reduce((s, m) => s + m.linesOfCode, 0),
    activeMembers: members.length
  }
}

// Compose the usage result: an org-total metric carrying the Codex $ (so the cross-service Overview reads a
// usage.primary spend), plus a per-member leaderboard table (Codex $, credits, tokens, lines of code),
// costliest first.
export const buildChatgptUsageResult = (report: CodexReport): CapabilityResult => {
  const result = usage.result({
    metrics: [
      { label: 'Codex usage', value: report.totalTokens, unit: 'tokens', cost: report.totalCodexUsd },
      { label: 'Active members', value: report.activeMembers, unit: 'members' },
      { label: 'Lines of code', value: report.totalLinesOfCode, unit: 'lines' }
    ]
  })

  if (report.members.length) {
    const rows = [...report.members].sort((a, b) => b.codexUsd - a.codexUsd || b.tokens - a.tokens)

    interface LeaderboardRow {
      userId: string
      name: string
      email: string | null
      seatType: string | null
      codexUsd: number
      credits: number
      tokens: number
      linesOfCode: number
    }
    const leaderboard = table<LeaderboardRow>({
      id: 'leaderboard',
      columns: [
        { key: 'name', label: 'Member', role: 'label' },
        { key: 'email', label: 'Email', role: 'identifier' },
        { key: 'seatType', label: 'Seat', role: 'category' },
        // The dollar Codex spend is the meaningful per-member metric, so IT owns the trend (not the token or
        // credit counts). Cumulative on a keyed table → the renderer adds a per-member Trend sparkline + a
        // per-day drilldown of Codex $, from the readings recorded across refreshes. Caveat: the leaderboard
        // reports a rolling window (see USAGE_WINDOW), so the day-over-day deltas are approximate, not a true
        // daily spend — the total and the ranking are exact; the per-day breakdown is indicative.
        { key: 'codexUsd', label: 'Codex usage', role: 'money', accrual: 'cumulative', resetPeriod: 'monthly' },
        { key: 'credits', label: 'Credits', role: 'count' },
        { key: 'tokens', label: 'Tokens', role: 'count' },
        { key: 'linesOfCode', label: 'Lines', role: 'count' }
      ],
      rows: rows.map((m) => ({
        userId: m.userId,
        name: m.name ?? '(unknown)',
        email: m.email,
        seatType: m.seatType,
        codexUsd: m.codexUsd,
        credits: round2(m.credits),
        tokens: m.tokens,
        linesOfCode: m.linesOfCode
      })),
      key: 'userId'
    })

    result.datasets.push(leaderboard.dataset)
    result.views = [...(result.views ?? []), leaderboard.table({ title: 'Codex leaderboard' }).view]
  }

  return result
}

// ── members (the full workspace seat roster) ─────────────────────────────────────────────

// The roster table: everyone holding a workspace seat, with their seat type. Keyed by userId so members
// accumulate stably across refreshes even when name/email change.
export const buildChatgptMembersResult = (members: WorkspaceMember[]): CapabilityResult => {
  const sorted = [...members].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
  const roster = table<WorkspaceMember>({
    id: 'members',
    columns: [
      { key: 'name', label: 'Name', role: 'label' },
      { key: 'email', label: 'Email', role: 'identifier' },
      { key: 'seatType', label: 'Seat', role: 'category' }
    ],
    rows: sorted.map((m) => ({ ...m, name: m.name ?? '(unknown)' })),
    key: 'userId'
  })

  return capabilityResult({ sections: [roster.table({ title: 'Members' })] })
}

// ── auth: mint the backend-api Bearer from the chatgpt.com session cookie ───────────────

// resolve(): GET /api/auth/session with the stored chatgpt.com cookie to read the short-lived NextAuth
// accessToken, and attach it as the Bearer for /backend-api/*. The cookie is replayed by core (cookie auth
// default), so the request rides the captured session.
export const resolveChatgptBearer = async ({ client }: AuthContext): Promise<AuthAttachment> => {
  const session = await client.get<RawSession>(SESSION_PATH)
  const token = session?.accessToken

  if (!token) {
    throw new Error('[chatgpt] no access token in /api/auth/session — re-run Magic Login for ChatGPT.')
  }

  return { headers: { Authorization: `Bearer ${token}` } }
}

// ── shared collect plumbing ─────────────────────────────────────────────────────────────
//
// The multi-step token/account-id dance relies on two endpoint shapes: auth.resolve()'s GET /api/auth/session
// returns { accessToken }, and /backend-api/accounts/check returns the `accounts` map with
// `structure: "workspace"` entries. The Codex usage leaderboard additionally lives on admin.openai.com,
// reached through the secondary `admin` backend (cookie auth off the shared partition); it degrades to an
// empty leaderboard rather than throwing when that surface isn't authed.

// The workspace (non-personal) accounts the user administers, off /backend-api/accounts/check.
const fetchWorkspaces = async (
  ctx: CollectContext
): Promise<Array<{ accountId: string; name: string; planType: string }>> => {
  const check = await ctx.client.get<RawAccountsCheck>(ACCOUNTS_CHECK)
  const out: Array<{ accountId: string; name: string; planType: string }> = []

  for (const [key, entry] of Object.entries(check?.accounts ?? {})) {
    const acct = entry.account

    if (!acct || acct.structure !== 'workspace') {
      continue
    }

    out.push({
      accountId: acct.account_id ?? key,
      name: acct.name ?? acct.account_id ?? key,
      planType: acct.plan_type ?? ''
    })
  }

  return out
}

// Walk the Stripe-cursor invoice list for one account until `has_more` is false (credit top-ups create many
// `manual` invoices/month, so one page barely covers ~2 months — the full history needs every page). Bounded
// by MAX_INVOICE_PAGES as a runaway backstop. The cursor is newest-first, so with a `since` watermark the walk
// stops once a whole page is older than it — the incremental billing run only re-fetches the recent tail.
const fetchAllInvoices = async (ctx: CollectContext, accountId: string, since?: string): Promise<RawInvoice[]> => {
  const all: RawInvoice[] = []
  let startingAfter: string | undefined

  for (let page = 0; page < MAX_INVOICE_PAGES; page++) {
    const qs = new URLSearchParams({ limit: String(INVOICE_PAGE_LIMIT), account_id: accountId })

    if (startingAfter) {
      qs.set('starting_after', startingAfter)
    }

    const res = await ctx.client.get<RawInvoices>(`${ORIGIN}/backend-api/invoices?${qs.toString()}`)
    const data = res?.data ?? []

    all.push(...data)
    const lastId = data.at(-1)?.id

    // Every row on this page predates the watermark → so does every later (older) page; stop here.
    if (since && data.length > 0 && data.every((inv) => (epochSecDay(inv.created) ?? '') < since)) {
      break
    }

    if (!res?.has_more || data.length === 0 || !lastId) {
      break
    }

    startingAfter = lastId
  }

  return all
}

// Summary + Billing share the per-workspace billing fetch. Both capabilities call fetchChatgptBilling; the
// core query cache dedupes the underlying backend-api reads across the pair. Returns the raw bundles + the
// capture timestamp so the pure build (buildWorkspaceBilling) is deterministic.
const fetchChatgptBilling = async (ctx: CollectContext): Promise<RawChatgptBilling> => {
  const workspaces = await fetchWorkspaces(ctx)
  const get = <T>(path: string) => ctx.client.get<T>(`${ORIGIN}${path}`)

  const bundles: RawWorkspaceBundle[] = []
  const invoices: FlatChatgptInvoice[] = []

  for (const ws of workspaces) {
    const [subscription, seatTypeCounts, remainingBalance, paymentMethods, billingInfo, wsInvoices] = await Promise.all(
      [
        get<RawSubscription>(`/backend-api/subscriptions?account_id=${ws.accountId}`).catch(() => ({})),
        get<RawSeatTypeCounts>(`/backend-api/accounts/${ws.accountId}/users/seat_type_counts`).catch(() => ({})),
        get<RawRemainingBalance>(`/backend-api/accounts/${ws.accountId}/remaining_balance`).catch(() => ({})),
        get<RawPaymentMethods>(`/backend-api/payments/payment_methods?account_id=${ws.accountId}`).catch(() => ({})),
        get<RawBillingInfo>(`/backend-api/payments/billing_info?account_id=${ws.accountId}`).catch(() => ({})),
        // ctx.since (set only on the incremental billing run) stops the cursor walk at the recent tail.
        fetchAllInvoices(ctx, ws.accountId, ctx.since).catch(() => [] as RawInvoice[])
      ]
    )

    bundles.push({
      accountId: ws.accountId,
      name: ws.name,
      planType: ws.planType,
      subscription,
      seatTypeCounts,
      remainingBalance,
      paymentMethods,
      billingInfo
    })

    for (const inv of wsInvoices) {
      invoices.push({ ...inv, accountId: ws.accountId, createdIso: epochSecDay(inv.created) ?? '' })
    }
  }

  return { bundles, invoices, capturedAt: new Date().toISOString() }
}

// The workspace seat roster across all workspaces (Usage + Members share it; the query cache dedupes). Walks
// /backend-api/accounts/<id>/users by offset; dedups by user id (first workspace wins).
const fetchWorkspaceMembers = async (ctx: CollectContext): Promise<WorkspaceMember[]> => {
  const workspaces = await fetchWorkspaces(ctx)
  const byId = new Map<string, WorkspaceMember>()

  for (const ws of workspaces) {
    for (let page = 0; page < MAX_MEMBER_PAGES; page++) {
      const offset = page * MEMBER_PAGE_LIMIT
      const res = await ctx.client
        .get<RawWorkspaceUsers>(
          `${ORIGIN}/backend-api/accounts/${ws.accountId}/users?offset=${offset}&limit=${MEMBER_PAGE_LIMIT}&query=`
        )
        .catch(() => ({}) as RawWorkspaceUsers)
      const items = res?.items ?? []

      for (const u of items) {
        if (u.id && !byId.has(u.id)) {
          byId.set(u.id, {
            userId: u.id,
            seatType: u.seat_type ?? 'default',
            email: u.email ?? null,
            name: u.name ?? null
          })
        }
      }

      if (items.length < MEMBER_PAGE_LIMIT) {
        break
      }
    }
  }

  return [...byId.values()]
}

// Summary + Billing builds (RAW → CapabilityResult). buildWorkspaceBilling is the deterministic normalizer;
// each tab then draws its slice (Summary = the spend.mtd headline; Billing = the account + invoice detail).
export const buildChatgptSummary = (raw: RawChatgptBilling): CapabilityResult =>
  buildChatgptSummaryResult(buildWorkspaceBilling(raw.bundles, raw.invoices, raw.capturedAt))

export const buildChatgptBilling = (raw: RawChatgptBilling): CapabilityResult =>
  buildChatgptBillingTab(buildWorkspaceBilling(raw.bundles, raw.invoices, raw.capturedAt))

// Usage build (RAW → CapabilityResult): join the leaderboard to the roster, then compose the result.
export const buildChatgptUsage = (raw: RawChatgptUsage): CapabilityResult => {
  const seats = new Map(raw.roster.map((m) => [m.userId, m]))

  return buildChatgptUsageResult(
    buildCodexReport({ leaderboard: raw.leaderboard, freshness: raw.freshness }, seats, raw.capturedAt, raw.window)
  )
}

const AGENT_OBS = '/api/agent-observability-v3'
// The leaderboard is scoped by a repeated `products` list (org-wide across every surface); `product=all` is
// no longer accepted. Omitting `workspace_ids` returns every workspace the admin sees.
const USAGE_PRODUCTS = 'products=chatgpt&products=agents&products=codex&products=work'
// The leaderboard window. '1m' is a ROLLING one-month total per member (not a calendar month-to-date), so its
// value rises and falls as days age out of the window — which is why the per-member day-over-day trend is
// approximate rather than a true daily spend.
const USAGE_WINDOW = '1m'

// The usage fetch: the Codex leaderboard (admin.openai.com) + the workspace seat roster (chatgpt.com) it
// joins on. Each degrades to an empty shape so the tab renders zeroed org totals rather than throwing when
// the admin surface isn't authed on the shared partition (the full roster is the Members tab).
const fetchChatgptUsage = async (ctx: CollectContext): Promise<RawChatgptUsage> => {
  const admin = ctx.clientFor('admin')

  const [roster, leaderboard, freshness] = await Promise.all([
    fetchWorkspaceMembers(ctx).catch(() => [] as WorkspaceMember[]),
    admin
      .get<RawLeaderboard>(
        `${AGENT_OBS}/leaderboards/user-token-usage?limit=100&${USAGE_PRODUCTS}&window=${USAGE_WINDOW}&sort_by=credits&sort_direction=desc`
      )
      .catch(() => ({}) as RawLeaderboard),
    admin.get<RawFreshness>(`/api/analytics/data-freshness?use_case=leaderboard_page`).catch(() => ({}) as RawFreshness)
  ])

  return { leaderboard, freshness, roster, capturedAt: new Date().toISOString(), window: USAGE_WINDOW }
}

// ── descriptor ──────────────────────────────────────────────────────────────────────

export const chatgptPlugin = definePlugin({
  reportingCurrency: 'USD',
  meta: {
    id: 'chatgpt',
    name: 'ChatGPT',
    vendor: 'OpenAI',
    category: 'ai',
    color: '#10a37f',
    description:
      'ChatGPT workspace billing (seats, credit, invoices), the per-member Codex usage leaderboard, and the seat roster.',
    homepage: 'https://chatgpt.com',
    dashboardUrl: 'https://chatgpt.com/admin'
  },
  session: {
    // Open the workspace admin billing page so the post-OAuth redirect returns HERE (a marker page) and
    // auto-capture fires once the session cookie lands — a generic landing (e.g. /codex/cloud) settles on no
    // marker, so capture never triggers and you'd have to force it (often before the cookie is set).
    loginUrl: 'https://chatgpt.com/admin/billing',
    // The settled workspace admin / Codex pages — never the login page or a redirect hop.
    dashboardMarkers: ['/admin', '/g/', '/codex'],
    // admin.openai.com is captured alongside chatgpt.com so the Codex leaderboard backend has its cookies.
    cookieDomains: ['chatgpt.com', 'admin.openai.com'],
    requiredCookie: '__Secure-next-auth.session-token'
  },
  // The session cookie mints a short-lived NextAuth Bearer per fetch (GET /api/auth/session) for backend-api.
  auth: { kind: 'minted-jwt', resolve: resolveChatgptBearer },
  // Every chatgpt.com surface only accepts a real browser → Electron transport (browser-matching identity).
  transport: {
    requiresBrowserEngine: true,
    baseUrl: ORIGIN
  },
  // The Codex per-member usage leaderboard lives on admin.openai.com, which is a SEPARATE login from
  // chatgpt.com (its own cookie session — not carried by the chatgpt.com login or its Bearer). It's a
  // secondary backend with its OWN Magic Login: signing into it captures the admin.openai.com cookie jar
  // (stored under `cookie:admin`), which this backend's cookie auth replays verbatim. Until that second login
  // is done the API 302s to sign-in and the Usage tab degrades to zeroed totals.
  backends: {
    admin: {
      // 302 (redirect to sign-in) is the admin-session-dead signal here, so clearing on it re-prompts login.
      auth: { kind: 'cookie', clearOnStatuses: [401, 403, 302] },
      transport: { requiresBrowserEngine: true, baseUrl: ADMIN_ORIGIN },
      label: 'OpenAI Admin',
      session: {
        loginUrl: `${ADMIN_ORIGIN}/analytics`,
        // Settled admin-portal sections — only reachable post-login (the pre-auth root redirects to sign-in).
        dashboardMarkers: ['/analytics', '/data-controls', '/usage', '/members', '/settings', '/projects'],
        cookieDomains: ['admin.openai.com', 'openai.com']
      },
      // A dead admin session 302s to sign-in (status < 400 → not thrown by the client), so assert a real 200.
      probe: async (client) => {
        const res = await client.request({ url: '/api/analytics/data-freshness?use_case=leaderboard_page' })

        if (res.status !== 200) {
          throw Object.assign(new Error(`OpenAI Admin not signed in (HTTP ${res.status})`), { status: res.status })
        }
      }
    }
  },
  capabilities: [
    defineCapability({
      id: 'summary',
      label: 'Summary',
      fetch: fetchChatgptBilling,
      build: buildChatgptSummary,
      sample: sampleChatgptBilling
    }),
    defineCapability({
      id: 'billing',
      label: 'Billing',
      fetch: fetchChatgptBilling,
      build: buildChatgptBilling,
      sample: sampleChatgptBilling,
      // The invoice history is the only billing surface worth walking incrementally (the subscription/seat/
      // balance reads are cheap point-in-time). Core unions the top-level `invoices` by Stripe `id` and sets
      // ctx.since; the fetch re-fetches only the recent tail. Summary is NOT incremental — it shares the fetch
      // but always renders the full history (core's per-URL request cache dedupes the overlap).
      incremental: { listKey: 'invoices', id: 'id', timestamp: 'createdIso', window: { days: 45 } }
    }),
    defineCapability({
      id: 'usage',
      label: 'Usage',
      fetch: fetchChatgptUsage,
      build: buildChatgptUsage,
      sample: sampleChatgptUsage
    }),
    defineCapability({
      id: 'members',
      label: 'Members',
      fetch: fetchWorkspaceMembers,
      build: buildChatgptMembersResult,
      sample: sampleChatgptMembers
    })
  ],
  probe: async (ctx) => {
    // accounts/check is the cheapest authed backend-api call — a 200 proves the minted Bearer reaches it.
    await ctx.client.get(ACCOUNTS_CHECK)
  }
})
