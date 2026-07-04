// Synthetic sample GENERATORS for the demo seed — each builds a raw service payload purely from the seeded
// synthetic toolkit (no literal data), drawn through the SAME `build` the live collector uses. The
// `documents`/`users` knobs scale the invoice history / roster.

import type { SampleConfig, SampleGen } from '@butinapp/sdk/testing'

import type { RawClerkMembershipList, RawNovuBilling, RawNovuUsage } from './main.js'

// Subscription mirrors api.novu.co/v1/billing/subscription: a Business plan on the current calendar month with
// a metered workflow-run allowance. Shared by the billing (plan) and usage (allowance) capabilities.
const subscription = (g: SampleGen) => ({
  data: {
    apiServiceLevel: 'business',
    isActive: true,
    status: 'active',
    hasPaymentMethod: true,
    currentPeriodStart: `${g.monthsAgo(0).yearMonth}-01T00:00:00.000Z`,
    currentPeriodEnd: `${g.monthsAgo(-1).yearMonth}-01T00:00:00.000Z`,
    billingInterval: 'month',
    events: { current: g.int(50_000, 200_000), included: 250_000 },
    trial: { isActive: false, start: null, end: null, daysTotal: 0 },
    cancelAt: null
  }
})

// Billing: one Stripe invoice per month back (amounts in CENTS), plus the subscription plan.
export const sampleNovuBilling = (g: SampleGen, config: SampleConfig): RawNovuBilling => {
  const n = Math.min(config.documents, 36)
  const base = g.amountCents(15_000, 28_000)

  return {
    invoices: {
      has_more: false,
      data: g.repeat(n, (i) => {
        const created = g.monthsAgo(i).startEpochSec
        const total = base + i * 600

        return {
          id: g.id('in'),
          number: g.seqId('NOVU-', 1001 + i),
          status: 'paid',
          total,
          amount_due: total,
          amount_paid: total,
          currency: 'usd',
          effective_at: created,
          finalized_at: created,
          created,
          invoice_pdf: `${g.url('novu/invoice', i + 1)}.pdf`,
          hosted_invoice_url: g.url('novu/i', `live_${i + 1}`),
          lines: { data: [{ amount: total, description: '1 × Business plan' }] }
        }
      })
    },
    sub: subscription(g)
  }
}

// Usage: the subscription allowance + an activity-charts slice — engagement scorecards (current/previous),
// top workflows by volume, and the daily workflow-runs + per-channel delivery trends (scaled by `days`).
export const sampleNovuUsage = (g: SampleGen, config: SampleConfig): RawNovuUsage => ({
  sub: subscription(g),
  charts: {
    data: {
      'messages-delivered': { currentPeriod: g.int(100_000, 400_000), previousPeriod: g.int(100_000, 400_000) },
      'active-subscribers': { currentPeriod: g.int(80_000, 150_000), previousPeriod: g.int(80_000, 150_000) },
      'avg-messages-per-subscriber': { currentPeriod: g.float(2, 3.5), previousPeriod: g.float(2, 3.5) },
      'total-interactions': { currentPeriod: g.int(3_000, 8_000), previousPeriod: g.int(3_000, 8_000) },
      'workflow-by-volume': [
        { workflowName: 'Quota Reached', count: g.int(100_000, 200_000) },
        { workflowName: 'Welcome Series', count: g.int(20_000, 60_000) },
        { workflowName: 'Password Reset', count: g.int(10_000, 30_000) },
        { workflowName: 'Auto-Recharge Success', count: g.int(2_000, 9_000) }
      ],
      'workflow-runs-trend': g.repeat(config.days, (i) => ({
        timestamp: g.dayString(config.days - i),
        completed: g.int(5_000, 9_000),
        error: 0
      })),
      'delivery-trend': g.repeat(config.days, (i) => ({
        timestamp: g.dayString(config.days - i),
        inApp: g.int(3_000, 6_000),
        email: g.int(2_500, 5_000),
        sms: g.int(100, 400),
        chat: 0,
        push: 0
      }))
    }
  }
})

// Members: the Clerk org roster (owner, admin, then viewers), drawn from the shared synthetic cast.
export const sampleNovuMemberships = (g: SampleGen, config: SampleConfig): RawClerkMembershipList => ({
  response: {
    data: g.people(config.users).map((p, i) => {
      const role = i === 0 ? 'org:owner' : i === 1 ? 'org:admin' : 'org:viewer'

      return {
        id: g.id('orgmem'),
        role,
        role_name: i === 0 ? 'Owner' : i === 1 ? 'Admin' : 'Viewer',
        public_user_data: { user_id: g.id('user'), identifier: p.email, first_name: p.firstName, last_name: p.lastName }
      }
    })
  }
})
