// Synthetic sample GENERATORS for the demo seed — each builds a raw Qdrant payload purely from the seeded
// synthetic toolkit (no literal data), and `pnpm seed-demo` draws it through the SAME `build` the live
// collector uses. `documents` caps the monthly history + key counts; `users` drives the member roster.

import type { SampleConfig, SampleGen } from '@butinapp/sdk/testing'

import type { QdrantBillingInput, QdrantKeysInput, QdrantMembersInput } from './main.js'

// A 1-based {year, month} from a fixed month-back offset.
const monthYM = (g: SampleGen, n: number): { year: number; month: number } => {
  const [y, m] = g.monthsAgo(n).yearMonth.split('-')

  return { year: Number(y), month: Number(m) }
}

// Twelve months of metered history (ascending) — amounts in MILLICENTS, ramping up. The current month's
// per-cluster breakdown sums to the open-period MTD (spend.mtd rollup).
export const sampleQdrantBilling = (g: SampleGen, config: SampleConfig): QdrantBillingInput => {
  const span = Math.min(config.documents, 36)
  const base = g.int(150_000_000, 200_000_000)
  const current = monthYM(g, 0)

  return {
    monthly: g.repeat(span, (i) => ({
      ...monthYM(g, span - 1 - i),
      amountMillicents: String(base + i * 2_000_000),
      currency: 'USD'
    })),
    current: {
      year: current.year,
      month: current.month,
      items: [
        {
          clusterId: 'c1',
          clusterName: 'prod',
          billableEntityType: 'Cluster',
          amountMillicents: String(g.int(20_000_000, 40_000_000)),
          currency: 'USD'
        },
        {
          clusterId: 'c1',
          clusterName: 'prod',
          billableEntityType: 'Backup',
          amountMillicents: String(g.int(3_000_000, 7_000_000)),
          currency: 'USD'
        },
        {
          clusterId: 'c2',
          clusterName: 'staging',
          billableEntityType: 'Cluster',
          amountMillicents: String(g.int(5_000_000, 11_000_000)),
          currency: 'USD'
        }
      ]
    }
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
