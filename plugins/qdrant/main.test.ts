import {
  resolveCurrencies,
  validateCapabilityResult,
  validateCapabilityResult as rawValidateCR
} from '@butinapp/sdk/data'
import { expect, test } from 'vitest'

import {
  buildQdrantAccountOptions,
  buildQdrantBilling,
  buildQdrantKeys,
  buildQdrantMembers,
  buildQdrantSummary,
  displayMemberRole,
  humanizeAccess,
  qdrantPlugin
} from './main.js'

const validateSampleResult = (r: Parameters<typeof resolveCurrencies>[0]): string[] =>
  rawValidateCR(resolveCurrencies(r, 'USD'))

test('every capability declares a sample that is contract-valid', () => {
  for (const cap of qdrantPlugin.capabilities) {
    expect(cap.sample, `${cap.id} has a sample`).toBeDefined()
    expect(validateSampleResult(cap.sample!()), cap.id).toEqual([])
  }
})

test('qdrant declares rotating-refresh auth with a resolve() hook', () => {
  expect(qdrantPlugin.auth.kind).toBe('rotating-refresh')
  expect('resolve' in qdrantPlugin.auth && typeof qdrantPlugin.auth.resolve === 'function').toBe(true)
})

test('qdrant exposes an Organization combobox that loads account options', () => {
  const field = qdrantPlugin.config?.fields.find((f) => f.key === 'accountId')

  expect(field).toMatchObject({ kind: 'combobox', label: 'Organization' })
  expect(typeof field?.loadOptions).toBe('function')
})

test('buildQdrantAccountOptions maps accounts to picker options and flags the signed-in account', () => {
  const accounts = [
    { id: 'acct-1', name: 'Acme Inc', ownerEmail: 'owner@example.test' },
    { id: 'acct-2', name: 'Personal - Base Account', ownerEmail: 'you@example.test' },
    { name: 'No id — skipped' }
  ]

  const options = buildQdrantAccountOptions(accounts, 'acct-2')

  expect(options).toHaveLength(2)
  expect(options[0]).toMatchObject({
    value: 'acct-1',
    label: 'Acme Inc',
    description: 'owner@example.test',
    recommended: false
  })
  expect(options[1]).toMatchObject({ label: 'Personal - Base Account', recommended: true })
})

test('buildQdrantAccountOptions falls back to the owner email then id for the label', () => {
  const options = buildQdrantAccountOptions([{ id: 'a1', ownerEmail: 'solo@example.test' }, { id: 'a2' }])

  expect(options[0]).toMatchObject({ value: 'a1', label: 'solo@example.test' })
  expect(options[1]).toMatchObject({ value: 'a2', label: 'a2', description: 'a2' })
})

test('qdrant captures the Auth0 refresh token from a dynamic localStorage key', () => {
  const token = qdrantPlugin.session?.localStorageTokens?.[0]

  expect(token?.keyIncludes).toEqual(['@@auth0spajs@@', 'clusters'])
  expect(token?.jsonPath).toBe('body.refresh_token')
  expect(token?.storeAs).toBe('refreshToken')
})

const meteringInput = {
  monthly: [
    { year: 2026, month: 6, amountMillicents: '476268416', currency: 'USD' },
    { year: 2026, month: 5, amountMillicents: '100000000' }
  ],
  current: {
    year: 2026,
    month: 6,
    items: [
      { clusterId: 'c1', clusterName: 'prod', billableEntityType: 'Cluster', amountMillicents: '400000000' },
      { clusterId: 'c1', clusterName: 'prod', billableEntityType: 'Backup', amountMillicents: '76268416' },
      { clusterId: 'c2', clusterName: 'staging', billableEntityType: 'Cluster', amountMillicents: '50000000' }
    ]
  }
}

test('qdrant Summary: millicents→USD, monthly history ascending, per-cluster current breakdown, spend.mtd', () => {
  const result = buildQdrantSummary(meteringInput)

  expect(validateCapabilityResult(result)).toEqual([])

  const monthly = result.datasets.find((d) => d.id === 'monthly') as unknown as {
    shape: string
    rows: Array<{ month: string }>
  }

  expect(monthly.shape).toBe('table')
  expect(monthly.rows.map((r) => r.month)).toEqual(['2026-05', '2026-06'])

  const clusters = result.datasets.find((d) => d.id === 'currentClusters') as unknown as {
    rows: Array<{ cluster: string; total: number }>
  }

  expect(clusters.rows[0]).toMatchObject({ cluster: 'prod', total: 4762.68 })
  expect(clusters.rows[1]).toMatchObject({ cluster: 'staging', total: 500 })

  expect(result.summaries?.[0]).toMatchObject({ section: 'spend', value: 5262.68, basis: 'accrued' })
})

test('qdrant Billing detail: the monthly metering records table (newest first), no Summary headline', () => {
  const result = buildQdrantBilling(meteringInput)

  expect(validateCapabilityResult(result)).toEqual([])
  const meterings = result.datasets.find((d) => d.id === 'meterings') as unknown as {
    rows: Array<{ month: string; status: string }>
  }

  expect(meterings.rows.map((r) => r.month)).toEqual(['2026-06', '2026-05'])
  expect(meterings.rows[0].status).toBe('metered')
  // headline + chart live on Summary
  expect(result.datasets.some((d) => d.id === 'account')).toBe(false)
  expect(result.datasets.some((d) => d.id === 'currentClusters')).toBe(false)
})

test('qdrant Summary tolerates empty meterings', () => {
  const result = buildQdrantSummary({ monthly: [], current: { year: 2026, month: 6, items: [] } })

  expect(validateCapabilityResult(result)).toEqual([])
  expect(result.datasets.some((d) => d.id === 'currentClusters')).toBe(false)
})

test('qdrant leads with a Summary tab (kind billing, first) ahead of the invoicing Billing tab', () => {
  expect(qdrantPlugin.capabilities[0]).toMatchObject({ id: 'summary' })
  expect(qdrantPlugin.capabilities.some((c) => c.id === 'billing')).toBe(true)
})

test('qdrant exposes a Members tab (kind members) and no Clusters tab', () => {
  expect(qdrantPlugin.capabilities.some((c) => c.id === 'members')).toBe(true)
  expect(qdrantPlugin.capabilities.some((c) => c.id === 'clusters')).toBe(false)
})

test('displayMemberRole drops the baseline Base role and dedupes/joins the rest', () => {
  expect(
    displayMemberRole([
      { name: 'Base', subType: 'SYSTEM_ROLE_SUB_TYPE_BASE' },
      { name: 'Admin' },
      { name: 'Owner/Admin' }
    ])
  ).toBe('Admin, Owner/Admin')
  // only the baseline → surface it rather than nothing
  expect(displayMemberRole([{ name: 'Base', subType: 'SYSTEM_ROLE_SUB_TYPE_BASE' }])).toBe('Base')
  expect(displayMemberRole([])).toBeUndefined()
})

test('qdrant members maps users-with-roles onto the members preset (email / role, no name)', () => {
  const result = buildQdrantMembers({
    items: [
      {
        user: { id: 'u1', email: 'ada@example.test', status: 'USER_STATUS_ACTIVE' },
        roles: [{ name: 'Base', subType: 'SYSTEM_ROLE_SUB_TYPE_BASE' }, { name: 'Owner' }]
      },
      {
        user: { id: 'u2', email: 'sam@example.test', status: 'USER_STATUS_ACTIVE' },
        roles: [{ name: 'Base', subType: 'SYSTEM_ROLE_SUB_TYPE_BASE' }]
      }
    ]
  })

  expect(validateCapabilityResult(result)).toEqual([])

  const rows = (result.datasets.find((d) => d.id === 'members') as unknown as { rows: Array<Record<string, unknown>> })
    .rows

  expect(rows[0]).toMatchObject({ name: null, email: 'ada@example.test', role: 'Owner' })
  expect(rows[1]).toMatchObject({ name: null, email: 'sam@example.test', role: 'Base' })
})

test('humanizeAccess strips the enum prefix and title-cases', () => {
  expect(humanizeAccess('GLOBAL_ACCESS_RULE_ACCESS_TYPE_READ_ONLY')).toBe('Read Only')
  expect(humanizeAccess('GLOBAL_ACCESS_RULE_ACCESS_TYPE_MANAGE')).toBe('Manage')
  expect(humanizeAccess(undefined)).toBe('')
})

test('qdrant keys merges per-cluster database keys + management keys into one table', () => {
  const result = buildQdrantKeys({
    databaseKeys: [
      {
        clusterId: 'c1',
        clusterName: 'prod',
        items: [
          {
            id: 'k1',
            name: 'reader',
            createdByEmail: 'ops@example.test',
            createdAt: '2026-01-02T00:00:00Z',
            accessRules: [{ globalAccess: { accessType: 'GLOBAL_ACCESS_RULE_ACCESS_TYPE_READ_ONLY' } }]
          }
        ]
      }
    ],
    managementKeys: [{ id: 'm1', prefix: 'qm_abc', createdAt: '2026-02-03T00:00:00Z' }]
  })

  expect(validateCapabilityResult(result)).toEqual([])

  const rows = (result.datasets.find((d) => d.id === 'keys') as unknown as { rows: Array<Record<string, unknown>> })
    .rows

  expect(rows[0]).toMatchObject({
    name: 'reader',
    type: 'database',
    cluster: 'prod',
    access: 'Read Only',
    createdBy: 'ops@example.test',
    created: '2026-01-02'
  })
  expect(rows[1]).toMatchObject({ name: 'qm_abc…', type: 'management', cluster: null, created: '2026-02-03' })
})
