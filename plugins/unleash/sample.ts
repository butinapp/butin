// Synthetic sample GENERATORS for the demo seed — each builds the raw bundle a capability's `fetch` returns,
// purely from the seeded synthetic toolkit (no literal data), and `pnpm seed-demo` draws it through the SAME
// `build` the live collector uses. The `documents`/`users` knobs scale the invoice/token/roster counts.

import type { SampleConfig, SampleGen } from '@butinapp/sdk/testing'

import type { RawUnleashRosterResponse, RawUnleashTokensResponse, UnleashBillingRaw } from './main.js'

// Summary + Billing share the four billing endpoints, so they share one raw bundle. Pro plan with `minSeats`
// included in the base → the recurring fee is base + (seats − minSeats) × per-seat rate.
export const sampleUnleashBilling = (g: SampleGen, config: SampleConfig): UnleashBillingRaw => {
  const seats = g.int(20, 40)
  const minSeats = 5
  const n = Math.min(config.documents, 36)

  return {
    invoices: {
      invoices: g.repeat(n, (i) => {
        const paid = i > 0

        return {
          amountFormatted: `US $${g.moneyStr(60, 180)}`,
          paid,
          created: `${g.monthsAgo(i).yearMonth}-01T00:00:00.000Z`,
          status: paid ? 'paid' : 'open',
          invoiceURL: g.url('invoices', g.id('inv')),
          invoicePDF: `https://example.invalid/invoices/${g.id('pdf')}/pdf`
        }
      })
    },
    prices: { pro: { base: 30, seat: 8, traffic: 2 }, payg: { seat: 20, traffic: 2 } },
    status: {
      plan: 'Pro',
      billing: 'subscription',
      seats,
      minSeats,
      state: 'ACTIVE',
      automaticallyPayForTraffic: true,
      emailDomain: 'example.invalid'
    },
    stats: {
      users: seats,
      licensedUsers: seats + g.int(5, 15),
      activeUsers: { last7: g.int(5, 12), last30: g.int(12, 24), last60: g.int(20, 30), last90: g.int(28, 40) }
    }
  }
}

// Token secrets are synthetic runs masked before they leave `build`; `expiresAt` stays null (active).
export const sampleUnleashTokens = (g: SampleGen, config: SampleConfig): RawUnleashTokensResponse => ({
  tokens: g.repeat(Math.min(config.documents, 8), (i) => {
    const project = g.pick(['cdm', 'app', 'ops', 'web'])
    const environment = g.pick(['development', 'production', 'staging'])

    return {
      secret: `${project}:${environment}.${g.id('')}${g.last4()}`,
      tokenName: `${project}-${environment.slice(0, 4)}-${i}`,
      type: g.pick(['client', 'frontend', 'admin']),
      project,
      projects: [project],
      environment,
      expiresAt: null,
      createdAt: g.pastDate(500),
      seenAt: g.maybe(g.pastDate(30), 0.75) ?? null
    }
  })
})

// SYNTHETIC roster — the shared cast, root-role ids (1 Admin / 2 Editor / 3 Viewer).
export const sampleUnleashRoster = (g: SampleGen, config: SampleConfig): RawUnleashRosterResponse => ({
  users: g.people(config.users).map((p, i) => ({
    id: i + 1,
    name: p.name,
    email: p.email,
    rootRole: i === 0 ? 1 : g.pick([2, 3])
  }))
})
