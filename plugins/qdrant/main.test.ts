import { validateCapabilityResult } from '@butinapp/sdk/data'
import { validateSamples } from '@butinapp/sdk/testing'
import { expect, test } from 'vitest'

import {
  buildQdrantAccountOptions,
  buildQdrantBilling,
  buildQdrantKeys,
  buildQdrantMembers,
  buildQdrantSummary,
  buildQdrantUsage,
  displayMemberRole,
  humanizeAccess,
  qdrantPlugin,
  retryOn5xx,
  toBillingInvoices
} from './main.js'

const http = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status })

test('every capability declares a sample that is contract-valid', () => {
  expect(validateSamples(qdrantPlugin)).toEqual([])
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

test('retryOn5xx retries a transient 5xx from the metering gateway then returns the eventual success', async () => {
  let calls = 0
  const result = await retryOn5xx(async () => {
    calls++

    if (calls < 3) {
      throw http(500)
    }

    return 'ok'
  })

  expect(result).toBe('ok')
  expect(calls).toBe(3)
})

test('retryOn5xx surfaces a non-5xx (auth/argument) error immediately without retrying', async () => {
  let calls = 0

  await expect(
    retryOn5xx(async () => {
      calls++
      throw http(401)
    })
  ).rejects.toThrow('HTTP 401')
  expect(calls).toBe(1)
})

test('retryOn5xx gives up after the attempt ceiling and rethrows the 5xx', async () => {
  let calls = 0

  await expect(
    retryOn5xx(async () => {
      calls++
      throw http(503)
    }, 3)
  ).rejects.toThrow('HTTP 503')
  expect(calls).toBe(3)
})

const invoicesInput = {
  items: [
    {
      id: 'in_3',
      number: '111-3',
      totalAmount: '319167000',
      createdAt: '2026-06-24T07:00:00Z',
      status: 'INVOICE_STATUS_PAID',
      pdfUrl: 'https://x/3.pdf'
    },
    {
      id: 'in_2',
      number: '111-2',
      totalAmount: '319167000',
      createdAt: '2026-05-24T07:00:00Z',
      status: 'INVOICE_STATUS_PAID',
      pdfUrl: 'https://x/2.pdf'
    },
    {
      id: 'in_1',
      number: '111-1',
      totalAmount: '310812000',
      createdAt: '2026-04-24T07:00:00Z',
      status: 'INVOICE_STATUS_PAID',
      pdfUrl: 'https://x/1.pdf'
    }
  ]
}

test('toBillingInvoices maps raw invoices → preset input (millicents→USD, issue day, lowercased status)', () => {
  expect(toBillingInvoices(invoicesInput.items)[0]).toMatchObject({
    id: 'in_3',
    date: '2026-06-24',
    amount: 3191.67,
    status: 'paid',
    pdfUrl: 'https://x/3.pdf'
  })
})

test('qdrant Summary: invoices drive the monthly-spend chart (ascending) + the spend rollup', () => {
  const result = buildQdrantSummary(invoicesInput)

  expect(validateCapabilityResult(result)).toEqual([])

  const monthly = result.datasets.find((d) => d.id === 'monthly') as unknown as {
    shape: string
    rows: Array<{ month: string; amount: number }>
  }

  expect(monthly.shape).toBe('table')
  expect(monthly.rows.map((r) => r.month)).toEqual(['2026-04', '2026-05', '2026-06'])
  expect(monthly.rows.at(-1)).toMatchObject({ month: '2026-06', amount: 3191.67 })

  // no current-month invoice yet → "this month" falls back to the latest (the recurring charge)
  expect(result.summaries?.[0]).toMatchObject({ section: 'spend', value: 3191.67, basis: 'invoiced' })
})

test('qdrant Billing: the itemized invoice list (newest first) with a downloadable PDF per row', () => {
  const result = buildQdrantBilling(invoicesInput)

  expect(validateCapabilityResult(result)).toEqual([])
  const invoices = result.datasets.find((d) => d.id === 'invoices') as unknown as {
    key: unknown
    rows: Array<{ number: string; amount: number; status: string }>
  }

  expect(invoices.rows.map((r) => r.number)).toEqual(['111-3', '111-2', '111-1'])
  expect(invoices.rows[0]).toMatchObject({ amount: 3191.67, status: 'paid' })
  // keyed by invoice id so the history accumulates in the ledger.
  expect(invoices.key).toBe('id')

  // the PDF download is wired as a files descriptor on the table view
  const view = result.views?.find((v) => v.type === 'table' && v.dataset === 'invoices')

  expect(view?.type === 'table' && view.files).toMatchObject({ source: { url: 'pdfUrl' }, ext: 'pdf' })

  // headline + chart live on Summary, not here
  expect(result.datasets.some((d) => d.id === 'account')).toBe(false)
  expect(result.summaries).toBeUndefined()
})

test('qdrant Summary tolerates no invoices (null currentMtd → no spend summary)', () => {
  const result = buildQdrantSummary({ items: [] })

  expect(validateCapabilityResult(result)).toEqual([])
  expect(result.summaries).toBeUndefined()
})

test('qdrant Usage: metered line items (amount desc) + gross total, emits no spend rollup', () => {
  const result = buildQdrantUsage({
    items: [
      {
        clusterName: 'prod',
        billableEntityType: 'Cluster',
        startTime: '2026-06-30T21:30:07Z',
        endTime: '2026-07-22T14:49:38Z',
        amountMillicents: '334355154'
      },
      {
        clusterName: 'staging',
        billableEntityType: 'Cluster',
        startTime: '2026-06-30T21:30:07Z',
        endTime: '2026-07-22T14:49:38Z',
        amountMillicents: '2659942'
      }
    ]
  })

  expect(validateCapabilityResult(result)).toEqual([])

  const usage = result.datasets.find((d) => d.id === 'usage') as unknown as {
    rows: Array<{ item: string; cluster: string; period: string; amount: number }>
  }

  // amount-descending, day-precision period, 2-decimal money (Qdrant's raw values carry 4+ decimals)
  expect(usage.rows.map((r) => r.cluster)).toEqual(['prod', 'staging'])
  expect(usage.rows[0]).toMatchObject({ item: 'Cluster', amount: 3343.55, period: '2026-06-30 → 2026-07-22' })

  const totalRec = result.datasets.find((d) => d.id === 'usageTotal') as unknown as { value: { total: number } }

  expect(totalRec.value.total).toBe(3370.15) // 3343.55 + 26.60

  // gross usage, not billed → no spend summary, so the Overview rollup stays the invoice on Summary
  expect(result.summaries).toBeUndefined()
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
