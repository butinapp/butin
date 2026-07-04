// Synthetic sample GENERATORS for the demo seed — each builds a raw PostHog payload purely from the seeded
// synthetic toolkit (no literal data), and `pnpm seed-demo` draws it through the SAME `build` the live
// collector uses. `documents` caps the invoice/breakdown counts; `users` drives the member roster.

import type { RawStripeInvoiceList } from '@butinapp/sdk/integrations'
import type { SampleConfig, SampleGen } from '@butinapp/sdk/testing'

import type { PosthogBillingRaw, PosthogUsageRaw, RawBilling, RawBreakdowns, RawMembersList } from './main.js'

// A trailing daily date axis (newest last) shared by the spend + usage breakdowns.
const dateAxis = (g: SampleGen, n: number): string[] => g.repeat(n, (i) => g.dayString(n - i))

// A per-product daily breakdown over a shared axis: one numeric series per product, trending up.
const breakdown = (dates: string[], series: Array<{ label: string; base: number; step: number }>): RawBreakdowns => ({
  results: series.map((s, id) => ({
    id,
    label: s.label,
    dates,
    data: dates.map((_, i) => s.base + i * s.step)
  }))
})

// PostHog billing payload — `*_usd` fields are USD dollar STRINGS, not cents.
const sampleBilling = (g: SampleGen): RawBilling => {
  const analytics = g.moneyStr(200, 320)
  const replay = g.moneyStr(120, 220)
  const total = (Number(analytics) + Number(replay)).toFixed(2)
  const owner = g.person(0)

  return {
    billing_plan: 'scale',
    subscription_level: 'paid',
    has_active_subscription: true,
    is_annual_plan_customer: false,
    billing_period: {
      current_period_start: g.dayString(20),
      current_period_end: g.dayString(-10),
      interval: 'month'
    },
    current_total_amount_usd: total,
    current_total_amount_usd_after_discount: total,
    projected_total_amount_usd: (Number(total) * 2.7).toFixed(2),
    projected_total_amount_usd_after_discount: (Number(total) * 2.7).toFixed(2),
    discount_percent: null,
    discount_amount_usd: null,
    products: [
      {
        type: 'product_analytics',
        name: 'Product analytics',
        subscribed: true,
        current_amount_usd: analytics,
        projected_amount_usd: (Number(analytics) * 2.8).toFixed(2),
        current_usage: g.int(10_000_000, 22_000_000),
        usage_limit: null,
        projected_usage: g.int(40_000_000, 60_000_000),
        percentage_usage: 0,
        has_exceeded_limit: false,
        unit: 'event'
      },
      {
        type: 'session_replay',
        name: 'Session replay',
        subscribed: true,
        current_amount_usd: replay,
        projected_amount_usd: (Number(replay) * 2.6).toFixed(2),
        current_usage: g.int(50_000, 120_000),
        usage_limit: 250_000,
        projected_usage: g.int(180_000, 245_000),
        percentage_usage: g.int(20, 50),
        has_exceeded_limit: false,
        unit: 'recording'
      }
    ],
    account_owner: { name: owner.name, email: owner.email },
    stripe_portal_url: 'https://us.posthog.com/api/billing/portal'
  }
}

// Stripe-portal invoice history — money in CENTS, timestamps in unix seconds (newest first by date).
const sampleStripeInvoices = (g: SampleGen, config: SampleConfig): RawStripeInvoiceList => ({
  has_more: false,
  data: g.repeat(Math.min(config.documents, 36), (i) => ({
    amount_due: g.amountCents(35_000, 45_000),
    status: 'paid',
    finalized_at: g.monthsAgo(i).startEpochSec,
    hosted_invoice_url: g.url('i', g.id('inv'))
  }))
})

export const samplePosthogBilling = (g: SampleGen, config: SampleConfig): PosthogBillingRaw => {
  const dates = dateAxis(g, config.days)

  return {
    billing: sampleBilling(g),
    spend: breakdown(dates, [
      { label: 'Product analytics', base: g.int(12, 18), step: 2 },
      { label: 'Session replay', base: g.int(7, 11), step: 1 }
    ]),
    stripeInvoices: sampleStripeInvoices(g, config)
  }
}

export const samplePosthogUsage = (g: SampleGen, config: SampleConfig): PosthogUsageRaw => {
  const dates = dateAxis(g, config.days)

  return {
    billing: sampleBilling(g),
    usage: breakdown(dates, [
      { label: 'Product analytics', base: g.int(1_000_000, 1_400_000), step: 90_000 },
      { label: 'Session replay', base: g.int(4_500, 6_000), step: 320 }
    ])
  }
}

export const samplePosthogMembers = (g: SampleGen, config: SampleConfig): RawMembersList => {
  const levels = [15, 8, 1]

  return {
    results: g.people(config.users).map((p, i) => ({
      level: levels[i] ?? 1,
      user: { uuid: p.id, first_name: p.firstName, last_name: p.lastName, email: p.email }
    }))
  }
}
