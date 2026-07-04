// Synthetic sample GENERATORS for the demo seed — each builds a raw service payload purely from the seeded
// synthetic toolkit (no literal data), and `pnpm seed-demo` draws it through the SAME `build` the live
// collector uses. The `documents`/`users`/`days` knobs scale the invoice/usage/member counts.

import type { SampleConfig, SampleGen } from '@butinapp/sdk/testing'

import type { RawHookdeckBilling, RawHookdeckMember, RawHookdeckUsage } from './main.js'

// Invoice amounts are CENTS (Orb). The newest invoice sits in the most recent month so the Summary's
// spend.mtd headline is exercised; the subscription's per-price unit_amount is an Orb dollar string.
export const sampleHookdeckBilling = (g: SampleGen, config: SampleConfig): RawHookdeckBilling => {
  const months = Math.max(1, Math.min(config.documents, 36))
  const org = g.company()
  const person = g.person()

  return {
    invoices: g.repeat(months, (i) => ({
      id: g.id('INV'),
      is_paid: true,
      amount_due: g.amountCents(50, 80),
      issue_date: `${g.monthsAgo(i).yearMonth}-01T00:06:13+00:00`,
      pdf_url: `https://example.invalid/invoice/${g.id('inv')}.pdf`
    })),
    subscription: {
      status: 'active',
      name: 'Team',
      current_billing_period_start_date: `${g.dayString(30)}T00:00:00+00:00`,
      current_billing_period_end_date: `${g.dayString(0)}T00:00:00+00:00`,
      billing_cycle_day: 1,
      customer: {
        name: org,
        email: person.email,
        currency: 'USD',
        portal_url: g.url('portal', g.id('cus'))
      },
      plan: { name: 'Team', external_plan_id: 'growth' },
      price_intervals: [
        { end_date: null, price: { item: { name: 'Plan' }, unit_config: { unit_amount: '39.00' } } },
        { end_date: null, price: { item: { name: 'Events' }, unit_config: null } }
      ]
    },
    card: {
      brand: 'visa',
      display_brand: 'visa',
      last4: g.last4(),
      exp_month: g.int(1, 12),
      exp_year: 2029,
      funding: 'credit',
      country: g.pick(['CA', 'US', 'GB'])
    },
    email: { email: g.person().email },
    address: { billing_address: { name: org }, tax_id: g.id('tax') }
  }
}

// Two billable metrics, each a daily count series; quantities are plain counts.
export const sampleHookdeckUsage = (g: SampleGen, config: SampleConfig): RawHookdeckUsage => {
  const days = Math.max(1, Math.min(config.days, 60))
  const usageDays = (min: number, max: number) =>
    g.repeat(days, (i) => ({
      quantity: g.int(min, max),
      timeframe_start: `${g.dayString(days - i)}T00:00:00+00:00`,
      timeframe_end: `${g.dayString(days - i - 1)}T00:00:00+00:00`
    }))

  return {
    usage: {
      data: [
        {
          billable_metric: { id: g.id('metric'), name: 'Events' },
          usage: usageDays(1_200, 2_000),
          view_mode: 'periodic'
        },
        {
          billable_metric: { id: g.id('metric'), name: 'Discarded Requests' },
          usage: usageDays(2, 30),
          view_mode: 'periodic'
        }
      ]
    },
    periodStart: g.dayString(30),
    periodEnd: g.dayString(0)
  }
}

// The roster is a bare array; the person's name/email arrive under user_* keys, the membership id is an omem_…
// string. A seatless row (no email) would be dropped by the build.
export const sampleHookdeckMembers = (g: SampleGen, config: SampleConfig): RawHookdeckMember[] =>
  g.people(config.users).map((p, i) => ({
    id: g.id('omem'),
    user_id: p.id,
    role: i === 0 ? 'owner' : i === 1 ? 'admin' : 'member',
    user_name: p.name,
    user_email: p.email
  }))
