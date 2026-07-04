// Synthetic sample GENERATORS for the demo seed — each builds a raw front-API payload purely from the seeded
// synthetic toolkit (no literal data), and `pnpm seed-demo` draws it through the SAME `build` the live collector
// uses, so the demo renders exactly what a real fetch would. The `documents`/`users` knobs scale counts.
//
// Vercel money is in DOLLARS (numbers + decimal strings), never cents — the build* transforms parse them as-is.

import type { SampleConfig, SampleGen } from '@butinapp/sdk/testing'
import { round2 } from '@butinapp/sdk/util'

import type { RawMembersList, VercelData } from './main.js'

// Fixed epoch-ms anchors (structural, not PII) — the toolkit's reference month is 2026-06.
const ACCOUNT_CREATED_MS = Date.UTC(2024, 0, 15)
const CYCLE_END_MS = Date.UTC(2026, 6, 1)

// The bundle Summary + Billing share (loadVercelData's shape): subscription + current-period usage + payment
// method + invoice history.
export const sampleVercelData = (g: SampleGen, config: SampleConfig): VercelData => {
  const seats = g.int(3, 25)
  const projectCount = Math.max(2, Math.min(config.documents, 36))
  const projects = g.repeat(projectCount, (i) => ({
    id: g.id('prj'),
    name: `${g.orgSlug()}-${g.pick(['web', 'app', 'docs', 'api'])}-${i}`,
    value: g.money(10, 90)
  }))
  const totalValue = projects.reduce((sum, p) => sum + p.value, 0)
  const n = Math.min(config.documents, 36)

  return {
    subscription: {
      plan: 'Pro',
      account: {
        billingName: g.company(),
        billingAddress: {
          line1: `${g.int(1, 9999)} ${g.pick(['Maple', 'Cedar', 'Oak', 'River'])} St`,
          city: g.pick(['Springfield', 'Riverside', 'Fairview', 'Greenville']),
          state: g.pick(['CA', 'NY', 'TX', 'WA']),
          country: 'US',
          postalCode: String(g.int(10_000, 99_999))
        },
        createdAt: ACCOUNT_CREATED_MS,
        stripeCustomerId: g.id('cus')
      },
      payment: { status: 'active', openInvoices: [] },
      products: [
        {
          slug: 'team',
          prices: [{ type: 'licensed', billableItemSlug: 'teamSeats', quantity: seats, maxQuantity: 25 }]
        },
        { slug: 'observability', prices: [{ type: 'licensed', billableItemSlug: 'observabilityPlus', quantity: 1 }] },
        { slug: 'bandwidth', prices: [{ type: 'metered', billableItemSlug: 'bandwidth', quantity: 0 }] }
      ]
    },
    usage: {
      plan: 'Pro',
      cycle: { start: g.monthsAgo(0).startEpochMs, end: CYCLE_END_MS },
      data: {
        onDemandCharges: round2(totalValue),
        usage: projects.map((p) => ({
          id: p.id,
          name: p.name,
          value: p.value,
          percent: round2(p.value / totalValue)
        }))
      }
    },
    payment: {
      defaultSource: 'src_default',
      sources: [
        {
          id: 'src_default',
          card: {
            brand: 'visa',
            display_brand: 'Visa',
            last4: g.last4(),
            exp_month: g.int(1, 12),
            exp_year: 2028
          },
          billing_details: { email: g.person().email }
        }
      ]
    },
    invoices: {
      data: g.repeat(n, (i) => {
        const month = g.monthsAgo(i).yearMonth
        const total = g.moneyStr(120, 200)

        return {
          id: g.id('inv'),
          invoiceNumber: month,
          status: 'paid',
          total,
          issuedAt: `${month}-01T00:00:00.000Z`,
          createdAt: `${month}-01T00:00:00.000Z`,
          dueDate: `${month}-15T00:00:00.000Z`,
          pdfDownloadUrl: `https://example.invalid/invoices/${g.id('pdf')}.pdf`,
          groups: [
            { id: 'managed-infra', total: (Number(total) * 0.7).toFixed(2) },
            { id: 'devex', total: (Number(total) * 0.3).toFixed(2) }
          ]
        }
      })
    }
  }
}

export const sampleVercelMembers = (g: SampleGen, config: SampleConfig): RawMembersList => ({
  members: g.people(config.users).map((p, i) => ({
    uid: g.id('usr'),
    email: p.email,
    role: i === 0 ? 'OWNER' : g.pick(['MEMBER', 'BILLING', 'DEVELOPER']),
    name: p.name,
    username: `${p.firstName}${p.lastName}`.toLowerCase()
  }))
})
