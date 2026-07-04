import { expect, test } from 'vitest'

import { validateCapabilityResult } from '../data/result.js'

import { membersResult } from './members.js'

const sample = membersResult({
  members: [
    { id: '1', name: 'Ada', email: 'ada@x.io', role: 'owner' },
    { id: '2', email: 'b@x.io' }
  ]
})

test('membersResult is a valid CapabilityResult with no summary', () => {
  expect(validateCapabilityResult(sample)).toEqual([])
  expect(sample.summaries).toBeUndefined()
})

test('membersResult emits a single members table', () => {
  expect(sample.datasets.map((d) => d.id)).toEqual(['members'])
  const members = sample.datasets[0]

  if (members.shape !== 'table') {
    throw new Error('members should be a table')
  }

  expect(members.rows[0]).toMatchObject({ name: 'Ada', email: 'ada@x.io', role: 'owner' })
  expect(members.rows[1]).toMatchObject({ name: null, email: 'b@x.io', role: null })
})

test('membersResult keys on id and carries it as a hidden field', () => {
  const members = sample.datasets[0]

  if (members.shape !== 'table') {
    throw new Error('members should be a table')
  }

  expect(members.key).toBe('id')
  expect(members.rows[0]).toMatchObject({ id: '1' })
  expect(members.columns.some((c) => c.key === 'id')).toBe(false) // hidden — not a visible column
})

test('membersResult emits one members table view and validates', () => {
  const r = membersResult({ members: [{ id: '1', name: 'Ada', email: 'a@x.io', role: 'admin' }] })

  expect(r.datasets.map((d) => d.id)).toEqual(['members'])
  expect(r.views).toEqual([{ type: 'table', dataset: 'members', title: 'Members' }])
  expect(validateCapabilityResult(r)).toEqual([])
})

test('the role column is categorical (renderer colors it; the plugin picks no tone)', () => {
  const t = sample.datasets[0]

  if (t.shape !== 'table') {
    throw new Error('members should be a table')
  }

  const roleCol = t.columns.find((c) => c.key === 'role')

  // 'category' = a distinct-hue badge with no sentiment; the renderer assigns the color by hashing the value,
  // so there's no `badges` map to carry.
  expect(roleCol?.role).toBe('category')
  expect(roleCol?.badges).toBeUndefined()
})
