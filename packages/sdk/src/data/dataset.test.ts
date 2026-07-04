import { expect, test } from 'vitest'

import { ColumnSchema, DatasetSchema, rawRecord, rawTable } from './dataset.js'

test('rawTable() builds a table dataset that parses', () => {
  const ds = rawTable(
    'invoices',
    [{ key: 'amount', label: 'Amount', role: 'money', currency: 'USD' }],
    [{ amount: 42 }]
  )

  expect(ds.shape).toBe('table')
  expect(DatasetSchema.parse(ds)).toEqual(ds)
})

test('rawRecord() builds a record dataset that parses', () => {
  const ds = rawRecord('account', [{ key: 'plan', label: 'Plan', role: 'label' }], { plan: 'Pro' })

  expect(ds.shape).toBe('record')
  expect(DatasetSchema.parse(ds)).toEqual(ds)
})

test('DatasetSchema rejects an unknown semantic role', () => {
  const bad = { id: 'x', shape: 'table', columns: [{ key: 'a', label: 'A', role: 'bogus' }], rows: [] }

  expect(DatasetSchema.safeParse(bad).success).toBe(false)
})

test('rawTable() accepts an optional key naming the row identity', () => {
  const ds = rawTable('invoices', [{ key: 'id', label: 'ID', role: 'identifier' }], [{ id: 'in_1' }], 'id')

  expect(ds.key).toBe('id')
  expect(DatasetSchema.parse(ds)).toEqual(ds)
})

test('Column accepts accrual + resetPeriod', () => {
  const ds = rawTable(
    'm',
    [{ key: 'cost', label: 'Cost', role: 'money', accrual: 'cumulative', resetPeriod: 'monthly' }],
    [{ cost: 5 }],
    'cost'
  )

  expect(DatasetSchema.parse(ds)).toEqual(ds)
})

test('column accepts an optional hidden flag', () => {
  const col = ColumnSchema.parse({ key: 'id', label: 'Id', role: 'identifier', hidden: true })

  expect(col.hidden).toBe(true)
})
