// Synthetic sample GENERATORS for the demo seed — each builds a raw control-plane RPC response purely from the
// seeded synthetic toolkit (no literal data), and `pnpm seed-demo` draws it through the SAME `build` the live
// collector uses. `documents` caps the invoice/statement history; `users` drives the org roster. Amounts are USD
// dollars (the console's own unit), dates epoch ms.

import type { SampleConfig, SampleGen } from '@butinapp/sdk/testing'
import { MS_PER_DAY } from '@butinapp/sdk/util'

import type { RawBillingDetails, RawOrg, RawUsageReport } from './main.js'

// getOrganizationBillingDetails — a history of paid invoices + bill statements (one open `locked:false` = the
// live MTD), a card, and a half-spent trial credit.
export const sampleClickhouseBilling = (g: SampleGen, config: SampleConfig): RawBillingDetails => {
  const count = Math.min(config.documents, 36)
  const now = Date.parse(g.pastDate(0))
  const granted = g.int(200, 500)
  const spent = g.int(0, granted)

  return {
    companyName: g.company(),
    billingContact: g.people(1)[0]!.email,
    nextInvoiceDate: now + 30 * MS_PER_DAY,
    paymentMethod: { brand: g.pick(['visa', 'mastercard', 'amex']), last4: g.last4(), expMonth: 12, expYear: 2028 },
    invoices: g.repeat(count, (i) => ({
      invoiceNumber: g.seqId('AC-', count - i),
      currency: 'USD',
      amount: g.money(1_000, 1_600),
      status: 'paid',
      createdDate: g.monthsAgo(i + 1).startEpochMs,
      invoicePdfDownloadLink: `https://example.invalid/invoice/${g.id('iv')}/pdf`,
      invoicePaymentLink: g.url('i', g.id('p'))
    })),
    // One statement per calendar month (newest first); the single open (locked:false) statement is the live MTD.
    billUsageStatements: g.repeat(count, (i) => ({
      billNetTotal: g.money(500, 1_400),
      periodStartDate: g.monthsAgo(i + 1).startEpochMs,
      periodEndDate: g.monthsAgo(i).startEpochMs,
      locked: i !== 0
    })),
    creditBalances: [
      { amountSpent: spent, amountRemaining: granted - spent, amountTotal: granted, creditType: 'TRIAL' }
    ]
  }
}

// getUsageReport — the open period's metered consumption (metricValue in the metric's own unit, cost in USD).
export const sampleClickhouseUsage = (g: SampleGen, _config: SampleConfig): RawUsageReport => ({
  report: {
    startDate: g.dayString(17),
    endDateInclusive: g.dayString(0),
    totalUsageReport: {
      instanceComputeUnitHours: { metricValue: g.float(800, 1_800), cost: g.money(300, 500) },
      clickpipeComputeUnitHours: { metricValue: g.float(40, 120), cost: g.money(15, 40) },
      datawarehouseStorageTBMonthsTables: { metricValue: g.float(0.4, 1.2), cost: g.money(10, 30) },
      datawarehouseStorageTBMonthsBackups: { metricValue: g.float(0.1, 0.5), cost: g.money(2, 8) },
      instancePublicDataTransferGB: { metricValue: g.float(10, 30), cost: g.money(1, 3) },
      clickpipeDataTransferGB: { metricValue: g.float(3, 10), cost: g.money(0.4, 1.2) }
    }
  }
})

// initializeUserSession's chosen org — the keyed user roster the members tab reads.
export const sampleClickhouseOrg = (g: SampleGen, config: SampleConfig): RawOrg => {
  const users: NonNullable<RawOrg['users']> = {}

  for (const [i, p] of g.people(config.users).entries()) {
    users[p.id] = { userId: p.id, name: p.name, email: p.email, role: i === 0 ? 'ADMIN' : 'DEVELOPER' }
  }

  return { id: g.id('org'), name: g.company(), tier: 'SCALE', billingStatus: 'PAID', users }
}
