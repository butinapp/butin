import { expect, test } from 'vitest'

import { computeSince, mergeRawRows } from './raw-union.js'

const order = (orderId: string, date: string, total: number) => ({ orderId, date, total })

test('mergeRawRows appends new keys and retains rows absent from the new fetch', () => {
  const prior = [order('A', '2020-01-01', 10), order('B', '2021-06-01', 20)]
  const fetched = [order('C', '2026-06-20', 30)]

  const merged = mergeRawRows(prior, fetched, 'orderId')

  expect(merged.map((r) => r.orderId)).toEqual(['A', 'B', 'C'])
})

test('mergeRawRows replaces a re-seen key with the fresher row, keeping its position', () => {
  const prior = [order('A', '2026-06-01', 10), order('B', '2026-06-02', 20)]
  const fetched = [order('A', '2026-06-01', 7)] // same order, total dropped (a refund)

  const merged = mergeRawRows(prior, fetched, 'orderId')

  expect(merged.map((r) => r.orderId)).toEqual(['A', 'B'])
  expect(merged[0]).toMatchObject({ orderId: 'A', total: 7 })
})

test('mergeRawRows keeps keyless rows rather than collapsing them', () => {
  const prior = [{ orderId: 'A', date: '2026-01-01' }]
  const fetched = [{ date: '2026-06-01' }, { date: '2026-06-02' }] // no orderId

  expect(mergeRawRows(prior, fetched, 'orderId')).toHaveLength(3)
})

test('computeSince is undefined for an empty union (a full fetch)', () => {
  expect(computeSince([], 'date', 60, '2026-06-27T00:00:00Z')).toBeUndefined()
})

test('computeSince re-fetches the trailing window when history is recent', () => {
  const rows = [order('A', '2026-06-25', 10)] // newest is 2 days ago

  // window 60d from 2026-06-27 → 2026-04-28; newest (06-25) is later, so the window start wins.
  expect(computeSince(rows, 'date', 60, '2026-06-27T12:00:00Z')).toBe('2026-04-28')
})

test('computeSince reaches back to the newest stored row when there is a gap', () => {
  const rows = [order('A', '2026-01-01', 10)] // last order is 6 months old

  // window start (04-28) is later than newest (01-01), so we must fetch from 01-01 to not miss new orders.
  expect(computeSince(rows, 'date', 60, '2026-06-27T00:00:00Z')).toBe('2026-01-01')
})
