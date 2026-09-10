import {
  type AuthAttachment,
  type AuthContext,
  type CollectContext,
  defineCapability,
  definePlugin,
  type DocumentBytes
} from '@butinapp/sdk'
import { type CapabilityResult, capabilityResult, record, table } from '@butinapp/sdk/data'
import { DateTime } from '@butinapp/sdk/libs'
import {
  epochMsDay,
  isoDay,
  isPdfBytes,
  parseDecimalAmount,
  round2,
  squish,
  startCase,
  utcDaysAgo
} from '@butinapp/sdk/util'

import { sampleCibcAccounts, sampleCibcMortgages, sampleCibcStatements, sampleCibcTransactions } from './sample.js'

// CIBC Online Banking (cibconline.cibc.com) — the personal-banking portal. Behind the OIDC sign-in every screen is
// an Angular SPA reading plain JSON services under `/ebm-<service>/api/…`: `ebm-ai` (accounts, transactions,
// eStatements, mortgage payments) and `ebm-anp` (the session). So there is nothing to scrape — the collectors
// replay the calls the SPA itself makes.
//
// AUTH is the session cookie jar PLUS an `X-Auth-Token` header. That token (`ebkpcc.<uuid>`) IS the server-side
// banking session: the SPA keeps it in sessionStorage and sends it on every API call, so Magic Login takes it off
// the wire (`captureFromHeader`) — core reads storage tokens from localStorage only. Both halves are required: the
// jar carries the Akamai edge state and the per-service `eb-ebm-*-session-id`s, the header carries the identity.
//
// EDGE: the domain is fronted by Akamai bot management (`_abck`, `bm_sz`, `ak_bmsc`), so replay goes through
// `engine: 'electron'` with the real browser's TLS identity and the centrally injected UA the sign-in window used.
//
// LIFETIME: a bank session is short — it idles out in minutes and there is no silent renew, since the OIDC flow
// asks for the card number and password every time. So headless replay works for a while after capture and then
// 401s, which clears the stored session and re-prompts Sign in. That is the honest shape for a bank: sign in,
// refresh, and the data stays readable offline until the next sign-in.

// ── constants ───────────────────────────────────────────────────────────────────────
const API = 'https://www.cibconline.cibc.com'
const BANKING_SPA = `${API}/ebm-resources/online-banking/accounts/client/index.html`
const DOCUMENTS_SPA = `${API}/ebm-resources/public/my-documents/client/index.html`
const LOGIN_URL = `${API}/ebm-resources/public/auth-gateway/main/client/index.html?locale=en&auth_context=login`

// The brand/channel a session is scoped to: it prefixes the session token (`ebkpcc.<uuid>`), rides as the
// `eb-target-site` cookie, and the statement-PDF POST repeats it in its query string.
const TARGET_SITE = 'ebkpcc'

const ACCOUNTS = '/ebm-ai/api/v2/json/accounts'
const ACCOUNT_DETAILS = '/ebm-ai/api/v1/json/accountDetails'
const TRANSACTIONS = '/ebm-ai/api/v1/json/transactions'
const STATEMENT_LIST = '/ebm-ai/api/v1/json/eStatementLists'
const STATEMENT_PDF = `/ebm-ai/api/v2/json/eStatements?eb-target-site=${TARGET_SITE}`
const MORTGAGE_PAYMENTS = '/ebm-ai/api/v1/json/mortgagePayments'
const SESSIONS = '/ebm-anp/api/v1/json/sessions'

// The list services page on `meta.hasNext`. The page ceiling bounds a pathological walk, not the real history —
// a year of a busy chequing account is a handful of pages.
const PAGE_SIZE = 150
const MAX_PAGES = 40
// How far back a first (non-incremental) transaction fetch reaches; later refreshes ride `ctx.since`.
const HISTORY_DAYS = 365
// The range end runs past today so payments the bank has already posted ahead of time are included.
const FUTURE_DAYS = 7
// Trailing horizon always re-fetched, so a pending entry that later posts — or a revised running balance — is
// picked up instead of frozen at its first reading.
const REFETCH_WINDOW_DAYS = 14

// Only accounts carrying this capability answer the transactions service; the others return an error.
const CAN_LIST_TRANSACTIONS = 'VIEW_TRANSACTIONS_MONTHLY'

const MONEY_IN = 'Money in'
const MONEY_OUT = 'Money out'
const PRINCIPAL = 'Principal'
const INTEREST = 'Interest'

// eStatement kinds: a statement the bank issued and printed, vs one generated on demand for a period.
const STATEMENT_KINDS: Record<string, string> = { pre_printed: 'Issued', synthesized: 'Generated' }

// ── types ─────────────────────────────────────────────────────────────────────────
// Money arrives three ways: a bare number (accounts), `{ amount }` as a number (account details), and
// `{ amount: '12.34', cadAmount }` (mortgage payments, category totals).
type WireAmount = {
  amount?: number | string
  cadAmount?: number | null
}

export type RawAccount = {
  id: string
  number?: string | null
  nickname?: string | null
  balance?: number | null
  availableFunds?: number | null
  totalPendingAmount?: number | null
  status?: string | null
  openDate?: string | null
  capabilities?: string[]
  categorization?: { category?: string; subCategory?: string; extraSubCategory?: string | null }
}

export type RawAccountsResponse = {
  accounts?: RawAccount[]
  meta?: { categories?: { id: string; balanceTotal?: WireAmount | null }[] }
}

export type RawTransactionsResponse = {
  transactions?: {
    date?: string
    transactionDescription?: string
    debit?: number | null
    credit?: number | null
    runningBalance?: number | null
    pendingIndicator?: boolean | null
  }[]
  meta?: { hasNext?: boolean }
}

// A transaction flattened onto the account it belongs to. The wire `id` is a position within the response
// ("21", "20", …) that the next range query reuses, so `key` is a synthesized identity: the account, the day,
// both amounts, the running-ledger position, and the description. Two genuinely identical same-day entries on an
// account that reports no running balance collapse into one row — the only case this can't separate.
export type RawTransaction = {
  key: string
  accountId: string
  account: string
  day: string
  description: string
  debit: number | null
  credit: number | null
  balance: number | null
  status: string
}

export type RawStatementListResponse = {
  eStatementLists?: {
    id?: string
    statementId?: string
    statementDateFrom?: number | null
    statementDateTo?: number | null
    eventType?: string | null
  }[]
}

export type RawStatement = {
  key: string
  accountId: string
  account: string
  statementId: string
  // The service's own handle for the document, which the PDF POST takes. Re-resolved at download time: a
  // generated statement is re-minted per session, so a retained row's handle goes stale.
  documentId: string
  from: string | null
  to: string | null
  kind: string
  name: string
}

export type RawMortgageDetails = {
  balance?: WireAmount | null
  interestRate?: number | null
  interestRateType?: string | null
  paymentAmount?: WireAmount | null
  paymentFrequency?: string | null
  nextPaymentDate?: string | null
  maturityDate?: string | null
  asOfDate?: string | null
  remainingAmortizationYears?: number | null
  remainingAmortizationMonths?: number | null
  remainingPrepaymentPrivilegeAmount?: WireAmount | null
  summaries?: {
    year?: number
    annualStatement?: {
      principalPaid?: WireAmount | null
      extraPrincipalPaid?: WireAmount | null
      interestPaid?: WireAmount | null
      taxPaid?: WireAmount | null
      insurancePaid?: WireAmount | null
    } | null
  }[]
}

export type RawAccountDetailsResponse = {
  accountDetails?: { details?: RawMortgageDetails | null }
}

export type RawMortgagePayment = {
  paymentDate?: string
  principal?: WireAmount | null
  interest?: WireAmount | null
  tax?: WireAmount | null
  insurance?: WireAmount | null
  totalAmount?: WireAmount | null
}

export type RawMortgagePaymentsResponse = {
  mortgagePayments?: RawMortgagePayment[]
  meta?: { hasNext?: boolean }
}

// One mortgage with everything its tab draws: the terms, the payment ledger, and the per-year statement.
export type RawMortgage = {
  accountId: string
  account: string
  details?: RawMortgageDetails
  payments: RawMortgagePayment[]
}

// ── shared helpers ────────────────────────────────────────────────────────────────
const amountOf = (value?: WireAmount | number | null): number => {
  if (typeof value === 'number') {
    return round2(value)
  }

  if (!value) {
    return 0
  }

  if (typeof value.cadAmount === 'number') {
    return round2(value.cadAmount)
  }

  return typeof value.amount === 'number' ? round2(value.amount) : round2(parseDecimalAmount(value.amount))
}

// The account and card numbers come back in full, so every view — and the on-disk export — shows the last four.
const maskNumber = (value: string): string => (value.length > 4 ? `···· ${value.slice(-4)}` : value)

// The product a row is: a card reads as its network (Visa), everything else as its sub-category (Chequing,
// Mortgage). `startCase` turns the wire's SCREAMING_SNAKE into a title.
const accountKind = (account: RawAccount): string => {
  const { subCategory, extraSubCategory } = account.categorization ?? {}
  const raw = subCategory === 'CREDIT_CARD' ? (extraSubCategory ?? subCategory) : subCategory

  return raw ? startCase(raw) : 'Account'
}

// What every table calls an account: the nickname the user set, else the product plus its last four.
const accountLabel = (account: RawAccount): string =>
  account.nickname?.trim() || `${accountKind(account)} ${maskNumber(account.number ?? '')}`.trim()

const fetchAccounts = async (ctx: CollectContext): Promise<RawAccountsResponse> =>
  ctx.client.get<RawAccountsResponse>(ACCOUNTS)

// ── accounts: the holdings across every product ─────────────────────────────────────
type TotalsRow = {
  deposits: number
  investments: number
  credit: number
  net: number
}

type AccountRow = {
  accountId: string
  account: string
  kind: string
  status: string
  balance: number
  available: number | null
  pending: number | null
  opened: string | null
}

// Pure transform — fixture-tested. The bank publishes its own category totals alongside the account list and they
// are authoritative (they span products the list summarizes differently), so they are read verbatim rather than
// re-summed from the rows.
export const buildCibcAccounts = (res: RawAccountsResponse): CapabilityResult => {
  const totalOf = (id: string): number => amountOf(res.meta?.categories?.find((c) => c.id === id)?.balanceTotal)
  const deposits = totalOf('DEPOSIT')
  const investments = round2(totalOf('NON_REGISTERED_INVESTMENT') + totalOf('REGISTERED_INVESTMENT'))
  const credit = totalOf('CREDIT')
  const net = round2(deposits + investments - credit)

  const rows: AccountRow[] = (res.accounts ?? []).map((a) => ({
    accountId: a.id,
    account: accountLabel(a),
    kind: accountKind(a),
    status: a.status ? startCase(a.status) : '',
    balance: amountOf(a.balance),
    available: a.availableFunds == null ? null : amountOf(a.availableFunds),
    pending: a.totalPendingAmount == null ? null : amountOf(a.totalPendingAmount),
    opened: isoDay(a.openDate) ?? null
  }))

  return capabilityResult({
    sections: [
      record<TotalsRow>({
        id: 'totals',
        fields: [
          { key: 'deposits', label: 'Deposits', role: 'money' },
          { key: 'investments', label: 'Investments', role: 'money' },
          { key: 'credit', label: 'Credit owed', role: 'money' },
          { key: 'net', label: 'Net position', role: 'money' }
        ],
        value: { deposits, investments, credit, net }
      }).stat({
        title: 'Holdings',
        fields: [
          'deposits',
          'investments',
          'credit',
          { key: 'net', tone: net < 0 ? 'negative' : 'positive', caption: 'Deposits and investments less credit' }
        ]
      }),
      table<AccountRow>({
        id: 'accounts',
        columns: [
          { key: 'account', label: 'Account', role: 'label' },
          { key: 'kind', label: 'Product', role: 'category' },
          { key: 'status', label: 'Status', role: 'status' },
          { key: 'balance', label: 'Balance', role: 'money' },
          { key: 'available', label: 'Available', role: 'money' },
          { key: 'pending', label: 'Pending', role: 'money' },
          { key: 'opened', label: 'Opened', role: 'timestamp' },
          { key: 'accountId', role: 'identifier', hidden: true }
        ],
        rows,
        key: 'accountId'
      }).table({ title: 'Accounts' })
    ],
    // Balance, not spend: holdings show per-service on the Overview and are never summed with everyone else's bills.
    summaries: [{ section: 'balance', label: 'Net position', value: net, role: 'money' }]
  })
}

// ── transactions: the ledger across every account that keeps one ─────────────────────
// The account id keys the fetch, not the row — the table names the account instead.
type TransactionRow = Omit<RawTransaction, 'accountId'>

type FlowRow = {
  month: string
  direction: string
  amount: number
}

// Pure transform — fixture-tested. The union of every fetched transaction → the ledger plus the monthly in/out
// flow the tab charts.
export const buildCibcTransactions = (rows: RawTransaction[]): CapabilityResult => {
  const ledger: TransactionRow[] = [...rows]
    .sort((a, b) => b.day.localeCompare(a.day) || b.key.localeCompare(a.key))
    .map(({ accountId, ...row }) => row)

  const byMonth = new Map<string, { moneyIn: number; moneyOut: number }>()

  for (const t of rows) {
    const month = t.day.slice(0, 7)
    const bucket = byMonth.get(month) ?? { moneyIn: 0, moneyOut: 0 }

    bucket.moneyIn += t.credit ?? 0
    bucket.moneyOut += t.debit ?? 0
    byMonth.set(month, bucket)
  }

  // Long format (one row per month per direction) so the chart stacks money in against money out.
  const flow: FlowRow[] = [...byMonth.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .flatMap(([month, v]) => [
      { month, direction: MONEY_IN, amount: round2(v.moneyIn) },
      { month, direction: MONEY_OUT, amount: round2(v.moneyOut) }
    ])

  return capabilityResult({
    sections: [
      flow.length > 0 &&
        table<FlowRow>({
          id: 'monthly-flow',
          columns: [
            { key: 'month', label: 'Month', role: 'timestamp' },
            { key: 'direction', label: 'Direction', role: 'category' },
            { key: 'amount', label: 'Amount', role: 'money' }
          ],
          rows: flow,
          key: ['month', 'direction'],
          retention: 'rollup'
        }).timeseries({ x: 'month', y: 'amount', stackBy: 'direction', granularity: 'monthly', title: 'Monthly flow' }),
      table<TransactionRow>({
        id: 'transactions',
        columns: [
          { key: 'day', label: 'Date', role: 'timestamp' },
          { key: 'account', label: 'Account', role: 'category' },
          { key: 'description', label: 'Description', role: 'text', truncate: true },
          { key: 'debit', label: 'Out', role: 'money' },
          { key: 'credit', label: 'In', role: 'money' },
          { key: 'balance', label: 'Balance', role: 'money' },
          { key: 'status', label: 'Status', role: 'status', badges: { pending: 'warning', posted: 'neutral' } },
          { key: 'key', role: 'identifier', hidden: true }
        ],
        rows: ledger,
        key: 'key'
      }).table({ title: 'Transactions' })
    ]
  })
}

// One account's transactions over a date range, walked page by page until the service stops reporting more.
const fetchAccountTransactions = async (
  ctx: CollectContext,
  account: RawAccount,
  fromDate: string,
  toDate: string
): Promise<RawTransaction[]> => {
  const label = accountLabel(account)
  const out: RawTransaction[] = []

  for (let page = 0; page < MAX_PAGES; page++) {
    const query = new URLSearchParams({
      accountId: account.id,
      depositTransactionState: 'both',
      filterBy: 'range',
      fromDate,
      toDate,
      limit: String(PAGE_SIZE),
      offset: String(page * PAGE_SIZE),
      sortAsc: 'false',
      sortByField: 'date'
    })
    const res = await ctx.client.get<RawTransactionsResponse>(`${TRANSACTIONS}?${query}`)

    for (const t of res.transactions ?? []) {
      // The wire dates are the bank's own calendar day at local midnight, so they are kept as written.
      const day = isoDay(t.date)

      if (!day) {
        continue
      }

      const debit = t.debit == null ? null : round2(t.debit)
      const credit = t.credit == null ? null : round2(t.credit)
      const balance = t.runningBalance == null ? null : round2(t.runningBalance)
      const description = squish(t.transactionDescription)

      out.push({
        key: [account.id, day, debit ?? '', credit ?? '', balance ?? '', description].join('|'),
        accountId: account.id,
        account: label,
        day,
        description,
        debit,
        credit,
        balance,
        status: t.pendingIndicator ? 'pending' : 'posted'
      })
    }

    if (!res.meta?.hasNext) {
      break
    }
  }

  return out
}

const fetchCibcTransactions = async (ctx: CollectContext): Promise<RawTransaction[]> => {
  const accounts = (await fetchAccounts(ctx)).accounts ?? []
  const fromDate = ctx.since ?? utcDaysAgo(HISTORY_DAYS)
  const toDate = DateTime.utc().plus({ days: FUTURE_DAYS }).toISODate()!
  const out: RawTransaction[] = []

  for (const account of accounts.filter((a) => a.capabilities?.includes(CAN_LIST_TRANSACTIONS))) {
    // Best effort per account: one product refusing the range must not blank the whole ledger.
    const rows = await fetchAccountTransactions(ctx, account, fromDate, toDate).catch((error: unknown) => {
      ctx.log('cibc: transactions unavailable', { account: accountLabel(account), error: String(error) })

      return []
    })

    out.push(...rows)
  }

  return out
}

// ── statements: the downloadable eStatement PDFs ─────────────────────────────────────
// Pure transform — fixture-tested. Every account's statement list → one downloadable table, grouped by account.
export const buildCibcStatements = (statements: RawStatement[]): CapabilityResult => {
  const rows = [...statements].sort(
    (a, b) => (b.to ?? '').localeCompare(a.to ?? '') || a.account.localeCompare(b.account)
  )

  return capabilityResult({
    sections: [
      table<RawStatement>({
        id: 'statements',
        columns: [
          { key: 'account', label: 'Account', role: 'category' },
          { key: 'from', label: 'From', role: 'timestamp' },
          { key: 'to', label: 'To', role: 'timestamp' },
          { key: 'kind', label: 'Kind', role: 'category' },
          { key: 'key', role: 'identifier', hidden: true },
          { key: 'accountId', role: 'identifier', hidden: true },
          { key: 'statementId', role: 'identifier', hidden: true },
          { key: 'documentId', role: 'identifier', hidden: true },
          { key: 'name', role: 'label', hidden: true }
        ],
        rows,
        key: 'key'
      }).fileTable({
        title: 'Statements',
        name: 'name',
        source: { fetch: true },
        ext: 'pdf',
        category: 'Statements',
        groupBy: 'account'
      })
    ]
  })
}

const fetchCibcStatements = async (ctx: CollectContext): Promise<RawStatement[]> => {
  const accounts = (await fetchAccounts(ctx)).accounts ?? []
  const out: RawStatement[] = []

  for (const account of accounts) {
    // No capability flag names eStatements, so every account is asked and the ones that keep none simply
    // contribute nothing.
    const res = await ctx.client
      .get<RawStatementListResponse>(`${STATEMENT_LIST}?accountId=${encodeURIComponent(account.id)}`)
      .catch(() => ({}) as RawStatementListResponse)

    const label = accountLabel(account)
    // The filename tag keeps the digits bare — the masked form's separator has no place in a file name.
    const fileTag = `${accountKind(account)} ${(account.number ?? '').slice(-4)}`.trim()

    for (const s of res.eStatementLists ?? []) {
      if (!s.statementId) {
        continue
      }

      const to = epochMsDay(s.statementDateTo) ?? null

      out.push({
        key: `${account.id}:${s.statementId}`,
        accountId: account.id,
        account: label,
        statementId: s.statementId,
        documentId: s.id ?? '',
        from: epochMsDay(s.statementDateFrom) ?? null,
        to,
        kind: STATEMENT_KINDS[s.eventType ?? ''] ?? startCase(s.eventType ?? ''),
        name: `${fileTag} ${to ?? s.statementId}`
      })
    }
  }

  return out
}

// The PDF is a form POST that carries the session token in its BODY as well as its header, and takes the service's
// own document handle. A generated statement is re-minted per session, so a retained row's handle can be stale —
// re-list the account and match on the stable `statementId` before asking for the bytes.
const fetchStatementPdf = async (ctx: CollectContext, row: Record<string, unknown>): Promise<DocumentBytes> => {
  const accountId = String(row.accountId)
  const statementId = String(row.statementId)
  const list = await ctx.client.get<RawStatementListResponse>(
    `${STATEMENT_LIST}?accountId=${encodeURIComponent(accountId)}`
  )
  const documentId = list.eStatementLists?.find((s) => s.statementId === statementId)?.id ?? String(row.documentId)

  if (!documentId) {
    throw new Error(`CIBC: statement ${statementId} is no longer listed on the account`)
  }

  const body = new URLSearchParams({
    accountId,
    id: documentId,
    lang: 'en',
    'X-Auth-Token': ctx.creds.get('authToken') ?? ''
  }).toString()

  const res = await ctx.client.request<ArrayBuffer>({
    url: STATEMENT_PDF,
    method: 'POST',
    body,
    responseType: 'arraybuffer',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: '*/*' },
    referer: DOCUMENTS_SPA
  })
  const bytes = new Uint8Array(res.data)

  ctx.log('cibc: statement download', { statementId, bytes: bytes.length })

  // An expired session answers this endpoint with an HTML error page, so a non-PDF body fails loudly rather than
  // being saved as a statement.
  if (!isPdfBytes(bytes)) {
    throw new Error(`CIBC: statement ${statementId} did not download as a PDF`)
  }

  return bytes
}

// ── mortgages: the terms, the amortization split, and the annual statement ────────────
type MortgageRow = {
  accountId: string
  account: string
  balance: number
  asOf: string | null
  rate: number | null
  rateType: string
  payment: number
  frequency: string
  nextPayment: string | null
  maturity: string | null
  amortization: string
  prepaymentRoom: number
}

type MortgagePaymentRow = {
  key: string
  account: string
  day: string
  principal: number
  interest: number
  taxes: number
  insurance: number
  total: number
}

type AmortizationRow = {
  key: string
  day: string
  part: string
  amount: number
}

type AnnualRow = {
  key: string
  account: string
  year: string
  principal: number
  extraPrincipal: number
  interest: number
  taxes: number
  insurance: number
}

// Amortization left as one readable span ('23 y 11 m'); either half alone still reads.
const amortizationLabel = (years?: number | null, months?: number | null): string =>
  [years ? `${years} y` : '', months ? `${months} m` : ''].filter(Boolean).join(' ')

// Pure transform — fixture-tested. Every mortgage → its terms, the principal/interest split of each payment, the
// payment ledger, and the per-year statement the bank publishes for taxes.
export const buildCibcMortgages = (mortgages: RawMortgage[]): CapabilityResult => {
  const terms: MortgageRow[] = mortgages.map(({ accountId, account, details }) => ({
    accountId,
    account,
    balance: amountOf(details?.balance),
    asOf: isoDay(details?.asOfDate) ?? null,
    // The wire reports a whole-number rate (4.25); the percent role formats a 0..1 fraction.
    rate: details?.interestRate == null ? null : details.interestRate / 100,
    rateType: details?.interestRateType ? startCase(details.interestRateType) : '',
    payment: amountOf(details?.paymentAmount),
    frequency: details?.paymentFrequency ? startCase(details.paymentFrequency) : '',
    nextPayment: isoDay(details?.nextPaymentDate) ?? null,
    maturity: isoDay(details?.maturityDate) ?? null,
    amortization: amortizationLabel(details?.remainingAmortizationYears, details?.remainingAmortizationMonths),
    prepaymentRoom: amountOf(details?.remainingPrepaymentPrivilegeAmount)
  }))

  const payments: MortgagePaymentRow[] = mortgages
    .flatMap(({ accountId, account, payments: rows }) =>
      rows.flatMap((p) => {
        const day = isoDay(p.paymentDate)

        return day
          ? [
              {
                key: `${accountId}:${day}`,
                account,
                day,
                principal: amountOf(p.principal),
                interest: amountOf(p.interest),
                taxes: amountOf(p.tax),
                insurance: amountOf(p.insurance),
                total: amountOf(p.totalAmount)
              }
            ]
          : []
      })
    )
    .sort((a, b) => b.day.localeCompare(a.day) || a.account.localeCompare(b.account))

  // Long format (one row per payment per part) so the chart stacks principal against interest.
  const split: AmortizationRow[] = [...payments]
    .sort((a, b) => a.day.localeCompare(b.day))
    .flatMap((p) => [
      { key: `${p.key}:principal`, day: p.day, part: PRINCIPAL, amount: p.principal },
      { key: `${p.key}:interest`, day: p.day, part: INTEREST, amount: p.interest }
    ])

  const annual: AnnualRow[] = mortgages
    .flatMap(({ accountId, account, details }) =>
      (details?.summaries ?? []).flatMap((s) => {
        const statement = s.annualStatement

        return s.year
          ? [
              {
                key: `${accountId}:${s.year}`,
                account,
                year: String(s.year),
                principal: amountOf(statement?.principalPaid),
                extraPrincipal: amountOf(statement?.extraPrincipalPaid),
                interest: amountOf(statement?.interestPaid),
                taxes: amountOf(statement?.taxPaid),
                insurance: amountOf(statement?.insurancePaid)
              }
            ]
          : []
      })
    )
    .sort((a, b) => b.year.localeCompare(a.year) || a.account.localeCompare(b.account))

  return capabilityResult({
    sections: [
      terms.length > 0 &&
        table<MortgageRow>({
          id: 'mortgages',
          columns: [
            { key: 'account', label: 'Account', role: 'label' },
            { key: 'balance', label: 'Balance', role: 'money' },
            { key: 'asOf', label: 'As of', role: 'timestamp' },
            { key: 'rate', label: 'Rate', role: 'percent' },
            { key: 'rateType', label: 'Rate type', role: 'category' },
            { key: 'payment', label: 'Payment', role: 'money' },
            { key: 'frequency', label: 'Frequency', role: 'category' },
            { key: 'nextPayment', label: 'Next payment', role: 'timestamp' },
            { key: 'maturity', label: 'Maturity', role: 'timestamp' },
            { key: 'amortization', label: 'Amortization left', role: 'text' },
            { key: 'prepaymentRoom', label: 'Prepayment room', role: 'money' },
            { key: 'accountId', role: 'identifier', hidden: true }
          ],
          rows: terms,
          key: 'accountId'
        }).table({ title: 'Terms' }),
      split.length > 0 &&
        table<AmortizationRow>({
          id: 'amortization',
          columns: [
            { key: 'day', label: 'Payment', role: 'timestamp' },
            { key: 'part', label: 'Part', role: 'category' },
            { key: 'amount', label: 'Amount', role: 'money' },
            { key: 'key', role: 'identifier', hidden: true }
          ],
          rows: split,
          key: 'key'
        }).timeseries({
          x: 'day',
          y: 'amount',
          stackBy: 'part',
          granularity: 'monthly',
          title: 'Where each payment goes'
        }),
      payments.length > 0 &&
        table<MortgagePaymentRow>({
          id: 'payments',
          columns: [
            { key: 'day', label: 'Date', role: 'timestamp' },
            { key: 'account', label: 'Account', role: 'category' },
            { key: 'principal', label: 'Principal', role: 'money' },
            { key: 'interest', label: 'Interest', role: 'money' },
            { key: 'taxes', label: 'Taxes', role: 'money' },
            { key: 'insurance', label: 'Insurance', role: 'money' },
            { key: 'total', label: 'Total', role: 'money' },
            { key: 'key', role: 'identifier', hidden: true }
          ],
          rows: payments,
          key: 'key'
        }).table({ title: 'Payments' }),
      annual.length > 0 &&
        table<AnnualRow>({
          id: 'annual',
          columns: [
            { key: 'year', label: 'Year', role: 'category' },
            { key: 'account', label: 'Account', role: 'category' },
            { key: 'principal', label: 'Principal paid', role: 'money' },
            { key: 'extraPrincipal', label: 'Extra principal', role: 'money' },
            { key: 'interest', label: 'Interest paid', role: 'money' },
            { key: 'taxes', label: 'Taxes paid', role: 'money' },
            { key: 'insurance', label: 'Insurance paid', role: 'money' },
            { key: 'key', role: 'identifier', hidden: true }
          ],
          rows: annual,
          key: 'key'
        }).table({ title: 'Annual statement' })
    ]
  })
}

const fetchCibcMortgages = async (ctx: CollectContext): Promise<RawMortgage[]> => {
  const accounts = (await fetchAccounts(ctx)).accounts ?? []
  const out: RawMortgage[] = []

  for (const account of accounts.filter((a) => a.categorization?.subCategory === 'MORTGAGE')) {
    const detailsRes = await ctx.client
      .get<RawAccountDetailsResponse>(`${ACCOUNT_DETAILS}/${encodeURIComponent(account.id)}`)
      .catch(() => ({}) as RawAccountDetailsResponse)
    const payments: RawMortgagePayment[] = []

    for (let page = 0; page < MAX_PAGES; page++) {
      const query = `accountId=${encodeURIComponent(account.id)}&limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`
      const res = await ctx.client
        .get<RawMortgagePaymentsResponse>(`${MORTGAGE_PAYMENTS}?${query}`)
        .catch(() => ({}) as RawMortgagePaymentsResponse)

      payments.push(...(res.mortgagePayments ?? []))

      if (!res.meta?.hasNext) {
        break
      }
    }

    out.push({
      accountId: account.id,
      account: accountLabel(account),
      details: detailsRes.accountDetails?.details ?? undefined,
      payments
    })
  }

  return out
}

// ── i18n ────────────────────────────────────────────────────────────────────────────
// CIBC serves both official languages and the collectors read the English channel, so the French renderings of
// what this plugin emits are declared here.
const CIBC_FR: Record<string, string> = {
  Accounts: 'Comptes',
  Transactions: 'Opérations',
  Statements: 'Relevés',
  Mortgages: 'Prêts hypothécaires',
  Holdings: 'Avoirs',
  Deposits: 'Dépôts',
  Investments: 'Placements',
  'Credit owed': 'Crédit dû',
  'Net position': 'Avoir net',
  'Deposits and investments less credit': 'Dépôts et placements moins le crédit',
  Account: 'Compte',
  Product: 'Produit',
  Status: 'État',
  Balance: 'Solde',
  Available: 'Disponible',
  Pending: 'En attente',
  Posted: 'Comptabilisé',
  Opened: 'Ouvert le',
  'Monthly flow': 'Mouvements mensuels',
  Month: 'Mois',
  Direction: 'Sens',
  Amount: 'Montant',
  [MONEY_IN]: 'Entrées',
  [MONEY_OUT]: 'Sorties',
  Date: 'Date',
  Description: 'Description',
  Out: 'Débit',
  In: 'Crédit',
  From: 'Du',
  To: 'Au',
  Kind: 'Type',
  Issued: 'Émis',
  Generated: 'Généré',
  Terms: 'Conditions',
  Rate: 'Taux',
  'Rate type': 'Type de taux',
  Payment: 'Paiement',
  Frequency: 'Fréquence',
  'Next payment': 'Prochain paiement',
  Maturity: 'Échéance',
  'Amortization left': 'Amortissement restant',
  'Prepayment room': 'Remboursement anticipé disponible',
  'As of': 'En date du',
  'Where each payment goes': 'Répartition de chaque paiement',
  Part: 'Portion',
  [PRINCIPAL]: 'Capital',
  [INTEREST]: 'Intérêts',
  Payments: 'Paiements',
  Taxes: 'Taxes',
  Insurance: 'Assurance',
  Total: 'Total',
  'Annual statement': 'État annuel',
  Year: 'Année',
  'Principal paid': 'Capital remboursé',
  'Extra principal': 'Capital supplémentaire',
  'Interest paid': 'Intérêts payés',
  'Taxes paid': 'Taxes payées',
  'Insurance paid': 'Assurance payée'
}

// ── descriptor ──────────────────────────────────────────────────────────────────────
export const cibcPlugin = definePlugin({
  reportingCurrency: 'CAD',
  meta: {
    id: 'cibc',
    name: 'CIBC',
    vendor: 'CIBC',
    category: 'finance',
    color: '#a5122f',
    homepage: 'https://www.cibc.com',
    dashboardUrl: `${BANKING_SPA}#/`,
    messages: { fr: CIBC_FR },
    description:
      'CIBC Online Banking — balances across deposits, cards and mortgages, the transaction ledger, downloadable eStatements, and mortgage terms.'
  },
  session: {
    loginUrl: LOGIN_URL,
    // The settled authenticated SPA. The auth-gateway page under /public/ carries the OIDC hops, so it must not
    // match this marker.
    dashboardMarkers: ['/ebm-resources/online-banking/accounts/client/index.html'],
    // One substring spans www.cibc.com (the edge cookies), www.cibconline.cibc.com (the APIs) and secure.cibc.com
    // (the sign-in).
    cookieDomains: ['cibc.com'],
    // Minted by the first `ebm-ai` response — the same call that carries the header captured below, so requiring
    // it means the token has already been seen.
    requiredCookie: 'eb-ebm-ai-session-id',
    // The banking session token. The SPA holds it in sessionStorage, which the capture can't read, but sends it on
    // every API call — so it is taken off the wire instead.
    captureFromHeader: [{ header: 'X-Auth-Token', storeAs: 'authToken', on: 'request' }],
    // The session cookies are server-side and short-lived, and the token they pair with dies with them, so
    // promoting the jar would only carry dead state into the next sign-in. Every reconnect starts clean.
    persistCookies: false
  },
  auth: {
    // Cookie plus a header: the jar carries the edge and per-service session state, `X-Auth-Token` carries the
    // identity. Returning the stored cookie here is load-bearing — a resolve() hook replaces core's default cookie
    // attachment, so omitting it would send every call out session-less.
    kind: 'cookie-csrf',
    resolve: async (ctx: AuthContext): Promise<AuthAttachment> => ({
      cookie: ctx.creds.get('cookie') ?? '',
      headers: { 'X-Auth-Token': ctx.creds.get('authToken') ?? '' }
    })
  },
  transport: {
    // The edge only accepts a real browser (Akamai `_abck`/`bm_sz`), so replay carries the real browser's TLS
    // identity. The UA is injected centrally for both capture and replay, so the two always agree.
    engine: 'electron',
    requiresBrowserEngine: true,
    baseUrl: API,
    // What the SPA sends on every service call: `brand` and `Client-Type` select the retail channel. The calls are
    // same-origin, so there is a Referer and no Origin — as in the browser.
    defaultHeaders: {
      Accept: 'application/json',
      'Accept-Language': 'en',
      'Client-Type': 'DEFAULT_WEB',
      'Content-Type': 'application/json',
      brand: 'cibc',
      Referer: BANKING_SPA
    },
    download: { referer: DOCUMENTS_SPA }
  },
  capabilities: [
    defineCapability({
      id: 'accounts',
      label: 'Accounts',
      fetch: fetchAccounts,
      build: buildCibcAccounts,
      sample: sampleCibcAccounts
    }),
    defineCapability({
      id: 'transactions',
      label: 'Transactions',
      fetch: fetchCibcTransactions,
      build: buildCibcTransactions,
      sample: sampleCibcTransactions,
      // The bank serves a rolling window only, so each refresh fetches from the watermark back a fortnight and the
      // kept union holds the history the service has since dropped.
      incremental: { id: 'key', timestamp: 'day', window: { days: REFETCH_WINDOW_DAYS } }
    }),
    defineCapability({
      id: 'statements',
      label: 'Statements',
      fetch: fetchCibcStatements,
      build: buildCibcStatements,
      sample: sampleCibcStatements,
      fetchFile: fetchStatementPdf
    }),
    defineCapability({
      id: 'mortgages',
      label: 'Mortgages',
      fetch: fetchCibcMortgages,
      build: buildCibcMortgages,
      sample: sampleCibcMortgages
    })
  ],
  // The session service is the cheapest authed call — it returns the entitlements the signed-in profile carries. A
  // session the backend has already dropped answers without them, so the shape is checked, not just the status.
  probe: async (ctx) => {
    const res = await ctx.client.get<{ entitlements?: string[] }>(SESSIONS)

    if (!Array.isArray(res?.entitlements)) {
      throw new Error('CIBC: the online-banking session is no longer signed in')
    }
  }
})
