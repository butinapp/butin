// Synthetic sample GENERATORS for the demo seed — each builds a raw service payload purely from the seeded
// synthetic toolkit (no literal data), and `pnpm seed-demo` draws it through the SAME `build` the live
// collector uses. `documents` caps the invoice history; `users` drives the org roster + seat counts.

import type { SampleConfig, SampleGen } from '@butinapp/sdk/testing'

import type { InfisicalBillingInput, InfisicalUsageInput, RawMemberships } from './main.js'

// Billing bundle: a Stripe-shaped invoice history (CENTS, newest-first after build) + the current
// subscription + billing contact + a card on file. Money is in the wire's own unit (cents).
export const sampleInfisicalBilling = (g: SampleGen, config: SampleConfig): InfisicalBillingInput => {
  const n = Math.min(config.documents, 36)
  const seats = config.users
  const unit = g.amountCents(500, 1_200)
  const billing = g.person()

  return {
    invoices: g.repeat(n, (i) => ({
      id: g.id('in'),
      created: g.monthsAgo(i).startEpochSec,
      paid: true,
      number: g.seqId('INV-2026-', n - i, 3),
      total: unit * seats,
      invoice_pdf: `https://example.invalid/invoices/${g.id('inv')}.pdf`
    })),
    planBilling: {
      currentPeriodStart: g.pastEpochSec(30),
      currentPeriodEnd: g.pastEpochSec(0),
      interval: 'month',
      amount: unit,
      quantity: seats,
      users: Math.max(1, seats - 1),
      identities: 1
    },
    plan: { plan: { slug: 'pro', status: 'active' } },
    billingDetails: { name: g.company(), email: billing.email },
    paymentMethods: [
      {
        brand: g.pick(['visa', 'mastercard', 'amex']),
        funding: 'credit',
        exp_month: g.int(1, 12),
        exp_year: 2030,
        last4: g.last4()
      }
    ]
  }
}

// Usage bundle: seat consumption (members/identities/projects) + per-product resource counts + the plan
// feature/limit matrix.
export const sampleInfisicalUsage = (g: SampleGen, config: SampleConfig): InfisicalUsageInput => ({
  plan: {
    plan: {
      slug: 'pro',
      status: 'active',
      membersUsed: config.users,
      identitiesUsed: g.int(1, 4),
      workspacesUsed: g.int(3, 12),
      memberLimit: config.users + g.int(2, 8)
    }
  },
  productStats: {
    secretManager: { secretsCount: g.int(40, 300), environmentsCount: g.int(2, 5) },
    certificateManager: { certificatesCount: g.int(2, 30) },
    kms: { keysCount: g.int(1, 12) },
    secretScanning: { findingsCount: g.int(0, 20) }
  },
  planTable: {
    rows: [
      { name: 'Audit logs', allowed: true, used: String(g.int(10, 60)) },
      { name: 'SAML SSO', allowed: true, used: '1' },
      { name: 'SCIM provisioning', allowed: false, used: '-' }
    ]
  }
})

// Org roster: memberships nesting the person under `user`, with the org role at the top level. The first
// member is admin, the rest members.
export const sampleInfisicalMembers = (g: SampleGen, config: SampleConfig): RawMemberships => ({
  users: g.people(config.users).map((p, i) => ({
    id: g.id('mem'),
    role: i === 0 ? 'admin' : 'member',
    user: { id: p.id, firstName: p.firstName, lastName: p.lastName, email: p.email }
  }))
})
