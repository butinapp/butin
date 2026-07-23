import { expect, test } from 'vitest'

import { combineDailySpend, deriveDailyByRow, deriveDailySpend, type DailyPoint, type DailySource } from './daily.js'

const pt = (date: string, value: number, capturedAt = `${date}T23:00:00Z`): DailySource => ({
  date,
  capturedAt,
  section: 'spend',
  value
})

test('deriveDailySpend diffs consecutive days', () => {
  const daily = deriveDailySpend([pt('2026-06-11', 10), pt('2026-06-12', 14), pt('2026-06-13', 21)])

  expect(daily).toEqual([
    { date: '2026-06-12', value: 4 },
    { date: '2026-06-13', value: 7 }
  ])
})

test('deriveDailySpend treats a month rollover as a counter reset, not a negative diff', () => {
  const daily = deriveDailySpend([pt('2026-06-30', 90), pt('2026-07-01', 3)])

  expect(daily).toEqual([{ date: '2026-07-01', value: 3 }])
})

test('deriveDailySpend spreads a multi-day gap evenly and flags it estimated', () => {
  const daily = deriveDailySpend([pt('2026-06-10', 10), pt('2026-06-13', 16)])

  expect(daily).toEqual([
    { date: '2026-06-11', value: 2, estimated: true },
    { date: '2026-06-12', value: 2, estimated: true },
    { date: '2026-06-13', value: 2, estimated: true }
  ])
})

test('deriveDailySpend fills a zero-delta gap with known zeros, not estimates', () => {
  // A flat meter across the gap means no spend on any of those days — that is certain, not interpolated, so the
  // days are plain zeros. (Contrast the non-zero gap above, where the day-by-day split is genuinely unknown.)
  const daily = deriveDailySpend([pt('2026-07-20', 50), pt('2026-07-23', 50)])

  expect(daily).toEqual([
    { date: '2026-07-21', value: 0 },
    { date: '2026-07-22', value: 0 },
    { date: '2026-07-23', value: 0 }
  ])
})

test('deriveDailySpend emits the value itself for a lone first-of-month point', () => {
  expect(deriveDailySpend([pt('2026-06-01', 4)])).toEqual([{ date: '2026-06-01', value: 4 }])
})

test('deriveDailySpend emits nothing for a lone mid-month point (no prior to diff)', () => {
  expect(deriveDailySpend([pt('2026-06-13', 12)])).toEqual([])
})

test('deriveDailySpend collapses several captures on a day to the latest (end-of-day) before diffing', () => {
  // Day 12 captured thrice (noon/afternoon/night) + day 13 once. The latest capture each day wins.
  const daily = deriveDailySpend([
    pt('2026-06-12', 10, '2026-06-12T12:00:00Z'),
    pt('2026-06-12', 12, '2026-06-12T15:00:00Z'),
    pt('2026-06-12', 14, '2026-06-12T23:00:00Z'),
    pt('2026-06-13', 21, '2026-06-13T20:00:00Z')
  ])

  expect(daily).toEqual([{ date: '2026-06-13', value: 7 }]) // 21 − 14, not 21 − 10
})

test('deriveDailySpend unions multiple people’s captures — whoever measured a day fills it', () => {
  // Person A captured the 11th and 13th; person B captured the 12th. Together: a complete daily series.
  const daily = deriveDailySpend([
    pt('2026-06-11', 10, '2026-06-11T22:00:00Z'), // A
    pt('2026-06-13', 30, '2026-06-13T22:00:00Z'), // A
    pt('2026-06-12', 18, '2026-06-12T09:00:00Z') // B
  ])

  expect(daily).toEqual([
    { date: '2026-06-12', value: 8 }, // 18 − 10
    { date: '2026-06-13', value: 12 } // 30 − 18 (no estimated gap, because B filled the 12th)
  ])
})

test('resetPeriod:monthly forces monthly reset regardless of section', () => {
  const pts: DailySource[] = [
    { date: '2026-05-31', capturedAt: '2026-05-31T23:00:00Z', section: 'x', value: 100 },
    { date: '2026-06-01', capturedAt: '2026-06-01T23:00:00Z', section: 'x', value: 12 }
  ]

  expect(deriveDailySpend(pts, 'monthly')).toEqual([{ date: '2026-06-01', value: 12 }])
})

test('resetPeriod:none never treats a month rollover as a reset', () => {
  const pts: DailySource[] = [
    { date: '2026-05-31', capturedAt: '2026-05-31T23:00:00Z', section: 'spend', value: 100 },
    { date: '2026-06-01', capturedAt: '2026-06-01T23:00:00Z', section: 'spend', value: 130 }
  ]

  expect(deriveDailySpend(pts, 'none')).toEqual([{ date: '2026-06-01', value: 30 }])
})

test('deriveDailyByRow differences each row independently', () => {
  const readings: Record<string, DailySource[]> = {
    alice: [
      { date: '2026-06-14', capturedAt: '2026-06-14T23:00:00Z', section: '', value: 10 },
      { date: '2026-06-15', capturedAt: '2026-06-15T23:00:00Z', section: '', value: 25 }
    ],
    bob: [{ date: '2026-06-15', capturedAt: '2026-06-15T23:00:00Z', section: '', value: 7 }]
  }

  expect(deriveDailyByRow(readings, 'monthly')).toEqual({
    alice: [{ date: '2026-06-15', value: 15 }],
    bob: []
  })
})

const d = (date: string, value: number, estimated?: boolean): DailyPoint =>
  estimated ? { date, value, estimated } : { date, value }

test('combineDailySpend sums overlapping days across services', () => {
  const combined = combineDailySpend([
    [d('2026-06-12', 4), d('2026-06-13', 7)],
    [d('2026-06-12', 1), d('2026-06-13', 2)]
  ])

  expect(combined).toEqual([
    { date: '2026-06-12', value: 5 },
    { date: '2026-06-13', value: 9 }
  ])
})

test('combineDailySpend merges disjoint date ranges, sorted', () => {
  const combined = combineDailySpend([[d('2026-06-13', 7)], [d('2026-06-11', 3)]])

  expect(combined.map((p) => p.date)).toEqual(['2026-06-11', '2026-06-13'])
})

test('combineDailySpend marks a combined day estimated if any contributor estimated it', () => {
  const combined = combineDailySpend([[d('2026-06-12', 4, true)], [d('2026-06-12', 1)]])

  expect(combined).toEqual([{ date: '2026-06-12', value: 5, estimated: true }])
})
