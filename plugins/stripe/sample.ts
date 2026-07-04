// Synthetic sample GENERATORS for the demo seed — each builds a raw Stripe fee-report payload purely from the
// seeded synthetic toolkit (no literal data), and `pnpm seed-demo` draws it through the SAME `build` the live
// collector uses. `documents` caps the number of complete months in the chart. Money is major-unit USD (the
// report's native unit).

import type { SampleConfig, SampleGen } from '@butinapp/sdk/testing'
import { round2 } from '@butinapp/sdk/util'

import type { StripeFee, StripeFeesSummaryRaw, StripeMonthFees } from './main.js'

const totalOf = (fees: StripeFee[]): number => round2(fees.reduce((sum, f) => sum + f.amount, 0))

// A representative month's fee lines (major-unit USD). The breakdown table sorts these largest-first; the
// largest also surfaces as Summary's "Largest fee" card.
const sampleFeeLines = (g: SampleGen): StripeFee[] => [
  {
    suite: 'Payments',
    product: 'Payment Processing',
    feature: 'Card payments - Stripe fee',
    amount: g.money(150, 500),
    currency: 'USD'
  },
  {
    suite: 'Revenue management',
    product: 'Billing',
    feature: 'Invoicing - Plus',
    amount: g.money(40, 150),
    currency: 'USD'
  },
  {
    suite: 'Reporting',
    product: 'Sigma and Data Pipeline',
    feature: 'Sigma - monthly fee',
    amount: g.money(15, 50),
    currency: 'USD'
  },
  {
    suite: 'Payments',
    product: 'Payment Processing',
    feature: 'Currency conversion fee',
    amount: g.money(5, 30),
    currency: 'USD'
  },
  {
    suite: 'Payments',
    product: 'Payment Processing',
    feature: 'Payments - refund fee',
    amount: g.money(0.1, 2),
    currency: 'USD'
  }
]

// A complete-month spec for the chart: [month-start, next-month-start) in epoch seconds + a plausible total.
const completeMonth = (g: SampleGen, monthsBack: number, total: number): StripeMonthFees => {
  const month = g.monthsAgo(monthsBack)

  return {
    key: month.yearMonth,
    label: month.label,
    startSec: month.startEpochSec,
    endSec: g.monthsAgo(monthsBack - 1).startEpochSec,
    total,
    fees: []
  }
}

// The current month-to-date: the headline + the Fees-tab breakdown source. `endSec` is the open-period
// cutoff (mid-month, "so far"), not a month boundary.
const sampleCurrentMonth = (g: SampleGen): StripeMonthFees => {
  const month = g.monthsAgo(0)
  const fees = sampleFeeLines(g)

  return {
    key: month.yearMonth,
    label: month.label,
    startSec: month.startEpochSec,
    endSec: month.startEpochSec + 17 * 86_400,
    fees,
    total: totalOf(fees)
  }
}

export const sampleStripeSummary = (g: SampleGen, config: SampleConfig): StripeFeesSummaryRaw => {
  const span = Math.min(config.documents, 36)
  const base = g.money(150, 400)

  // `span` complete months ending the month before the reference month, ramping up.
  const completeMonths = g.repeat(span, (i) => completeMonth(g, span - i, round2(base + i * 800)))

  return { completeMonths, current: sampleCurrentMonth(g) }
}

export const sampleStripeFees = (g: SampleGen): StripeMonthFees => sampleCurrentMonth(g)
