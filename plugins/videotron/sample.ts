// Synthetic sample GENERATORS for the demo seed — built purely from the seeded synthetic toolkit: a fabricated
// CAD billing account, cast-backed account holder, synthetic addresses + account numbers. `documents` caps the
// statement/link counts. Dates the wire sends as epoch-ms stay epoch-ms.

import type { SampleConfig, SampleGen } from '@butinapp/sdk/testing'

import type {
  BillingDetailRaw,
  BillingRaw,
  LegacyInvoiceLink,
  MobileBundle,
  RawInvoiceInfo,
  RawPlanAccount
} from './main.js'

const BILLING_ACCOUNT_ID = '800000000000'

// Statement N months back, the 6th of the month (the wire's epoch-ms unit).
const monthEpochMs = (monthsAgo: number): number => Date.UTC(2026, 5 - monthsAgo, 6)

const buildInvoices = (g: SampleGen, config: SampleConfig): RawInvoiceInfo[] =>
  g.repeat(Math.min(config.documents, 36), (i) => {
    const amount = g.money(70, 120)

    return {
      invoiceNumber: String(12 - i),
      invoiceDate: monthEpochMs(i),
      dueDate: monthEpochMs(i - 1),
      dueAmount: amount,
      openAmount: i === 0 ? amount : 0,
      totalPayableAmount: amount,
      isoCurrencyCode: 'CAD',
      docIdFr: `DOC-${12 - i}`
    }
  })

export const sampleVidetronBilling = (g: SampleGen, config: SampleConfig): BillingRaw => {
  const invoices = buildInvoices(g, config)
  const latest = invoices[0]?.totalPayableAmount ?? 0

  return {
    bundle: {
      financial: {
        currentBalance: latest,
        lastInvoiceAmount: latest,
        monthlyPayment: 0,
        paymentDueDate: Date.UTC(2026, 5, 21),
        recentCreditRating: 'Good'
      },
      invoices
    },
    billingAccountId: BILLING_ACCOUNT_ID
  }
}

export const sampleVidetronMobile = (g: SampleGen): MobileBundle => {
  const person = g.person(0)
  const amount = g.money(50, 90)

  return {
    last: {
      invoiceDate: g.dayString(20),
      amount,
      balance: amount,
      payment: amount,
      dueDate: g.dayString(0),
      availableOnline: true
    },
    dashboard: {
      payment: { data: { automaticWithdrawal: true } },
      account: {
        data: {
          startDate: g.dayString(30),
          endDate: g.dayString(0),
          nbDaysLeftInPeriod: g.int(1, 30),
          services: ['Mobile']
        }
      },
      billing: { data: { balance: amount, dueDate: g.dayString(0) } }
    },
    user: {
      accountNumber: String(g.int(400_000_000, 499_999_999)),
      firstname: person.firstName,
      lastname: person.lastName
    }
  }
}

export const sampleVidetronAccounts = (g: SampleGen): RawPlanAccount[] => {
  const addr = g.address()

  return [
    {
      customerBillingAccount: { acctNo: '800000000001', statusName: 'Active', invoiceAccountId: 800_000_000_000 },
      serviceAddress: { addrDesc: addr },
      familyCategoryShortCode: 'INTERNET'
    },
    {
      customerBillingAccount: { acctNo: '800000000002', statusName: 'Active', invoiceAccountId: 800_000_000_000 },
      serviceAddress: { addrDesc: addr },
      familyCategoryShortCode: 'TV'
    },
    {
      customerBillingAccount: { acctNo: '800000000003', statusName: 'Active', invoiceAccountId: 800_000_000_000 },
      familyCategoryShortCode: 'MOBILE'
    },
    { customerBillingAccount: { acctNo: '800000000000', statusName: 'Active', invoiceAccountId: 800_000_000_000 } }
  ]
}

export const sampleVidetronBillingDetail = (g: SampleGen, config: SampleConfig): BillingDetailRaw => ({
  billing: sampleVidetronBilling(g, config),
  mobileLinks: g.repeat(
    Math.min(config.documents, 36),
    (i): LegacyInvoiceLink => ({
      date: `${g.monthsAgo(i).yearMonth}-06`,
      dateFacturation: String(monthEpochMs(i)),
      medium: 'FA',
      resourceVersion: i < 3 ? 'R20240510' : 'R20180516',
      amount: g.money(50, 70)
    })
  )
})
