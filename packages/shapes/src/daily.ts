// Pure per-day spend derivation from a cumulative metric series. Shared by core (derives from a capability's
// ledger series) and the UI chart — no Electron, no IO.

import type { ResetPeriod } from '@butinapp/sdk/data'
import { groupBy, maxBy, sortBy } from 'lodash-es'
import { DateTime } from 'luxon'
import { z } from 'zod'

// A derived per-day spend value. `estimated` flags days inferred across a gap (no snapshot that day).
export const DailyPointSchema = z.object({ date: z.string(), value: z.number(), estimated: z.boolean().optional() })
export type DailyPoint = z.infer<typeof DailyPointSchema>

// The minimal shape `deriveDailySpend` needs from a capture point — kept structural so a ledger series point
// satisfies it without a hard dependency. `capturedAt` (full ISO) disambiguates several captures on the same
// day — and several people's captures of the same account.
export type DailySource = { date: string; capturedAt: string; section: string; value: number }

const ym = (date: string): string => date.slice(0, 7)

// Collapse many captures (across times of day, and across people) to one reading per day: the one with the
// latest `instant` — the closest reading to that day's end — sorted chronologically. `dayOf` buckets a point
// to its calendar day; `instant` is the full ISO timestamp that picks the winner and orders the result (ISO
// timestamps sort chronologically, and one-per-day means instant order equals day order).
export const latestPerDay = <T>(points: T[], dayOf: (p: T) => string, instant: (p: T) => string): T[] =>
  sortBy(
    Object.values(groupBy(points, dayOf)).map((perDay) => maxBy(perDay, instant)!),
    instant
  )

const endOfDayPerDay = (points: DailySource[]): DailySource[] =>
  latestPerDay(
    points,
    (p) => p.date,
    (p) => p.capturedAt
  )

// Calendar days strictly after `from` up to and including `to`.
const daysBetween = (from: string, to: string): string[] => {
  const out: string[] = []
  const end = DateTime.fromISO(to, { zone: 'utc' })

  for (let d = DateTime.fromISO(from, { zone: 'utc' }).plus({ days: 1 }); d <= end; d = d.plus({ days: 1 })) {
    out.push(d.toISODate()!)
  }

  return out
}

// Derive per-day spend from a cumulative series. A monthly-resetting counter (MTD) attributes a month
// rollover's new value as-is instead of a negative diff. `resetPeriod` states this explicitly; absent, it
// falls back to sniffing the 'spend' section. Gaps spread evenly, flagged estimated.
export const deriveDailySpend = (points: DailySource[], resetPeriod?: ResetPeriod): DailyPoint[] => {
  const sorted = endOfDayPerDay(points)
  const resetsMonthly = resetPeriod ? resetPeriod === 'monthly' : sorted[0]?.section === 'spend'
  const out: DailyPoint[] = []

  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i]!
    const prev = sorted[i - 1]

    if (!prev) {
      // A lone first-of-month point: MTD on day 1 IS that day's spend. Otherwise we can't diff.
      if (resetsMonthly && cur.date.endsWith('-01')) {
        out.push({ date: cur.date, value: cur.value })
      }

      continue
    }

    if (resetsMonthly && ym(cur.date) !== ym(prev.date)) {
      out.push({ date: cur.date, value: cur.value })
      continue
    }

    const gap = daysBetween(prev.date, cur.date)
    const delta = cur.value - prev.value

    if (gap.length <= 1) {
      out.push({ date: cur.date, value: delta })
      continue
    }

    const per = delta / gap.length

    for (const date of gap) {
      out.push({ date, value: per, estimated: true })
    }
  }

  return out
}

// Derive a per-day series for each row of a keyed cumulative column: differences that row's reading series
// independently. The row id keys both the input and the output.
export const deriveDailyByRow = (
  readingsByRow: Record<string, DailySource[]>,
  resetPeriod?: ResetPeriod
): Record<string, DailyPoint[]> => {
  const out: Record<string, DailyPoint[]> = {}

  for (const [rowId, points] of Object.entries(readingsByRow)) {
    out[rowId] = deriveDailySpend(points, resetPeriod)
  }

  return out
}

// Sum several services' per-day series into one combined series, keyed by date. A day is `estimated` in the
// combined series if ANY contributing service estimated it (the total carries that day's uncertainty).
export const combineDailySpend = (series: DailyPoint[][]): DailyPoint[] =>
  sortBy(
    Object.values(groupBy(series.flat(), (p) => p.date)).map((perDate) => ({
      date: perDate[0]!.date,
      value: perDate.reduce((sum, p) => sum + p.value, 0),
      estimated: perDate.some((p) => p.estimated) || undefined
    })),
    (p) => p.date
  )
