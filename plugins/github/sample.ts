// Synthetic sample GENERATOR for the demo seed — a raw billing bundle built purely from the seeded toolkit (no literal
// account data), drawn by `pnpm seed-demo` through the SAME `build` the live collector uses. Amounts are dollars, as
// GitHub sends them. `documents` scales the payment history.

import type { SampleConfig, SampleGen } from '@butinapp/sdk/testing'
import { round2 } from '@butinapp/sdk/util'

import type { GithubBillingRaw } from './main.js'

export const sampleGithubBilling = (g: SampleGen, config: SampleConfig): GithubBillingRaw => {
  const method = `${g.pick(['Visa', 'MasterCard', 'American Express'])} ending in ${g.last4()}`
  const gross = g.money(5, 120)

  return {
    app: {
      customer: {
        customerId: g.int(1_000_000, 9_999_999),
        plan: g.pick(['pro', 'free']),
        planDuration: 'month',
        planPrice: 4
      }
    },
    payments: g.repeat(Math.min(config.documents, 24), (i) => {
      const id = g.id('TX').toUpperCase()

      return {
        date: `${g.monthsAgo(i).yearMonth}-14`,
        id,
        method,
        amount: g.money(4, 150),
        status: 'Success',
        receiptUrl: `https://example.invalid/account/receipt/${id}`,
        invoiceUrl: `https://example.invalid/billing/invoices/download?transaction_id=${id}`
      }
    }),
    usageTotal: { usage: { billableAmount: gross } },
    discounts: { discounts: [{ currentAmount: round2(gross * 0.6) }, { currentAmount: 0 }] }
  }
}
