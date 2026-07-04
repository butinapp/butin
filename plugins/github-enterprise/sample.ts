// Synthetic sample GENERATORS for the demo seed — each builds a raw service payload purely from the seeded
// synthetic toolkit (no literal data), and `pnpm seed-demo` draws it through the SAME `build` the live collector
// uses, so the demo renders exactly what a real fetch would. GitHub amounts are DOLLARS already (no cents
// conversion). `documents` scales the payment history; `days` the per-day usage; `users` the seat counts.

import type { SampleConfig, SampleGen } from '@butinapp/sdk/testing'

import type { BuildBillingArgs, GitHubPayment } from './billing.js'
import type { GithubUsageRaw } from './usage.js'

// Successful charges (newest first) feed the totals, the monthly-paid spark, and the downloadable payment-history
// table. A trailing declined row exercises the declined-vs-succeeded split.
const succeeded = (g: SampleGen, n: number, card: string): GitHubPayment[] =>
  g.repeat(n, (i) => {
    const date = `${g.monthsAgo(i).yearMonth}-01`
    const tx = `TX${String(g.int(1_000, 9_999))}`
    const amount = g.money(60, 220)

    return {
      date,
      timestamp: `${date} 09:14:0${i % 10}`,
      id: tx,
      method: card,
      amount,
      amountFormatted: `$${amount.toFixed(2)}`,
      status: 'Success',
      receiptUrl: `https://example.invalid/billing/receipt/${tx}`,
      invoiceUrl: `https://example.invalid/billing/invoices/download?transaction_id=${tx}`
    }
  })

export const sampleGithubBilling = (g: SampleGen, config: SampleConfig): BuildBillingArgs => {
  const last4 = g.last4()
  const cardType = g.pick(['MasterCard', 'Visa', 'American Express'])
  const card = `${cardType} ending in ${last4}`
  const seats = config.users
  const declinedAmount = g.money(60, 220)

  return {
    payments: [
      ...succeeded(g, Math.min(config.documents, 36), card),
      {
        date: g.dayString(120),
        timestamp: `${g.dayString(120)} 09:02:11`,
        id: `TX${String(g.int(1_000, 9_999))}`,
        method: card,
        amount: declinedAmount,
        amountFormatted: `$${declinedAmount.toFixed(2)}`,
        status: 'Declined'
      }
    ],
    totalPages: 2,
    pagesFetched: 2,
    usageTotal: { usage: { totalGrossAmount: g.money(20, 90) } },
    discounts: {
      discounts: [{ currentAmount: g.money(10, 50), name: 'Enterprise discount' }, { currentAmount: g.money(5, 30) }]
    },
    ghe: {
      billingTermEndDate: g.dayString(0),
      currentPayment: `$${g.moneyStr(60, 200)}`,
      enterpriseLicensesBillable: seats + 5,
      enterpriseLicensesConsumed: seats,
      enterpriseLicensesPurchased: seats + 5,
      isMonthly: true,
      unitCost: '$21.00/user per month',
      paymentMethod: { credit_card: true, paypal: false, last_four: last4, card_type: cardType },
      pendingCycleChange: {
        changeType: 'downgrade',
        effectiveDate: g.dayString(0),
        newPrice: `$${g.moneyStr(50, 180)}`,
        newSeatCount: Math.max(1, seats - 4),
        planDisplayName: 'Enterprise',
        planDuration: 'month'
      }
    },
    cardExpiry: `${g.int(1, 12)}/${g.int(2028, 2032)}`,
    contacts: [
      { email: g.person(0).email, primary: true },
      { email: g.person(1).email, primary: false }
    ]
  }
}

// A product's daily usage across the window. The daily usageAt timestamps drive the per-day trend.
const usageRows = (
  g: SampleGen,
  days: number,
  slug: string,
  friendly: string,
  grossPerDay: number,
  discountRatio: number
) =>
  g.repeat(days, (i) => {
    const gross = grossPerDay + i * 0.85
    const discount = Number((gross * discountRatio).toFixed(4))

    return {
      grossAmount: gross,
      netAmount: Number((gross - discount).toFixed(4)),
      discountAmount: discount,
      product: slug,
      sku: `${slug}_linux`,
      friendlySkuName: friendly,
      quantity: g.int(100, 400),
      unitType: 'Minutes',
      usageAt: `${g.dayString(days - i)}T08:00:00Z`
    }
  })

export const sampleGithubUsage = (g: SampleGen, config: SampleConfig): GithubUsageRaw => {
  const days = Math.min(config.days, 31)

  return {
    total: { usage: { totalGrossAmount: g.money(20, 90) } },
    perProduct: [
      // Actions runs a near-total enterprise discount (net ≈ 0); Copilot is billed in full; Codespaces is idle.
      {
        slug: 'actions',
        label: 'Actions',
        raw: { usage: usageRows(g, days, 'actions', 'Actions Linux', g.float(10, 20), 1) }
      },
      {
        slug: 'copilot',
        label: 'Copilot',
        raw: { usage: usageRows(g, days, 'copilot', 'Copilot Enterprise', g.float(4, 10), 0) }
      },
      { slug: 'codespaces', label: 'Codespaces', raw: { usage: [] } }
    ]
  }
}
