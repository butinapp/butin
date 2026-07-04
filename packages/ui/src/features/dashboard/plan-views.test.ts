import { rawRecord, rawTable } from '@butinapp/sdk/data'
import { expect, test } from 'vitest'

import { defaultViews, planViews } from './plan-views.js'

const account = rawRecord('account', [{ key: 'plan', label: 'Plan', role: 'label' }], { plan: 'Pro' })
const monthly = rawTable(
  'monthly',
  [
    { key: 'month', label: 'Month', role: 'timestamp' },
    { key: 'amount', label: 'Spend', role: 'money' }
  ],
  [{ month: '2026-05', amount: 42 }]
)

test('defaultViews makes a stat for a record', () => {
  expect(defaultViews([account])).toEqual([{ type: 'stat', dataset: 'account' }])
})

test('defaultViews makes a timeseries (timestamp x, money|count y) plus a table for such a table', () => {
  expect(defaultViews([monthly])).toEqual([
    { type: 'timeseries', dataset: 'monthly', x: 'month', y: 'amount' },
    { type: 'table', dataset: 'monthly' }
  ])
})

test('defaultViews makes only a table for a table without a timestamp+numeric pair', () => {
  const members = rawTable('members', [{ key: 'email', label: 'Email', role: 'identifier' }], [{ email: 'a@b.c' }])

  expect(defaultViews([members])).toEqual([{ type: 'table', dataset: 'members' }])
})

test('planViews resolves each view to its dataset', () => {
  const planned = planViews({ datasets: [account], views: [{ type: 'stat', dataset: 'account' }] })

  expect(planned).toHaveLength(1)
  expect(planned[0].dataset.id).toBe('account')
  expect(planned[0].view).toEqual({ type: 'stat', dataset: 'account' })
})

test('planViews drops a view whose dataset id does not exist', () => {
  const planned = planViews({ datasets: [account], views: [{ type: 'table', dataset: 'ghost' }] })

  expect(planned).toEqual([])
})

test('planViews falls back to defaultViews when result.views is absent', () => {
  const planned = planViews({ datasets: [account] })

  expect(planned.map((p) => p.view)).toEqual([{ type: 'stat', dataset: 'account' }])
})
