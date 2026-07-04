// Synthetic sample GENERATORS for the demo seed — each builds a raw service payload purely from the seeded
// synthetic toolkit (no literal data), and `pnpm seed-demo` draws it through the SAME `build` the live
// collector uses. Money is cents (Connect-RPC convention); dates are epoch-second `{ seconds }` wrappers.
// `documents` caps the invoice/credential lists; `users` drives the team roster.

import type { SampleConfig, SampleGen } from '@butinapp/sdk/testing'

import type {
  RawApiKeyList,
  RawAuthtokenList,
  RawInvitationList,
  RawInvoiceList,
  RawSubscription,
  RawTeamMemberList
} from './main.js'

// `{ seconds }` epoch wrapper for a relative day offset (the wire dates everything in unix seconds).
const secondsDaysAgo = (g: SampleGen, daysAgo: number): { seconds: string } => ({
  seconds: String(g.pastEpochSec(daysAgo))
})

export const sampleNgrokSubscription = (g: SampleGen, config: SampleConfig): RawSubscription => ({
  intervalMonths: 1,
  renewsAt: secondsDaysAgo(g, 0),
  plan: { productId: 'v2_pro_monthly', quantity: String(config.users), description: 'Pro Monthly' },
  currentBillingPeriodStartDate: secondsDaysAgo(g, 30),
  currentBillingPeriodEndDate: secondsDaysAgo(g, 0),
  additionalUsageToDateInCents: g.amountCents(2_000, 12_000)
})

export const sampleNgrokInvoices = (g: SampleGen, config: SampleConfig): RawInvoiceList => {
  const n = Math.min(config.documents, 36)
  const monthly = g.amountCents(100_000, 120_000)

  return {
    invoices: g.repeat(n, (i) => {
      const total = String(monthly + g.amountCents(0, 4_000))
      const open = i === 0

      return {
        total,
        amountDue: total,
        ...(open ? {} : { amountPaid: total }),
        status: open ? 'Draft' : 'Paid',
        ...(open
          ? { createdAt: secondsDaysAgo(g, 0) }
          : { issuedAt: { seconds: String(g.monthsAgo(i).startEpochSec) } }),
        invoiceUrl: `https://example.invalid/invoices/view?token=${g.id('inv')}`
      }
    })
  }
}

// One credential row built from a cast member's email — shared by the apiKey + authtoken generators.
const credential = (
  g: SampleGen,
  owner: string,
  daysAgo: number,
  active: boolean,
  prefix: string,
  description: string
) => ({
  description,
  createdAt: secondsDaysAgo(g, daysAgo),
  id: { id: g.id(prefix) },
  ownerLegacy: { title: owner, name: owner },
  active
})

export const sampleNgrokApiKeys = (g: SampleGen, config: SampleConfig): RawApiKeyList => {
  const owner = g.person()

  return {
    apiKeys: g.repeat(Math.min(config.documents, 4), () =>
      credential(
        g,
        owner.email,
        g.int(30, 400),
        true,
        'ak',
        g.pick(['CI deploy key', 'Local development key', 'Production key', 'Staging key'])
      )
    )
  }
}

export const sampleNgrokAuthtokens = (g: SampleGen, config: SampleConfig): RawAuthtokenList => {
  const owner = g.person()

  return {
    dashAuthtokens: g.repeat(Math.min(config.documents, 4), (i) =>
      credential(
        g,
        owner.email,
        g.int(30, 300),
        i !== 1,
        'cr',
        g.pick(['agent token', 'edge token', 'tunnel token', 'retired agent token'])
      )
    )
  }
}

export const sampleNgrokTeamMembers = (g: SampleGen, config: SampleConfig): RawTeamMemberList => ({
  teamMembers: g.people(config.users).map((p, i) => ({
    id: { id: p.id },
    email: p.email,
    name: p.name,
    permissions: { isAdmin: i === 0, team: i === 0 ? 'TeamManage' : g.pick(['TeamView', 'TeamManage']) },
    active: true
  }))
})

export const sampleNgrokInvitations = (g: SampleGen, _config: SampleConfig): RawInvitationList => ({
  invitations: [
    { id: { id: g.id('inv') }, email: g.person().email, membershipPermissions: { team: 'TeamView' }, status: 'Pending' }
  ]
})
