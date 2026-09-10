// Synthetic sample generators for the demo seed — every value comes from the seeded toolkit (fabricated numbers
// and dates), drawn through the SAME build* the live collectors use. The `documents` knob scales the
// statement/payment history, `days` and `window` the size and spread of the transaction ledger.

import { DateTime } from '@butinapp/sdk/libs'
import { createSampleGen, type SampleConfig, type SampleGen } from '@butinapp/sdk/testing'

import type { RawAccount, RawAccountsResponse, RawMortgage, RawStatement, RawTransaction } from './main.js'

// The three accounts the demo shows. Their identities are drawn once from a generator of their own, so every
// generator below — each seeded on its own capability — labels the same account the same way.
const identity = createSampleGen('cibc:accounts')

type DemoAccount = {
  id: string
  kind: string
  number: string
  categorization: { category: string; subCategory: string; extraSubCategory: string | null }
  capabilities: string[]
}

const TRANSACTING = ['VIEW_TRANSACTIONS_MONTHLY', 'DOWNLOAD_TRANSACTIONS']

const CHEQUING: DemoAccount = {
  id: 'acct-chequing',
  kind: 'Chequing',
  number: String(identity.int(1_000_000, 9_999_999)),
  categorization: { category: 'DEPOSIT', subCategory: 'CHEQUING', extraSubCategory: null },
  capabilities: TRANSACTING
}

const VISA: DemoAccount = {
  id: 'acct-visa',
  kind: 'Visa',
  number: `45${identity.int(10_000_000_000_000, 99_999_999_999_999)}`,
  categorization: { category: 'CREDIT', subCategory: 'CREDIT_CARD', extraSubCategory: 'VISA' },
  capabilities: TRANSACTING
}

const MORTGAGE: DemoAccount = {
  id: 'acct-mortgage',
  kind: 'Mortgage',
  number: String(identity.int(1_000_000_000, 9_999_999_999)),
  categorization: { category: 'CREDIT', subCategory: 'MORTGAGE', extraSubCategory: 'RESIDENTIAL' },
  capabilities: ['SHOW_ACCOUNT_DETAILS']
}

// The masked label the collectors derive from an account, rebuilt for the rows that carry a label directly.
const label = (a: DemoAccount): string => `${a.kind} ···· ${a.number.slice(-4)}`

// The identity half of an account row, as the accounts service sends it.
const wireAccount = (a: DemoAccount): RawAccount => ({
  id: a.id,
  number: a.number,
  nickname: '',
  status: 'ACTIVE',
  capabilities: a.capabilities,
  categorization: a.categorization
})

export const sampleCibcAccounts = (g: SampleGen): RawAccountsResponse => {
  const chequing = g.money(400, 6000)
  const visa = g.money(50, 2400)
  const mortgage = g.money(90_000, 340_000)

  return {
    accounts: [
      {
        ...wireAccount(CHEQUING),
        availableFunds: chequing,
        totalPendingAmount: 0,
        balance: chequing,
        openDate: g.dayString(900)
      },
      {
        ...wireAccount(VISA),
        availableFunds: g.money(1000, 8000),
        totalPendingAmount: null,
        balance: visa,
        openDate: g.dayString(900)
      },
      {
        ...wireAccount(MORTGAGE),
        availableFunds: null,
        totalPendingAmount: null,
        balance: mortgage,
        openDate: g.dayString(900)
      }
    ],
    meta: {
      categories: [
        { id: 'DEPOSIT', balanceTotal: { amount: chequing, cadAmount: chequing } },
        { id: 'NON_REGISTERED_INVESTMENT', balanceTotal: null },
        { id: 'REGISTERED_INVESTMENT', balanceTotal: null },
        { id: 'CREDIT', balanceTotal: { amount: visa + mortgage, cadAmount: visa + mortgage } }
      ]
    }
  }
}

// The ledger renders from one snapshot (the monthly-flow chart reads it), so it needs enough spread to look like
// a real year rather than a handful of days.
export const sampleCibcTransactions = (g: SampleGen, config: SampleConfig): RawTransaction[] =>
  [CHEQUING, VISA].flatMap((account) =>
    g.repeat(config.days * 2, (i): RawTransaction => {
      const day = g.day(config.window).date
      const incoming = g.bool(0.3)
      const amount = incoming ? g.money(200, 2400) : g.money(5, 320)
      const description = `${g.company()} ${g.seqId('REF', i + 1, 9)}`
      const balance = g.money(200, 9000)

      return {
        key: [account.id, day, incoming ? '' : amount, incoming ? amount : '', balance, description].join('|'),
        accountId: account.id,
        account: label(account),
        day,
        description,
        debit: incoming ? null : amount,
        credit: incoming ? amount : null,
        balance,
        status: 'posted'
      }
    })
  )

export const sampleCibcStatements = (g: SampleGen, config: SampleConfig): RawStatement[] =>
  [
    { account: CHEQUING, kind: 'Generated' },
    { account: VISA, kind: 'Issued' }
  ].flatMap(({ account, kind }) =>
    g.repeat(config.documents, (i): RawStatement => {
      const start = DateTime.fromISO(`${g.monthsAgo(i).yearMonth}-01`, { zone: 'utc' })
      const to = start.endOf('month').toISODate()!
      const statementId = `${g.monthsAgo(i).ym}_${account.id}`

      return {
        key: `${account.id}:${statementId}`,
        accountId: account.id,
        account: label(account),
        statementId,
        documentId: g.id('doc'),
        from: start.toISODate()!,
        to,
        kind,
        name: `${account.kind} ${account.number.slice(-4)} ${to}`
      }
    })
  )

export const sampleCibcMortgages = (g: SampleGen, config: SampleConfig): RawMortgage[] => {
  const payment = g.money(700, 1900)
  // Split each payment the way an early-amortization mortgage does — mostly interest, a minority principal.
  const principal = Math.round(payment * g.float(0.3, 0.45) * 100) / 100
  const interest = Math.round((payment - principal) * 100) / 100
  const nextPayment = DateTime.fromISO(`${g.monthsAgo(-1).yearMonth}-04`, { zone: 'utc' }).toISODate()!

  return [
    {
      accountId: MORTGAGE.id,
      account: label(MORTGAGE),
      details: {
        balance: { amount: g.money(90_000, 340_000) },
        interestRate: g.float(2.4, 6.2),
        interestRateType: 'FIXED',
        paymentAmount: { amount: payment },
        paymentFrequency: 'MONTHLY',
        nextPaymentDate: nextPayment,
        maturityDate: DateTime.fromISO(nextPayment, { zone: 'utc' }).plus({ years: 3 }).toISODate()!,
        asOfDate: g.dayString(10),
        remainingAmortizationYears: g.int(12, 28),
        remainingAmortizationMonths: g.int(0, 11),
        remainingPrepaymentPrivilegeAmount: { amount: g.money(4000, 32_000) },
        summaries: g.repeat(2, (i) => ({
          year: Number(g.monthsAgo((i + 1) * 12).yearMonth.slice(0, 4)),
          annualStatement: {
            principalPaid: { amount: g.money(1500, 5000) },
            extraPrincipalPaid: { amount: g.money(0, 2000) },
            interestPaid: { amount: g.money(2500, 11_000) },
            taxPaid: { amount: 0 },
            insurancePaid: { amount: 0 }
          }
        }))
      },
      payments: g.repeat(config.documents, (i) => ({
        paymentDate: `${g.monthsAgo(i).yearMonth}-04T00:00:00-04:00`,
        principal: { amount: principal.toFixed(2), cadAmount: principal },
        interest: { amount: interest.toFixed(2), cadAmount: interest },
        tax: null,
        insurance: null,
        totalAmount: { amount: payment.toFixed(2), cadAmount: payment }
      }))
    }
  ]
}
