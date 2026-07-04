import { expect, test } from 'vitest'

import { monthlyBuckets, monthRange } from './monthly-buckets.js'

test('monthRange fills inclusive months across a year boundary', () => {
  expect(monthRange('2025-11', '2026-02')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02'])
})

test('monthlyBuckets sums by month and fills gaps through now', () => {
  const out = monthlyBuckets(
    [
      { date: '2026-01-15', amount: 10 },
      { date: '2026-01-20', amount: 5 },
      { date: '2026-03-02', amount: 20 }
    ],
    '2026-04'
  )

  expect(out).toEqual([
    { month: '2026-01', amount: 15 },
    { month: '2026-02', amount: 0 },
    { month: '2026-03', amount: 20 },
    { month: '2026-04', amount: 0 }
  ])
})

test('monthlyBuckets ignores undated invoices and returns [] when none are dated', () => {
  expect(monthlyBuckets([{ amount: 10 }], '2026-04')).toEqual([])
})
