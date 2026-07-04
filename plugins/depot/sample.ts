// Synthetic sample GENERATORS for the demo seed — each builds a raw bundle purely from the seeded synthetic
// toolkit (no literal data), and `pnpm seed-demo` draws it through the SAME `build` the live collector uses.
// `documents` caps the invoice history; `users` drives the member roster. Stripe money is in CENTS; usage units
// stay raw (minutes/GB).

import type { SampleConfig, SampleGen } from '@butinapp/sdk/testing'
import { MS_PER_DAY } from '@butinapp/sdk/util'

import type { RawDepotBilling, RawDepotSettings, RawDepotUsage } from './main.js'

// Usage loader → the flat current-period totals (minutes per lane + cache GB). Units stay raw (minutes/GB).
export const sampleDepotUsage = (g: SampleGen, _config: SampleConfig): RawDepotUsage => ({
  buildMinutes: g.int(4_000, 12_000),
  jobMinutes: g.int(60_000, 140_000),
  ciMinutes: g.int(1_000, 5_000),
  currentCacheUsage: g.int(80, 300),
  currentRemoteCacheSize: g.int(150, 500)
})

// Settings loader → active members + pending invites; roles derive from the owner/admin flags.
export const sampleDepotSettings = (g: SampleGen, config: SampleConfig): RawDepotSettings => {
  const roster = g.people(config.users)

  return {
    users: roster.map((p, i) => ({
      userID: p.id,
      name: p.name,
      email: p.email,
      ...(i === 0 ? { isOwner: true } : i === 1 ? { isAdmin: true } : { role: 'member' })
    })),
    invites: [{ id: g.id('inv'), email: g.people(config.users + 1).at(-1)!.email, role: 'member' }]
  }
}

// Stripe portal bundle: invoice list (amounts in CENTS, dates in unix seconds) + a subscription whose upcoming
// invoice mixes the current period's metered lines with the next period's licensed base plan.
export const sampleDepotBilling = (g: SampleGen, config: SampleConfig): RawDepotBilling => {
  const count = Math.min(config.documents, 36)
  const now = Date.parse(g.pastDate(0))
  const periodEnd = Math.floor((now + 14 * MS_PER_DAY) / 1000)
  const nextPeriodEnd = Math.floor((now + 44 * MS_PER_DAY) / 1000)
  const periodStart = g.pastEpochSec(16)
  const baseFeeCents = 20_000

  return {
    invoices: {
      has_more: false,
      data: g.repeat(count, (i) => {
        const ts = g.monthsAgo(i + 1).startEpochSec
        const metered = g.amountCents(30_000, 60_000)

        return {
          id: g.id('in'),
          number: g.seqId('INV-', count - i),
          status: 'paid',
          total: baseFeeCents + metered,
          amount_due: baseFeeCents + metered,
          amount_paid: baseFeeCents + metered,
          currency: 'usd',
          effective_at: ts,
          finalized_at: ts,
          hosted_invoice_url: g.url('i', g.id('h')),
          invoice_pdf: `https://example.invalid/i/${g.id('p')}.pdf`,
          lines: {
            data: [
              {
                amount: baseFeeCents,
                description: '1 × Startup plan (at $200.00 / month)',
                short_description: 'Startup plan'
              },
              {
                amount: metered,
                description: `${g.int(8_000, 16_000)} minute × Build Minutes`,
                short_description: 'Build Minutes'
              }
            ]
          }
        }
      })
    },
    subscriptions: {
      data: [
        {
          current_period_end: periodEnd,
          items: [
            {
              price_details: {
                unit_amount: baseFeeCents,
                recurring: { usage_type: 'licensed' },
                product: { name: 'Startup plan' }
              }
            },
            { price_details: { recurring: { usage_type: 'metered' }, product: { name: 'Build Minutes' } } }
          ],
          upcoming_invoice: {
            created: periodEnd,
            total: baseFeeCents + g.amountCents(50_000, 70_000),
            amount_due: baseFeeCents + g.amountCents(50_000, 70_000),
            lines: {
              data: [
                // next-period licensed base plan — period ends LATER, excluded from current-period metered MTD
                { amount: baseFeeCents, period: { start: periodEnd, end: nextPeriodEnd } },
                // current-period metered usage — period ends at current_period_end
                { amount: g.amountCents(20_000, 35_000), period: { start: periodStart, end: periodEnd } },
                { amount: g.amountCents(15_000, 25_000), period: { start: periodStart, end: periodEnd } },
                { amount: g.amountCents(8_000, 18_000), period: { start: periodStart, end: periodEnd } }
              ]
            }
          }
        }
      ]
    }
  }
}
