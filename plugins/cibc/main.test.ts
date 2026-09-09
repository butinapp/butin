import { resolveCurrencies, validateCapabilityResult as rawValidateCR } from '@butinapp/sdk/data'
import { expect, test } from 'vitest'

import {
  buildCibcAccounts,
  buildCibcMortgages,
  buildCibcStatements,
  buildCibcTransactions,
  cibcPlugin,
  type RawAccountsResponse,
  type RawMortgage,
  type RawStatement,
  type RawTransaction
} from './main.js'

const validateCapabilityResult = (r: Parameters<typeof resolveCurrencies>[0]): string[] =>
  rawValidateCR(resolveCurrencies(r, 'CAD'))

// Invented stand-ins shaped like the service responses — sequential numbers and round amounts, so nothing here
// can be mistaken for, or traced back to, a real account.
const ACCOUNTS: RawAccountsResponse = {
  accounts: [
    {
      id: 'a1',
      number: '1112223',
      nickname: '',
      capabilities: ['VIEW_TRANSACTIONS_MONTHLY'],
      categorization: { category: 'DEPOSIT', subCategory: 'CHEQUING', extraSubCategory: null },
      availableFunds: 2500.75,
      totalPendingAmount: 0,
      balance: 2500.75,
      status: 'ACTIVE',
      openDate: '2020-01-15'
    },
    {
      id: 'a2',
      number: '1234567890123456',
      nickname: 'Everyday card',
      capabilities: ['VIEW_TRANSACTIONS_MONTHLY'],
      categorization: { category: 'CREDIT', subCategory: 'CREDIT_CARD', extraSubCategory: 'VISA' },
      availableFunds: 3000,
      totalPendingAmount: null,
      balance: 400.25,
      status: 'ACTIVE',
      openDate: '2020-02-20'
    }
  ],
  meta: {
    categories: [
      { id: 'DEPOSIT', balanceTotal: { amount: 2500.75, cadAmount: 2500.75 } },
      { id: 'REGISTERED_INVESTMENT', balanceTotal: null },
      { id: 'CREDIT', balanceTotal: { amount: 4200.25, cadAmount: 4200.25 } }
    ]
  }
}

const transaction = (over: Partial<RawTransaction>): RawTransaction => ({
  key: 'k',
  accountId: 'a1',
  account: 'Chequing ···· 2223',
  day: '2020-04-10',
  description: 'Payroll deposit',
  debit: null,
  credit: null,
  balance: null,
  status: 'posted',
  ...over
})

test('every capability declares a sample that is contract-valid', () => {
  for (const cap of cibcPlugin.capabilities) {
    expect(cap.sample, `${cap.id} has a sample`).toBeDefined()
    expect(validateCapabilityResult(cap.sample!()), cap.id).toEqual([])
  }
})

test('cibc replays the cookie jar alongside the captured X-Auth-Token', async () => {
  const auth = cibcPlugin.auth

  expect(auth.kind).toBe('cookie-csrf')

  if (auth.kind !== 'cookie-csrf' || !auth.resolve) {
    throw new Error('cibc auth must be cookie-csrf with a resolve hook')
  }

  const stored: Record<string, string> = { cookie: 'bm_sz=1; eb-ebm-ai-session-id=2', authToken: 'ebkpcc.token' }
  const attachment = await auth.resolve({
    client: {} as never,
    creds: { get: (field = 'cookie') => stored[field], set: () => {} },
    config: {}
  })

  // A resolve hook replaces core's default cookie attachment, so both halves must come back together.
  expect(attachment.cookie).toBe(stored.cookie)
  expect(attachment.headers?.['X-Auth-Token']).toBe('ebkpcc.token')
})

test('cibc captures the session token off the wire and starts every sign-in with a clean jar', () => {
  expect(cibcPlugin.session?.captureFromHeader).toEqual([
    { header: 'X-Auth-Token', storeAs: 'authToken', on: 'request' }
  ])
  expect(cibcPlugin.session?.persistCookies).toBe(false)
  expect(cibcPlugin.transport?.requiresBrowserEngine).toBe(true)
})

// --- accounts ---

test('accounts reads the bank category totals verbatim and nets them', () => {
  const result = buildCibcAccounts(ACCOUNTS)

  expect(validateCapabilityResult(result)).toEqual([])

  const totals = result.datasets.find((d) => d.id === 'totals')

  expect(totals?.shape === 'record' && totals.value).toEqual({
    deposits: 2500.75,
    investments: 0,
    credit: 4200.25,
    net: -1699.5
  })
  expect(result.summaries).toEqual([{ section: 'balance', label: 'Net position', value: -1699.5, role: 'money' }])
})

test('accounts label a card by its network and last four, and keep a nickname when set', () => {
  const accounts = buildCibcAccounts(ACCOUNTS).datasets.find((d) => d.id === 'accounts')
  const rows = accounts?.shape === 'table' ? accounts.rows : []

  expect(rows.map((r) => [r.account, r.kind])).toEqual([
    ['Chequing ···· 2223', 'Chequing'],
    ['Everyday card', 'Visa']
  ])
  // The full card number never reaches a row.
  expect(JSON.stringify(rows)).not.toContain('1234567890123456')
  // A missing available/pending stays null rather than becoming a misleading zero.
  expect(rows[1]!.pending).toBeNull()
})

test('accounts with no category totals still build', () => {
  const result = buildCibcAccounts({ accounts: [] })

  expect(validateCapabilityResult(result)).toEqual([])
  expect(result.summaries?.[0]!.value).toBe(0)
})

// --- transactions ---

test('transactions list newest first and roll up into a long-format monthly flow', () => {
  const result = buildCibcTransactions([
    transaction({ key: 'k1', day: '2020-03-31', debit: 20.5 }),
    transaction({ key: 'k2', day: '2020-04-10', credit: 1200 }),
    transaction({ key: 'k3', day: '2020-04-22', debit: 60.25 })
  ])

  expect(validateCapabilityResult(result)).toEqual([])

  const ledger = result.datasets.find((d) => d.id === 'transactions')
  const flow = result.datasets.find((d) => d.id === 'monthly-flow')

  expect(ledger?.shape === 'table' && ledger.rows.map((r) => r.day)).toEqual(['2020-04-22', '2020-04-10', '2020-03-31'])
  expect(flow?.shape === 'table' && flow.rows).toEqual([
    { month: '2020-03', direction: 'Money in', amount: 0 },
    { month: '2020-03', direction: 'Money out', amount: 20.5 },
    { month: '2020-04', direction: 'Money in', amount: 1200 },
    { month: '2020-04', direction: 'Money out', amount: 60.25 }
  ])
})

test('transactions drop the chart when there is nothing to chart', () => {
  const result = buildCibcTransactions([])

  expect(validateCapabilityResult(result)).toEqual([])
  expect(result.views?.map((v) => v.type)).toEqual(['table'])
})

// --- statements ---

const statement = (over: Partial<RawStatement>): RawStatement => ({
  key: 'a1:SYN_2020-04',
  accountId: 'a1',
  account: 'Chequing ···· 2223',
  statementId: 'SYN_2020-04',
  documentId: 'doc-1',
  from: '2020-04-01',
  to: '2020-04-30',
  kind: 'Generated',
  name: 'Chequing 2223 2020-04-30',
  ...over
})

test('statements are newest first and downloadable through the capability hook', () => {
  const result = buildCibcStatements([
    statement({ key: 'a1:SYN_2020-03', statementId: 'SYN_2020-03', to: '2020-03-31' }),
    statement({})
  ])

  expect(validateCapabilityResult(result)).toEqual([])

  const rows = result.datasets.find((d) => d.id === 'statements')
  const view = result.views?.[0]

  expect(rows?.shape === 'table' && rows.rows.map((r) => r.to)).toEqual(['2020-04-30', '2020-03-31'])
  expect(view?.type === 'table' && view.files).toEqual({
    name: 'name',
    source: { fetch: true },
    ext: 'pdf',
    category: 'Statements'
  })
  expect(view?.type === 'table' && view.groupBy).toBe('account')
  // The bytes come from the capability's own hook, not a url column — the POST needs the session token in its body.
  expect(cibcPlugin.capabilities.find((c) => c.id === 'statements')?.fetchFile).toBeTypeOf('function')
})

// --- mortgages ---

const MORTGAGE: RawMortgage = {
  accountId: 'm1',
  account: 'Mortgage ···· 4455',
  details: {
    balance: { amount: 250_000 },
    interestRate: 4.25,
    interestRateType: 'FIXED',
    paymentAmount: { amount: 1500 },
    paymentFrequency: 'MONTHLY',
    nextPaymentDate: '2020-05-01T00:00:00-04:00',
    maturityDate: '2025-04-01T00:00:00-04:00',
    asOfDate: '2020-04-01T00:00:00-04:00',
    remainingAmortizationYears: 20,
    remainingAmortizationMonths: 6,
    remainingPrepaymentPrivilegeAmount: { amount: 25_000 },
    summaries: [
      {
        year: 2019,
        annualStatement: {
          principalPaid: { amount: 6000 },
          extraPrincipalPaid: { amount: 0 },
          interestPaid: { amount: 12_000 },
          taxPaid: { amount: 0 },
          insurancePaid: { amount: 0 }
        }
      }
    ]
  },
  payments: [
    {
      paymentDate: '2020-04-01T00:00:00-04:00',
      principal: { amount: '500.00', cadAmount: 500 },
      interest: { amount: '1000.00', cadAmount: 1000 },
      tax: null,
      insurance: null,
      totalAmount: { amount: '1500.00', cadAmount: 1500 }
    }
  ]
}

test('mortgage terms convert the rate to a fraction and read the amortization as one span', () => {
  const result = buildCibcMortgages([MORTGAGE])

  expect(validateCapabilityResult(result)).toEqual([])

  const terms = result.datasets.find((d) => d.id === 'mortgages')
  const row = terms?.shape === 'table' ? terms.rows[0]! : {}

  expect(row.rate).toBeCloseTo(0.0425, 6)
  expect(row.amortization).toBe('20 y 6 m')
  expect(row.balance).toBe(250_000)
  expect(row.nextPayment).toBe('2020-05-01')
})

test('mortgage payments read the string amounts and split into a stacked principal/interest series', () => {
  const result = buildCibcMortgages([MORTGAGE])
  const payments = result.datasets.find((d) => d.id === 'payments')
  const split = result.datasets.find((d) => d.id === 'amortization')

  expect(payments?.shape === 'table' && payments.rows[0]).toMatchObject({
    day: '2020-04-01',
    principal: 500,
    interest: 1000,
    taxes: 0,
    total: 1500
  })
  expect(split?.shape === 'table' && split.rows.map((r) => [r.part, r.amount])).toEqual([
    ['Principal', 500],
    ['Interest', 1000]
  ])
})

test('mortgages with nothing to show build an empty result rather than empty panels', () => {
  const result = buildCibcMortgages([])

  expect(validateCapabilityResult(result)).toEqual([])
  expect(result.datasets).toEqual([])
})
