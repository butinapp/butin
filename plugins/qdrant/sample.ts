// Synthetic sample GENERATORS for the demo seed — each builds a raw Qdrant payload purely from the seeded
// synthetic toolkit (no literal data), and `pnpm seed-demo` draws it through the SAME `build` the live
// collector uses. `documents` caps the monthly history + key counts; `users` drives the member roster.

import type { SampleConfig, SampleGen } from '@butinapp/sdk/testing'

import type { QdrantInvoicesInput, QdrantKeysInput, QdrantMembersInput } from './main.js'

// A committed monthly plan: one flat invoice per past month (newest first), amount in MILLICENTS, each with a
// synthetic PDF link. `documents` caps how far back the history runs.
export const sampleQdrantInvoices = (g: SampleGen, config: SampleConfig): QdrantInvoicesInput => {
  const span = Math.min(config.documents, 24)
  const amount = String(g.int(300_000_000, 350_000_000))
  const account = g.int(10_000_000, 99_999_999)

  return {
    items: g.repeat(span, (i) => {
      const ym = g.monthsAgo(i + 1).yearMonth

      return {
        id: g.id('in'),
        number: `${account}-${1000 + span - i}`,
        totalAmount: amount,
        createdAt: `${ym}-24T07:00:00Z`,
        status: 'INVOICE_STATUS_PAID',
        pdfUrl: `https://invoices.example.invalid/${ym}.pdf`
      }
    })
  }
}

export const sampleQdrantMembers = (g: SampleGen, config: SampleConfig): QdrantMembersInput => {
  const extraRoles = ['Owner', 'Admin']

  return {
    items: g.people(config.users).map((p, i) => ({
      user: { id: p.id, email: p.email, status: 'USER_STATUS_ACTIVE' },
      roles: [
        { name: 'Base', subType: 'SYSTEM_ROLE_SUB_TYPE_BASE' },
        ...(extraRoles[i] ? [{ name: extraRoles[i]! }] : [])
      ]
    }))
  }
}

export const sampleQdrantKeys = (g: SampleGen, config: SampleConfig): QdrantKeysInput => {
  const ops = g.person(1)
  const ci = g.person(2)

  return {
    databaseKeys: [
      {
        clusterId: 'c1',
        clusterName: 'prod',
        items: g.repeat(Math.min(config.documents, 4), (i) => ({
          id: g.id('key'),
          name: g.pick(['reader', 'writer', 'ingest', 'metrics']),
          createdByEmail: ops.email,
          createdAt: g.pastDate(300),
          accessRules: [
            {
              globalAccess: {
                accessType:
                  i === 0 ? 'GLOBAL_ACCESS_RULE_ACCESS_TYPE_READ_ONLY' : 'GLOBAL_ACCESS_RULE_ACCESS_TYPE_MANAGE'
              }
            }
          ]
        }))
      },
      {
        clusterId: 'c2',
        clusterName: 'staging',
        items: [
          {
            id: g.id('key'),
            name: 'ci',
            createdByEmail: ci.email,
            createdAt: g.pastDate(120),
            accessRules: [{ globalAccess: { accessType: 'GLOBAL_ACCESS_RULE_ACCESS_TYPE_READ_ONLY' } }]
          }
        ]
      }
    ],
    managementKeys: [{ id: g.id('mgmt'), prefix: `qm_${g.last4()}`, createdAt: g.pastDate(250) }]
  }
}
