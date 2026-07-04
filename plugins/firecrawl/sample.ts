// Synthetic sample GENERATORS for the demo seed — each builds a raw service payload purely from the seeded
// synthetic toolkit (no literal data), and `pnpm seed-demo` draws it through the SAME `build` the live collector
// uses, so the demo renders exactly what a real fetch would. `documents` scales the invoice history; `users`
// scales the API-key list.

import type { SampleConfig, SampleGen } from '@butinapp/sdk/testing'

import type { RawFirecrawlInvoice, RawFirecrawlTeam } from './main.js'

// Stripe-shaped invoices: money in CENTS, `created` in unix seconds. A spread of months (newest first) gives
// the monthly-spend chart something to draw; the build derives plan + payment method off the newest one.
export const sampleFirecrawlInvoices = (g: SampleGen, config: SampleConfig): RawFirecrawlInvoice[] => {
  const total = g.amountCents(4_900, 19_900)
  const card = { brand: g.pick(['visa', 'mastercard', 'amex']), last4: g.last4() }
  const prefix = g.orgSlug().toUpperCase()

  return g.repeat(Math.min(config.documents, 36), (i) => ({
    id: `in_${g.id('')}`,
    created: g.monthsAgo(i).startEpochSec,
    total,
    amount_due: total,
    amount_paid: total,
    status: 'paid',
    billing_reason: i === 0 ? 'subscription_create' : 'subscription_cycle',
    number: `${prefix}001-${String(g.int(1_000, 9_999)).padStart(4, '0')}`,
    currency: 'usd',
    hosted_invoice_url: g.url('invoices', i),
    invoice_pdf: `https://example.invalid/invoices/${i}/pdf`,
    charge: { payment_method_details: { type: 'card', card } },
    lines: { data: [{ description: 'Standard', amount: total, plan: { nickname: 'Standard Monthly' } }] }
  }))
}

export const sampleFirecrawlTeam = (g: SampleGen, config: SampleConfig): RawFirecrawlTeam => {
  const keys = g.repeat(Math.min(config.users, 6), (i) => ({
    id: g.int(1_000, 9_999_999),
    name: g.pick(['production', 'staging', 'ci', 'development', 'Default']),
    key: `fc-${g.id('')}${g.id('')}`
  }))

  return {
    teamId: g.id('team'),
    apiKey: keys[0]?.key ?? `fc-${g.id('')}`,
    apiKeys: keys
  }
}
