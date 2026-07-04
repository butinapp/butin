import type { DailyPoint } from '@butinapp/shapes'
import { describe, expect, test } from 'vitest'

import { periodPair } from './windows.js'

const days = (entries: [string, number][]): DailyPoint[] => entries.map(([date, value]) => ({ date, value }))

describe('periodPair', () => {
  test('DoD: compares the last two complete days, excluding today', () => {
    const series = days([
      ['2026-06-14', 10],
      ['2026-06-15', 12],
      ['2026-06-16', 99]
    ]) // 16th = "today"

    expect(periodPair(series, 'dod', new Date(Date.UTC(2026, 5, 16, 8, 0, 0)))).toEqual({
      prev: 10,
      curr: 12,
      periodId: '2026-06-15'
    })
  })

  test('MoM: sums per month and compares the last two complete months, excluding the current', () => {
    const series = days([
      ['2026-04-10', 100],
      ['2026-04-20', 50], // Apr = 150
      ['2026-05-05', 200], // May = 200
      ['2026-06-03', 999] // Jun = current, excluded
    ])

    expect(periodPair(series, 'mom', new Date(Date.UTC(2026, 5, 16)))).toEqual({
      prev: 150,
      curr: 200,
      periodId: '2026-05'
    })
  })

  test('WoW: buckets by ISO week (Mon–Sun) and compares the last two complete weeks', () => {
    // 2026: Jun 1 is a Monday — week 23 = Jun 1–7, week 24 = Jun 8–14, week 25 = Jun 15–21 (current).
    const series = days([
      ['2026-06-02', 10],
      ['2026-06-05', 5], // W23 = 15
      ['2026-06-09', 30], // W24 = 30
      ['2026-06-16', 99] // W25 = current, excluded
    ])

    expect(periodPair(series, 'wow', new Date(Date.UTC(2026, 5, 16)))).toEqual({
      prev: 15,
      curr: 30,
      periodId: '2026-W24'
    })
  })

  test('returns null with fewer than two complete buckets', () => {
    expect(periodPair(days([['2026-06-15', 10]]), 'dod', new Date(Date.UTC(2026, 5, 16)))).toBeNull()
    expect(periodPair([], 'mom', new Date(Date.UTC(2026, 5, 16)))).toBeNull()
  })
})
