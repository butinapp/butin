// Synthetic sample GENERATORS for the demo seed — each builds a raw Sentry payload purely from the seeded
// synthetic toolkit (no literal data), and `pnpm seed-demo` draws it through the SAME `build` the live
// collector uses. `documents` caps the invoice history; `users` drives the member roster. Money is CENTS on
// every Sentry endpoint (build normalizes to USD major units).

import type { SampleConfig, SampleGen } from '@butinapp/sdk/testing'

import type { RawMember, SentryBillingData, SentryUsageData } from './main.js'

export const sampleSentryBilling = (g: SampleGen, config: SampleConfig): SentryBillingData => {
  const fee = g.amountCents(2_500, 4_000)

  return {
    invoices: g.repeat(Math.min(config.documents, 36), (i) => ({
      id: g.id('in'),
      amountBilled: fee,
      amountRefunded: i === 2 ? g.amountCents(200, 800) : 0,
      isPaid: true,
      dateCreated: `${g.monthsAgo(i).yearMonth}-01`,
      receipt: { url: `https://example.invalid/invoices/${g.id('rcpt')}.pdf` }
    })),
    customer: { plan: 'team', planDetails: { name: 'Team' }, onDemandSpendUsed: g.amountCents(1_000, 3_000) }
  }
}

// `categories` arrives keyed by name (a dict) — build accepts both a dict and an array.
export const sampleSentryUsage = (g: SampleGen): SentryUsageData => ({
  usage: {
    totals: {
      errors: { accepted: g.int(800_000, 1_600_000) },
      transactions: { accepted: g.int(3_000_000, 6_000_000) },
      replays: { accepted: g.int(10_000, 30_000) },
      attachments: { accepted: g.int(2, 12) },
      spans: { accepted: g.int(6_000_000, 12_000_000) }
    }
  },
  history: {
    categories: {
      errors: { reserved: 5_000_000, onDemandSpendUsed: 0 },
      transactions: { reserved: 5_000_000, onDemandSpendUsed: g.amountCents(500, 2_000) },
      replays: { reserved: 50_000, onDemandSpendUsed: g.amountCents(200, 1_000) },
      attachments: { reserved: 1, onDemandSpendUsed: 0 },
      spans: { reserved: 10_000_000, onDemandSpendUsed: 0 }
    },
    periodStart: g.dayString(17),
    periodEnd: g.dayString(-13)
  }
})

// Some members carry name/email at the top level, others nested under `user` (build reads both).
export const sampleSentryMembers = (g: SampleGen, config: SampleConfig): RawMember[] => {
  const roles = ['owner', 'manager', 'member']

  return g.people(config.users).map((p, i) => {
    const role = roles[i] ?? 'member'

    return i % 2 === 0
      ? { id: p.id, email: p.email, name: p.name, role }
      : { id: p.id, role, user: { email: p.email, name: p.name } }
  })
}
