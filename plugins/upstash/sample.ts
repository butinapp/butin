// Synthetic sample GENERATORS for the demo seed — each builds the raw bundle a capability's `fetch` returns,
// purely from the seeded synthetic toolkit (no literal data), and `pnpm seed-demo` draws it through the SAME
// `build` the live collector uses. Money is USD dollars (no /100). The `documents`/`users` knobs scale counts.

import type { SampleConfig, SampleGen } from '@butinapp/sdk/testing'

import type { RawApiKey, UpstashBillingData, UpstashMembersData } from './main.js'

// /user + /invoices + the current month's /billingdetails, as loadUpstashBilling assembles them. Summary +
// Billing share this bundle.
export const sampleUpstashBilling = (g: SampleGen, config: SampleConfig): UpstashBillingData => {
  const n = Math.min(config.documents, 36)

  return {
    user: {
      customer_id: g.person().email,
      state: 'active',
      wallet: g.money(0, 50),
      register_date: '2024-03-01 10:00:00 +0000 UTC'
    },
    currentYm: g.monthsAgo(0).ym,
    details: {
      redis: {
        billing: g.money(8, 18),
        request: g.int(1_000_000, 1_800_000),
        storage: g.int(2, 5),
        bandwidth: g.int(4, 9)
      },
      qStash: { billing: g.money(2, 5), request: g.int(300_000, 500_000), bandwidth: g.int(1, 3) },
      vector: { billing: g.money(1, 3), request: g.int(50_000, 120_000), storage: g.int(1, 2) },
      search: { billing: g.money(0.5, 1.5), request: g.int(20_000, 60_000) }
    },
    invoices: g.repeat(n, (i) => ({
      date: g.monthsAgo(i).ym,
      cost: g.money(10, 20),
      status: i === 0 ? 'scheduled' : 'paid'
    }))
  }
}

// /listkeys — already-truncated fragments (never full secrets). Keys carry no revoked flag.
export const sampleUpstashKeys = (g: SampleGen, config: SampleConfig): RawApiKey[] =>
  g.repeat(Math.min(config.documents, 36), (i) => ({
    key_id: g.id('k'),
    name: g.pick(['production', 'ci', 'staging', 'development']),
    api_key: `${g.id('')}${g.last4()}`,
    created_at: `${g.dayString(i * 60 + 30)} 14:05:22.45 +0000 UTC`
  }))

// /v2/teams rows (one per team-membership) folded with the pinned teamId, as fetchUpstashMembers returns. The
// teamId matches a team's rows so build keeps that team's members; the email doubles as the id.
export const sampleUpstashMembers = (g: SampleGen, config: SampleConfig): UpstashMembersData => {
  const teamId = g.id('t')
  const teamName = g.company()

  return {
    teamId,
    rows: g.people(config.users).map((p, i) => ({
      team_id: teamId,
      team_name: teamName,
      member_email: p.email,
      member_role: i === 0 ? 'owner' : g.pick(['admin', 'dev']),
      copy_cc: i === 0
    }))
  }
}
