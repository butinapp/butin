import { expect, it } from 'vitest'

import { splitResult, toDisplayResult } from './manifest.js'

it('splits a result into data-first datasets/summaries + a presentation manifest', () => {
  const result = {
    datasets: [
      {
        id: 'invoices',
        shape: 'table' as const,
        key: 'id',
        columns: [
          { key: 'amount', label: 'Amount', role: 'money' as const, currency: 'USD' },
          { key: 'status', label: 'Status', role: 'status' as const, badges: { paid: 'success' as const } },
          { key: 'id', label: 'Id', role: 'identifier' as const, hidden: true }
        ],
        rows: [{ amount: 1, status: 'paid', id: 'in_1' }]
      }
    ],
    views: [{ type: 'table' as const, dataset: 'invoices', title: 'Invoices' }],
    summaries: [
      {
        section: 'spend' as const,
        label: 'Spend',
        value: 1,
        role: 'money' as const,
        currency: 'USD',
        spark: { dataset: 'invoices', x: 'date', y: 'amount' }
      }
    ]
  }

  const { datasets, summaries, manifest } = splitResult(result)

  // data: no label/badges/hidden on columns
  expect(datasets[0]!.columns).toEqual([
    { key: 'amount', role: 'money', currency: 'USD' },
    { key: 'status', role: 'status' },
    { key: 'id', role: 'identifier' }
  ])
  expect(summaries).toEqual([{ section: 'spend', value: 1, role: 'money', currency: 'USD' }])

  // presentation: views + labels/badges/hidden + summary label/spark
  expect(manifest.views).toEqual(result.views)
  expect(manifest.columns!.invoices!.status).toEqual({ label: 'Status', badges: { paid: 'success' } })
  expect(manifest.columns!.invoices!.id).toEqual({ label: 'Id', hidden: true })
  expect(manifest.summaries!.spend).toEqual({
    label: 'Spend',
    spark: { dataset: 'invoices', x: 'date', y: 'amount' }
  })
})

it('splits a record dataset: fields become stored columns; value becomes rows[0]; labels land in manifest', () => {
  const result = {
    datasets: [
      {
        id: 'account',
        shape: 'record' as const,
        fields: [
          { key: 'name', label: 'Name', role: 'label' as const },
          { key: 'plan', label: 'Plan', role: 'label' as const }
        ],
        value: { name: 'Acme', plan: 'Pro' }
      }
    ],
    views: [{ type: 'keyvalue' as const, dataset: 'account', title: 'Account' }]
  }

  const { datasets, manifest } = splitResult(result)

  expect(datasets[0]!.shape).toBe('record')
  expect(datasets[0]!.columns).toEqual([
    { key: 'name', role: 'label' },
    { key: 'plan', role: 'label' }
  ])
  expect(datasets[0]!.rows).toEqual([{ name: 'Acme', plan: 'Pro' }])
  expect(manifest.columns!.account!.name).toEqual({ label: 'Name' })
  expect(manifest.columns!.account!.plan).toEqual({ label: 'Plan' })
})

it('produces undefined manifest.columns when no column has presentation fields', () => {
  const result = {
    datasets: [
      {
        id: 'items',
        shape: 'table' as const,
        columns: [
          { key: 'amount', role: 'money' as const, currency: 'USD' },
          { key: 'count', role: 'count' as const }
        ],
        rows: []
      }
    ],
    views: [{ type: 'table' as const, dataset: 'items', title: 'Items' }]
  }

  const { manifest } = splitResult(result)

  expect(manifest.columns).toBeUndefined()
})

it('returns summaries [] and undefined manifest.summaries when result has no summaries', () => {
  const result = {
    datasets: [
      {
        id: 'items',
        shape: 'table' as const,
        columns: [{ key: 'amount', role: 'money' as const, currency: 'USD' }],
        rows: []
      }
    ],
    views: [{ type: 'table' as const, dataset: 'items', title: 'Items' }]
  }

  const { summaries, manifest } = splitResult(result)

  expect(summaries).toEqual([])
  expect(manifest.summaries).toBeUndefined()
})

it('toDisplayResult reattaches presentation (inverse of splitResult)', () => {
  const original = {
    datasets: [
      {
        id: 'invoices',
        shape: 'table' as const,
        key: 'id',
        columns: [
          { key: 'amount', label: 'Amount', role: 'money' as const, currency: 'USD' },
          { key: 'status', label: 'Status', role: 'status' as const, badges: { paid: 'success' as const } },
          { key: 'items', label: 'Items', role: 'label' as const, truncate: true },
          { key: 'id', label: 'Id', role: 'identifier' as const, hidden: true }
        ],
        rows: [{ amount: 1, status: 'paid', items: 'a, b, c', id: 'in_1' }]
      },
      {
        id: 'account',
        shape: 'record' as const,
        fields: [{ key: 'plan', label: 'Plan', role: 'label' as const }],
        value: { plan: 'Pro' }
      }
    ],
    views: [
      { type: 'table' as const, dataset: 'invoices', title: 'Invoices' },
      { type: 'keyvalue' as const, dataset: 'account' }
    ],
    summaries: [
      {
        section: 'spend' as const,
        label: 'Spend',
        value: 1,
        role: 'money' as const,
        currency: 'USD',
        spark: { dataset: 'invoices', x: 'date', y: 'amount' }
      }
    ]
  }

  const { datasets, summaries, manifest } = splitResult(original)
  const display = toDisplayResult(datasets, summaries, manifest)

  expect(display.views).toEqual(original.views)
  expect((display.datasets[0] as { columns: unknown }).columns).toEqual(original.datasets[0]!.columns)
  expect(display.datasets[1]).toEqual(original.datasets[1])
  expect(display.summaries).toEqual(original.summaries)
})
