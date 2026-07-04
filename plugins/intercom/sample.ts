// Synthetic sample GENERATORS for the demo seed — each builds a raw service payload purely from the seeded
// synthetic toolkit (no literal data), and `pnpm seed-demo` draws it through the SAME `build` the live
// collector uses. `documents` caps the invoice history + the daily-usage window; `users` drives the seat
// counts + the teammate roster.

import type { SampleConfig, SampleGen } from '@butinapp/sdk/testing'

import type {
  RawIntercomAdminList,
  RawIntercomBillingBundle,
  RawIntercomUsageBundle,
  RawSubscriptionDetails
} from './main.js'

export const sampleIntercomBilling = (g: SampleGen, config: SampleConfig): RawIntercomBillingBundle => {
  const n = Math.min(config.documents, 36)
  const seats = config.users
  const seatTotal = g.amountCents(40_000, 70_000)
  const usageTotal = g.amountCents(10_000, 25_000)
  const subtotal = seatTotal + usageTotal
  const discountPct = g.pick([0, 10, 15])
  const discount = Math.round((subtotal * discountPct) / 100)
  const total = subtotal - discount

  const subscription: RawSubscriptionDetails = {
    next_payment_date: g.pastDate(0),
    current_period_start: g.pastDate(30),
    current_period_end: g.pastDate(0),
    cadence: 'monthly',
    subtotal_amount: subtotal,
    total_amount: total,
    total_discount_amount: discount,
    total_discount_percentage: discountPct,
    customer_type: 'self-serve',
    intercom_account_credit: 0,
    products: [
      {
        type: 'core',
        id: 'advanced',
        total_amount: seatTotal,
        items: [
          {
            product_name: 'Advanced',
            items: [
              {
                id: 'full_seats',
                quantity: seats,
                total_amount: seatTotal,
                pricing_metric: 'core_seat_count',
                nickname: 'Full seats'
              }
            ]
          }
        ]
      },
      {
        type: 'usage_based',
        total_amount: usageTotal,
        items: [
          {
            product_name: 'Resolutions',
            items: [
              {
                id: 'resolutions',
                quantity: g.int(100, 400),
                total_amount: usageTotal,
                pricing_metric: 'resolutions_metered',
                nickname: 'Resolutions'
              }
            ]
          }
        ]
      }
    ]
  }

  return {
    // Finalized monthly invoices, money in CENTS, ramping with a small per-month walk.
    invoices: g.repeat(n, (i) => ({
      object: 'invoice' as const,
      id: g.id('in'),
      number: g.seqId('SAMP-', n - i, 5),
      total: total + g.amountCents(0, 4_000),
      amount_due: total,
      created: g.monthsAgo(i).startEpochSec,
      currency: 'usd',
      status: 'paid',
      hosted_invoice_url: g.url('invoices', g.id('hi')),
      invoice_pdf: `https://example.invalid/invoices/${g.id('pdf')}/pdf`
    })),
    subscription,
    current: {
      invoice_date: g.pastDate(0),
      current_period_start: g.pastDate(30),
      current_period_end: g.pastDate(0),
      subtotal_amount: subtotal,
      total_amount: total,
      amount_due: total,
      amount_paid: 0,
      total_discount_amount: discount,
      is_renewal_month: false
    },
    app: { cadence: 'monthly', customer_type: 'self-serve', in_trial: false, seat_based: true }
  }
}

export const sampleIntercomUsage = (g: SampleGen, config: SampleConfig): RawIntercomUsageBundle => {
  const seats = config.users
  const days = config.days

  return {
    usage: {
      contract: {
        billing_cycle_end_date: g.dayString(0),
        prepaid_usage: {
          core_seat_count: seats,
          resolutions_metered: g.int(200, 400),
          emails_sent: g.int(4_000, 8_000)
        },
        total_usage: {
          core_seat_count: seats,
          latest_daily_admin_count: Math.max(1, seats - 1),
          resolutions_metered: g.int(150, 300),
          emails_sent: g.int(2_000, 5_000),
          messages_sent: g.int(1_000, 3_000)
        }
      },
      // A trailing daily series — seats hold steady, conversation/resolution volume walks up.
      usage_statistics: g.repeat(days, (i) => ({
        created_at: g.dayString(days - i),
        core_seat_count: seats,
        latest_daily_admin_count: Math.max(1, seats - 1 - (i % 3)),
        resolutions: 4 + i,
        conversations: 18 + i * 2,
        messages_sent: 50 + i * 6,
        emails_sent: 90 + i * 4
      }))
    },
    metrics: [
      { metric_key: 'core_seat_count', metric_nickname: 'Full seats' },
      { metric_key: 'resolutions_metered', metric_nickname: 'Resolutions', usage_category: 'fin' },
      { metric_key: 'emails_sent', metric_nickname: 'Emails sent' },
      { metric_key: 'messages_sent', metric_nickname: 'Messages sent' }
    ]
  }
}

export const sampleIntercomAdmins = (g: SampleGen, config: SampleConfig): RawIntercomAdminList => ({
  admins: [
    ...g.people(config.users).map((p, i) => ({ id: 1000 + i + 1, email: p.email, name: p.name })),
    // Interleaved non-humans the build drops: a team entity, the operator bot, and a seatless placeholder.
    { id: 2001, email: g.person().email, name: 'Support Team', is_team: true },
    { id: 2002, email: g.person().email, name: 'Operator', is_operator: true },
    { id: 0, name: 'Unassigned' }
  ]
})
