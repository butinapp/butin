import { expect, test } from 'vitest'

import { groupByCategory } from './group-by-category.js'

type Row = { id: string; category?: string }

const rows: Row[] = [
  { id: 'qdrant', category: 'cloud' },
  { id: 'desjardins', category: 'finance' },
  { id: 'aws', category: 'cloud' },
  { id: 'mystery' }, // missing → 'other'
  { id: 'weird', category: 'nonsense' } // unknown → 'other'
]

test('buckets rows in fixed category order, omitting empty categories', () => {
  const groups = groupByCategory(rows)

  expect(groups.map(([c]) => c)).toEqual(['finance', 'cloud', 'other'])
})

test('preserves incoming order within a bucket', () => {
  const groups = groupByCategory(rows)
  const cloud = groups.find(([c]) => c === 'cloud')?.[1] ?? []

  expect(cloud.map((r) => r.id)).toEqual(['qdrant', 'aws'])
})

test('routes missing and unknown categories into other', () => {
  const groups = groupByCategory(rows)
  const other = groups.find(([c]) => c === 'other')?.[1] ?? []

  expect(other.map((r) => r.id)).toEqual(['mystery', 'weird'])
})
