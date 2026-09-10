import type { DailyPoint } from '@butinapp/shapes'
import { groupBy, sortBy, sumBy } from 'lodash-es'
import { DateTime } from 'luxon'

import type { AlertWindow } from '../../shared/ipc.js'

export type PeriodPair = {
  prev: number
  curr: number
  periodId: string
}

// ISO-8601 week key 'YYYY-Www' (weeks start Monday; the week belongs to the year of its Thursday — `kkkk` is
// the ISO week-year, which can differ from the calendar year in late December / early January).
const isoWeekKey = (date: Date): string => DateTime.fromJSDate(date, { zone: 'utc' }).toFormat("kkkk-'W'WW")

// The bucket key a date falls in for a window. Day/month keys are date-string slices; week is the ISO key.
const keyOf = (window: AlertWindow, date: Date): string =>
  window === 'dod'
    ? date.toISOString().slice(0, 10)
    : window === 'mom'
      ? date.toISOString().slice(0, 7)
      : isoWeekKey(date)

// Sum a per-day series into completed-period buckets and return the last two that close strictly before
// `now`'s period (the in-progress period is excluded). null when fewer than two complete buckets exist.
export const periodPair = (daily: DailyPoint[], window: AlertWindow, now: Date): PeriodPair | null => {
  const buckets = groupBy(daily, (p) => keyOf(window, new Date(`${p.date}T00:00:00Z`)))
  const currentKey = keyOf(window, now)
  const completed = sortBy(
    Object.entries(buckets).filter(([k]) => k < currentKey),
    ([k]) => k
  )

  if (completed.length < 2) {
    return null
  }

  const [, prevPoints] = completed[completed.length - 2]!
  const [periodId, currPoints] = completed[completed.length - 1]!

  return { prev: sumBy(prevPoints, (p) => p.value), curr: sumBy(currPoints, (p) => p.value), periodId }
}
