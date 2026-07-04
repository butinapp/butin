// Synthetic sample GENERATORS for the demo seed — each builds a raw Screenshot API payload purely from the
// seeded synthetic toolkit (no literal data), and `pnpm seed-demo` draws it through the SAME `build` the live
// collector uses. `documents` caps the invoice/usage-day history.

import type { SampleConfig, SampleGen } from '@butinapp/sdk/testing'

import type { RawBillingInfoResponse, RawScreenshotapiBilling, RawScreenshotapiUsage } from './main.js'

// The flat monthly fee (DOLLARS) the demo account is on — drives the invoice amounts, billing-info next-bill,
// and the subscription-history plan_amount (CENTS). Stable within a single gen so every endpoint agrees.
const monthlyFee = (g: SampleGen): number => g.pick([49, 99, 199])

// The billing-info block (quota / used / period / next bill / card) shared by the Billing + Usage payloads.
const sampleInfo = (g: SampleGen, fee: number): RawBillingInfoResponse => ({
  billingInfo: {
    subscriptionStatus: 'active',
    cardBrand: g.pick(['visa', 'mastercard', 'amex']),
    cardLastFour: g.last4(),
    cardExpMonth: g.int(1, 12),
    cardExpYear: 2030,
    currentPlan: g.id('price'),
    cancelAt: null,
    nextBillDate: g.pastDate(-17),
    nextBillingAmount: fee,
    screenshot_amount: 50_000,
    nextInvoiceUsage: g.int(20_000, 40_000),
    currentPeriodStart: g.pastDate(13),
    current_billing_period_count: g.int(20_000, 40_000)
  }
})

// Summary + Billing share this raw bundle. amounts are DOLLARS on invoices/billing-info; plan_amount is CENTS.
export const sampleScreenshotapiBilling = (g: SampleGen, config: SampleConfig): RawScreenshotapiBilling => {
  const fee = monthlyFee(g)
  const plan = g.pick(['Ramp Up Monthly', 'Scale Monthly', 'Pro Monthly'])
  const start = g.day(13).epochSec

  return {
    invoices: {
      success: true,
      invoices: g.repeat(Math.min(config.documents, 36), (i) => ({
        amount: fee,
        planName: plan,
        hostedUrl: g.url('i', g.id('inv')),
        date: `${g.monthsAgo(i).yearMonth}-01`.replace(/-/g, '/')
      })),
      legacy: false
    },
    info: sampleInfo(g, fee),
    subHistory: {
      subscriptions: [
        {
          status: 'active',
          currency: 'usd',
          current_period_start: start,
          current_period_end: start + 30 * 86_400,
          start_date: start - 360 * 86_400,
          plan_id: g.id('price'),
          plan_amount: fee * 100, // CENTS
          interval: 'month',
          interval_count: 1,
          quantity: 1,
          plan_name: plan
        }
      ]
    }
  }
}

// Usage shares billing-info (quota/used/period) + the current period's daily successful/failed counts.
export const sampleScreenshotapiUsage = (g: SampleGen, config: SampleConfig): RawScreenshotapiUsage => {
  const days = Math.min(config.days, 31)

  return {
    usage: {
      success: true,
      usage: {
        days: g.repeat(days, (i) => ({
          day: `Day ${i + 1}`,
          successful: g.int(1_000, 1_400) + i * 90,
          failed: g.int(0, 12)
        })),
        totalScreenshots: g.int(300_000, 600_000),
        totalFailed: g.int(300, 900)
      }
    },
    info: sampleInfo(g, monthlyFee(g))
  }
}
