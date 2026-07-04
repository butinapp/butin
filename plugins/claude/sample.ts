// Synthetic sample GENERATORS for the demo seed — each builds a raw service payload purely from the seeded
// synthetic toolkit (no literal data), and `pnpm seed-demo` draws it through the SAME `build` the live collector
// uses. `documents` caps the invoice history; `users` drives the member roster + usage rankings; `days` the
// usage time-series length. Money in the billing bundle is MINOR units (cents), matching the wire; the build
// normalizes cents→major. created_ts is epoch SECONDS.

import type { SampleConfig, SampleGen } from '@butinapp/sdk/testing'

import type { ClaudeBillingRaw, RawAnalyticsBundle, RawMembersList } from './main.js'

// One recurring seats charge (num_seats set) + one metered usage charge (above the usage threshold) per month.
const sampleInvoices = (g: SampleGen, months: number, seats: number): ClaudeBillingRaw['bundle']['invoices'] =>
  g
    .repeat(months, (i) => {
      const ts = Math.floor(Date.parse(`${g.monthsAgo(i).yearMonth}-01T08:00:00Z`) / 1000)

      return [
        {
          total: g.amountCents(450_000, 600_000),
          currency: 'cad',
          status: 'paid',
          created_ts: ts,
          num_seats: seats,
          invoice_pdf_url: `https://example.invalid/inv/${g.id('s')}.pdf`,
          hosted_invoice_url: null
        },
        {
          total: g.amountCents(70_000, 180_000),
          currency: 'cad',
          status: 'paid',
          created_ts: ts + 3600,
          num_seats: null,
          invoice_pdf_url: `https://example.invalid/inv/${g.id('u')}.pdf`,
          hosted_invoice_url: null
        }
      ]
    })
    .flat()

export const sampleClaudeBilling = (g: SampleGen, config: SampleConfig): ClaudeBillingRaw => {
  const seats = g.int(40, 90)
  const standardSeats = Math.floor(seats * 0.7)
  const premiumSeats = seats - standardSeats

  return {
    capturedAt: g.pastDate(0),
    bundle: {
      invoices: sampleInvoices(g, Math.min(config.documents, 36), seats),
      upcoming: {
        invoice: {
          total: g.amountCents(500_000, 600_000),
          currency: 'cad',
          lines: [
            { total: g.amountCents(150_000, 200_000), num_seats: standardSeats, description: 'Standard seats' },
            { total: g.amountCents(300_000, 400_000), num_seats: premiumSeats, description: 'Premium seats' }
          ]
        }
      },
      overage: {
        is_enabled: true,
        monthly_credit_limit: 2_000_000,
        used_credits: g.amountCents(800_000, 1_400_000),
        currency: 'cad'
      },
      prepaid: {
        amount: g.amountCents(40_000, 80_000),
        currency: 'cad',
        auto_reload_settings: { enabled: true, threshold_in_minor_units: 10_000, reload_to_in_minor_units: 510_000 }
      },
      balance: { balance: 0, currency: 'cad' },
      subscription: { next_charge_date: g.dayString(0), currency: 'cad' }
    }
  }
}

const sampleDailySpend = (g: SampleGen, days: number, min: number, max: number) =>
  g.repeat(days, (i) => ({ date: g.dayString(days - 1 - i), value: g.float(min, max) }))

export const sampleClaudeAnalytics = (g: SampleGen, config: SampleConfig): RawAnalyticsBundle => {
  const roster = g.people(config.users)
  const standard = Math.ceil(roster.length * 0.6)
  const days = config.days

  return {
    counts: {
      total: roster.length,
      by_seat_tier: { team_standard: standard, team_tier_1: roster.length - standard },
      pending_invites_total: g.int(0, 3)
    },
    limit: { seat_tier_quantities: { team_standard: standard + 1, team_tier_1: roster.length - standard + 1 } },
    subscription: { status: 'active', currency: 'USD', next_charge_date: g.dayString(0) },
    rankings: {
      users: roster.map((p, i) => ({
        account_uuid: p.id,
        email_address: p.email,
        seat_tier: i < standard ? 'team_standard' : 'team_tier_1',
        value: g.float(10, 280)
      }))
    },
    spendTs: { currency: 'USD', data_points: sampleDailySpend(g, days, 30, 60) },
    spendByModel: {
      models: [
        { model_family: 'Opus', data_points: sampleDailySpend(g, days, 15, 30) },
        { model_family: 'Sonnet', data_points: sampleDailySpend(g, days, 10, 20) },
        { model_family: 'Haiku', data_points: sampleDailySpend(g, days, 2, 6) }
      ]
    },
    // claude.ai reports utilization/stickiness as whole-number percents (72 = 72%), normalized in build.
    activity: {
      dau: { value: g.int(2, roster.length) },
      wau: { value: roster.length },
      mau: { value: roster.length },
      utilization: { value: g.int(50, 90) },
      stickiness: g.int(40, 70)
    }
  }
}

export const sampleClaudeMembers = (g: SampleGen, config: SampleConfig): RawMembersList => ({
  members: g.people(config.users).map((p) => ({
    account: { uuid: p.id, email_address: p.email, full_name: p.name },
    role: g.pick(['admin', 'member', 'developer', 'billing'])
  }))
})
