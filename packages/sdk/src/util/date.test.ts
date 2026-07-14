import { afterEach, expect, test } from 'vitest'

import {
  currentMonthKey,
  dayOf,
  epochMsDay,
  epochSecDay,
  getReportingZone,
  isoDay,
  monthKey,
  monthMinus,
  monthStart,
  setReportingZone,
  utcDaysAgo
} from './date.js'

// The pure helpers default to UTC bucketing so fixtures stay deterministic regardless of the test runner's OS
// zone; a few cases below set a zone explicitly, so reset after each so nothing leaks into the next test.
afterEach(() => setReportingZone('utc'))

test('the reporting zone defaults to utc', () => {
  expect(getReportingZone()).toBe('utc')
})

test('isoDay trims an ISO datetime to its day, undefined when empty', () => {
  expect(isoDay('2026-06-13T12:34:56Z')).toBe('2026-06-13')
  expect(isoDay('2026-06-13')).toBe('2026-06-13')
  expect(isoDay()).toBeUndefined()
  expect(isoDay(null)).toBeUndefined()
  expect(isoDay('')).toBeUndefined()
})

test('epochMsDay formats epoch milliseconds as a day in the reporting zone, undefined when missing/invalid', () => {
  expect(epochMsDay(Date.UTC(2026, 5, 13, 23, 0, 0))).toBe('2026-06-13')
  expect(epochMsDay(0)).toBeUndefined()
  expect(epochMsDay()).toBeUndefined()
  expect(epochMsDay(null)).toBeUndefined()
  expect(epochMsDay(Number.NaN)).toBeUndefined()
})

test('epochSecDay formats epoch seconds as a day in the reporting zone', () => {
  expect(epochSecDay(Date.UTC(2026, 5, 13) / 1000)).toBe('2026-06-13')
  expect(epochSecDay(0)).toBeUndefined()
  expect(epochSecDay(null)).toBeUndefined()
})

test('dayOf resolves an ISO datetime (Z or offset) to its day in the reporting zone', () => {
  expect(dayOf('2026-06-13T23:00:00Z')).toBe('2026-06-13')
  expect(dayOf('2026-06-13T23:00:00-04:00')).toBe('2026-06-14') // 03:00 UTC next day
  expect(dayOf(undefined)).toBeUndefined()
  expect(dayOf('')).toBeUndefined()
})

test('monthKey zero-pads a 1-based month', () => {
  expect(monthKey(2026, 6)).toBe('2026-06')
  expect(monthKey(2026, 11)).toBe('2026-11')
})

test('monthMinus steps back whole calendar months, regardless of the day', () => {
  expect(monthMinus('2026-07-02', 1)).toBe('2026-06-02') // an arrears invoice issued Jul 02 → June
  expect(monthMinus('2026-01-15', 1)).toBe('2025-12-15') // crosses the year boundary
  expect(monthMinus('2026-03-31', 1)).toBe('2026-02-28') // clamps to the shorter month
  expect(monthMinus('2026-07-02', 0)).toBe('2026-07-02')
  expect(monthMinus('not-a-date', 1)).toBe('not-a-date') // invalid → unchanged
})

test('monthStart is the first of the given month in the reporting zone', () => {
  expect(monthStart(new Date('2026-06-13T12:00:00Z'))).toBe('2026-06-01')
})

test('utcDaysAgo counts back N UTC days from now', () => {
  const today = new Date().toISOString().slice(0, 10)

  expect(utcDaysAgo(0)).toBe(today)
  expect(utcDaysAgo(1) < today).toBe(true)
})

// The exact boundary from the bug: a spend instant at 2026-07-01 02:00 UTC is still 2026-06-30 in New York.
// Under UTC bucketing it books to July (rolling "this month" over early for an Eastern user); under the user's
// wall-clock zone it correctly stays in June — and everything rolls at the same local midnight.
test('day + month buckets follow the reporting zone across the month boundary', () => {
  const instant = Date.UTC(2026, 6, 1, 2, 0, 0) // 2026-07-01T02:00:00Z

  expect(epochMsDay(instant)).toBe('2026-07-01')
  expect(currentMonthKey(new Date(instant))).toBe('2026-07')
  expect(monthStart(new Date(instant))).toBe('2026-07-01')

  setReportingZone('America/New_York')

  expect(epochMsDay(instant)).toBe('2026-06-30')
  expect(dayOf('2026-07-01T02:00:00Z')).toBe('2026-06-30')
  expect(currentMonthKey(new Date(instant))).toBe('2026-06')
  expect(monthStart(new Date(instant))).toBe('2026-06-01')
})
