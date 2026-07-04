import { describe, expect, it, test } from 'vitest'

import { rawRecord, rawTable } from './dataset.js'
import { validateCapabilityResult } from './result.js'

const monthly = rawTable(
  'monthly',
  [
    { key: 'month', label: 'Month', role: 'timestamp' },
    { key: 'amount', label: 'Spend', role: 'money', currency: 'USD' }
  ],
  [{ month: '2026-05', amount: 42 }]
)
const account = rawRecord('account', [{ key: 'plan', label: 'Plan', role: 'label' }], { plan: 'Pro' })

test('rejects a key that is neither a column nor a row field', () => {
  const ds = rawTable('t', [{ key: 'a', label: 'A', role: 'label' }], [{ a: 1 }], 'missing')

  expect(validateCapabilityResult({ datasets: [ds] })).toContain("key 'missing' is not a column or row field of 't'")
})

test('accepts a key that is a hidden row field (not a column)', () => {
  const ds = rawTable('t', [{ key: 'a', label: 'A', role: 'label' }], [{ a: 1, id: 'x' }], 'id')

  expect(validateCapabilityResult({ datasets: [ds] })).toEqual([])
})

test('rejects a cumulative column on an unkeyed table', () => {
  const ds = rawTable('t', [{ key: 'c', label: 'C', role: 'money', accrual: 'cumulative' }], [{ c: 1 }])

  expect(validateCapabilityResult({ datasets: [ds] }).join()).toMatch(/cumulative column 'c'.*unkeyed/)
})

test('a well-formed result has no errors', () => {
  const errors = validateCapabilityResult({
    datasets: [monthly, account],
    views: [
      { type: 'timeseries', dataset: 'monthly', x: 'month', y: 'amount' },
      { type: 'keyvalue', dataset: 'account' }
    ],
    summaries: [
      {
        section: 'spend',
        label: 'MTD',
        value: 42,
        role: 'money',
        currency: 'USD',
        spark: { dataset: 'monthly', x: 'month', y: 'amount' }
      }
    ]
  })

  expect(errors).toEqual([])
})

test('a view referencing an unknown dataset is an error', () => {
  const errors = validateCapabilityResult({ datasets: [account], views: [{ type: 'table', dataset: 'nope' }] })

  expect(errors.some((e) => e.includes("unknown dataset 'nope'"))).toBe(true)
})

test('a timeseries x that is not a timestamp is an error', () => {
  const errors = validateCapabilityResult({
    datasets: [monthly],
    views: [{ type: 'timeseries', dataset: 'monthly', x: 'amount', y: 'amount' }]
  })

  expect(errors.some((e) => e.includes('timeseries x'))).toBe(true)
})

test('a stat view over a table dataset is an error', () => {
  const errors = validateCapabilityResult({ datasets: [monthly], views: [{ type: 'stat', dataset: 'monthly' }] })

  expect(errors.some((e) => e.includes('needs a record dataset'))).toBe(true)
})

test('a structurally invalid result (bad section) is reported', () => {
  const errors = validateCapabilityResult({
    datasets: [account],
    summaries: [{ section: 'bogus', label: 'x', value: 1, role: 'money' }]
  })

  expect(errors.length).toBeGreaterThan(0)
})

test('a money column with no currency is an error', () => {
  const ds = rawTable('t', [{ key: 'amt', label: 'Amt', role: 'money' }], [{ amt: 1 }])

  expect(
    validateCapabilityResult({ datasets: [ds] }).some((e) => e.includes('money column') && e.includes('currency'))
  ).toBe(true)
})

test('a money column with a currency passes', () => {
  const ds = rawTable('t', [{ key: 'amt', label: 'Amt', role: 'money', currency: 'USD' }], [{ amt: 1 }])

  expect(validateCapabilityResult({ datasets: [ds] })).toEqual([])
})

test('a money record field with no currency is an error', () => {
  const ds = rawRecord('r', [{ key: 'bal', label: 'Balance', role: 'money' }], { bal: 1 })

  expect(
    validateCapabilityResult({ datasets: [ds] }).some((e) => e.includes('money column') && e.includes('currency'))
  ).toBe(true)
})

test('a money summary with no currency is an error', () => {
  const ds = rawTable('t', [{ key: 'amt', label: 'Amt', role: 'money', currency: 'USD' }], [{ amt: 1 }])
  const errors = validateCapabilityResult({
    datasets: [ds],
    summaries: [{ section: 'spend', label: 'MTD', value: 1, role: 'money' }]
  })

  expect(errors.some((e) => e.includes('money summary') && e.includes('currency'))).toBe(true)
})

it('rejects a money summary with no currency', () => {
  const r = { datasets: [], summaries: [{ section: 'balance', label: 'B', value: 1, role: 'money' }] }

  expect(validateCapabilityResult(r).join()).toMatch(/money summary 'B' has no currency/)
})

describe('table row-detail', () => {
  const members = rawTable(
    'members',
    [{ key: 'who', label: 'Member', role: 'label' }],
    [{ who: 'alice', creatorId: 'u1' }],
    'creatorId'
  )
  const keys = rawTable(
    'keys',
    [
      { key: 'name', label: 'Name', role: 'label' },
      { key: 'creatorId', role: 'identifier', hidden: true }
    ],
    [{ name: 'prod', creatorId: 'u1' }],
    'name'
  )

  it('accepts a valid detail binding', () => {
    const errors = validateCapabilityResult({
      datasets: [members, keys],
      views: [{ type: 'table', dataset: 'members', detail: { dataset: 'keys', on: 'creatorId' } }]
    })

    expect(errors).toEqual([])
  })

  it('rejects a detail referencing an unknown dataset', () => {
    const errors = validateCapabilityResult({
      datasets: [members],
      views: [{ type: 'table', dataset: 'members', detail: { dataset: 'nope', on: 'creatorId' } }]
    })

    expect(errors.some((e) => e.includes("unknown dataset 'nope'"))).toBe(true)
  })

  it('rejects a detail whose child is a record', () => {
    const errors = validateCapabilityResult({
      datasets: [members, account],
      views: [{ type: 'table', dataset: 'members', detail: { dataset: 'account', on: 'creatorId' } }]
    })

    expect(errors.some((e) => e.includes('must be a table dataset'))).toBe(true)
  })

  it('rejects an on field missing from the child', () => {
    const bareKeys = rawTable('bareKeys', [{ key: 'name', label: 'Name', role: 'label' }], [{ name: 'prod' }], 'name')
    const errors = validateCapabilityResult({
      datasets: [members, bareKeys],
      views: [{ type: 'table', dataset: 'members', detail: { dataset: 'bareKeys', on: 'creatorId' } }]
    })

    expect(errors.some((e) => e.includes("'creatorId'") && e.includes("child table 'bareKeys'"))).toBe(true)
  })
})

describe('section summaries', () => {
  const ds = (id: string) => ({
    shape: 'table' as const,
    id,
    columns: [
      { key: 'month', label: 'Month', role: 'timestamp' as const },
      { key: 'amount', label: 'Spend', role: 'money' as const, currency: 'USD' }
    ],
    rows: [{ month: '2026-06', amount: 10 }],
    key: 'month'
  })

  const spark = { dataset: 'monthly', x: 'month', y: 'amount' }

  it('accepts spend + balance + other together', () => {
    const errors = validateCapabilityResult({
      datasets: [ds('monthly')],
      summaries: [
        { section: 'spend', label: 'This month', value: 10, role: 'money', currency: 'USD', spark },
        { section: 'balance', label: 'Net', value: 5, role: 'money', currency: 'USD' },
        { section: 'other', label: 'Repos', value: 3, role: 'count' }
      ]
    })

    expect(errors).toEqual([])
  })

  it('rejects two spend summaries in one result', () => {
    const errors = validateCapabilityResult({
      datasets: [ds('monthly')],
      summaries: [
        { section: 'spend', label: 'A', value: 10, role: 'money', currency: 'USD', spark },
        { section: 'spend', label: 'B', value: 20, role: 'money', currency: 'USD', spark }
      ]
    })

    expect(errors).toContain('more than one spend summary in a result')
  })

  it('rejects a spend summary with no spark', () => {
    const errors = validateCapabilityResult({
      datasets: [ds('monthly')],
      summaries: [{ section: 'spend', label: 'MTD', value: 10, role: 'money', currency: 'USD' }]
    })

    expect(errors).toContain("spend summary 'MTD' needs a spark (the monthly series the Overview reads)")
  })

  it('still requires a currency on money summaries', () => {
    const errors = validateCapabilityResult({
      datasets: [ds('monthly')],
      summaries: [{ section: 'other', label: 'Spend', value: 10, role: 'money' }]
    })

    expect(errors.some((e) => e.includes('has no currency'))).toBe(true)
  })
})
