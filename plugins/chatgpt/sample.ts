// Synthetic sample GENERATORS for the demo seed — each builds a raw service payload purely from the seeded
// synthetic toolkit (no literal data), and `pnpm seed-demo` draws it through the SAME `build` the live collector
// uses. The `documents` knob caps the invoice history; `users` drives the seat roster + Codex leaderboard size.
// Money in the billing bundle is MINOR units (cents) on invoices and USD-dollar STRINGS on credit grants,
// matching the wire; the build normalizes cents→major. `created` is epoch SECONDS.

import type { SampleConfig, SampleGen } from '@butinapp/sdk/testing'

import type { RawChatgptBilling, RawChatgptUsage, RawWorkspaceBundle, WorkspaceMember } from './main.js'

// A recurring seat-cycle charge each month so the Summary monthly chart and the Billing invoice history both
// populate; the most recent charge is what currentMtd reports.
const sampleInvoices = (g: SampleGen, count: number): NonNullable<RawWorkspaceBundle['invoices']['data']> =>
  g.repeat(count, (i) => ({
    id: g.id('in'),
    number: g.seqId('EX-', count - i),
    created: g.monthsAgo(i).startEpochSec,
    total: g.amountCents(900, 1_400), // cents
    currency: 'usd',
    status: 'paid',
    billing_reason: 'subscription_cycle',
    hosted_invoice_url: g.url('inv', g.id('h')),
    invoice_pdf: `https://example.invalid/inv/${g.id('p')}.pdf`
  }))

export const sampleChatgptBilling = (g: SampleGen, config: SampleConfig): RawChatgptBilling => {
  const company = g.company()
  const seatsEntitled = g.int(40, 100)
  const seatsInUse = g.int(20, seatsEntitled)
  const addr = g.address()
  const workspace: RawWorkspaceBundle = {
    accountId: g.id('acc'),
    name: `${company} Workspace`,
    planType: 'team',
    subscription: {
      plan_type: 'team',
      seats_in_use: seatsInUse,
      seats_entitled: seatsEntitled,
      billing_period: 'monthly',
      active_until: g.pastDate(-20),
      will_renew: true,
      billing_currency: 'USD',
      is_delinquent: false
    },
    seatTypeCounts: { seat_type_counts: { default: seatsInUse - 6, usage_based: 6 } },
    paymentMethods: {
      payment_methods: [
        {
          id: 'pm_default',
          type: 'card',
          card: { brand: g.pick(['visa', 'mastercard', 'amex']), last4: g.last4(), exp_month: 5, exp_year: 2028 }
        }
      ],
      default_payment_method_id: 'pm_default'
    },
    billingInfo: {
      name: `${company}, Inc.`,
      address: {
        line1: addr,
        line2: 'Suite 200',
        city: 'Springfield',
        state: 'IL',
        postal_code: '62701',
        country: 'US'
      }
    },
    remainingBalance: {
      balance: g.moneyStr(5_000, 15_000),
      expiring_balance_details: [
        {
          amount_granted: String(g.int(15_000, 30_000)),
          amount_remaining: g.moneyStr(5_000, 15_000),
          expiry_date: g.pastDate(-360),
          grant_type: 'auto_recharge_credit'
        }
      ]
    },
    invoices: { data: sampleInvoices(g, Math.min(config.documents, 36)) }
  }

  return { bundles: [workspace], capturedAt: g.pastDate(0) }
}

// The full workspace seat roster — Members renders it directly; Usage joins the Codex leaderboard onto it by id.
export const sampleChatgptMembers = (g: SampleGen, config: SampleConfig): WorkspaceMember[] =>
  g.people(config.users).map((p) => ({
    userId: p.id,
    seatType: g.pick(['default', 'usage_based']),
    email: p.email,
    name: p.name
  }))

// The Codex leaderboard joined onto the same roster: `value` is the rolling-window token total (cumulative),
// `credits_used` converts to USD at $0.04/credit. Rows are derived from the shared synthetic cast so the join
// onto the roster lands, costliest first.
export const sampleChatgptUsage = (g: SampleGen, config: SampleConfig): RawChatgptUsage => {
  const roster = sampleChatgptMembers(g, config)

  return {
    leaderboard: {
      metric: 'tokens_used',
      window: '1m',
      rows: roster.map((m, i) => ({
        user_id: m.userId,
        display_name: m.name ?? undefined,
        value: g.int(400_000_000, 3_000_000_000),
        credits_used: g.int(900, 7_000),
        lines_of_code: g.int(9_000, 75_000),
        streak: g.int(1, 12),
        rank: i + 1
      }))
    },
    freshness: {
      min_timestamp_across_data_source: g.pastDate(0),
      generated_at: g.pastDate(0)
    },
    roster,
    capturedAt: g.pastDate(0),
    window: '1m'
  }
}
