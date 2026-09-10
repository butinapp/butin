// Turn ONE snapshot (datasets + summaries, post-splitResult) into a deterministic time-series: one Observation
// per simulated capture day. Works only off semantic-role-typed columns — zero per-plugin knowledge. The newest
// day equals the snapshot; history walks backward from it so the latest `current` matches what the plugin emits.

import { MS_PER_DAY, round2 } from '@butinapp/sdk/util'
import type { StoredColumn, StoredDataset, StoredSummary } from '@butinapp/shapes'
import { DateTime } from 'luxon'

import type { Observation } from '../../main/store/ledger.js'

import { seeded } from './prng.js'

export type EvolveOptions = {
  now: string // ISO instant of the newest capture
  days: number // simulated capture days (inclusive of `now`)
  window: number // data-intrinsic history span (days) — rows carry their own dates; reserved for callers
  // A capture day (YYYY-MM-DD) the contributor missed: no observation is emitted, leaving a real hole in the
  // ledger. Solo, deriveDailySpend spreads the gap (estimated); merged, a peer's same-day capture backfills it.
  skipDay?: (day: string) => boolean
}

const dayKey = (iso: string): string => iso.slice(0, 10)
const monthKey = (day: string): string => day.slice(0, 7)
const domOf = (day: string): number => Number(day.slice(8, 10))
// Days in the month of `day` ('YYYY-MM-DD').
const daysInMonth = (day: string): number => DateTime.fromISO(day, { zone: 'utc' }).daysInMonth!

// The capture instant `back` whole days before `now`, snapped to noon UTC so a day has one stable timestamp.
const dayInstant = (now: string, back: number): string => {
  const d = new Date(new Date(now).getTime() - back * MS_PER_DAY)

  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12)).toISOString()
}

// A month-to-date reading on `captureDay`, anchored so the newest day equals `newest`. Within a month it's a
// monotonic ramp of deterministic positive daily increments; each calendar month restarts from ~0. Differencing
// consecutive readings (deriveDaily*) recovers clean positive daily usage, and the month boundary resets cleanly
// — no negative days, no boundary spike. A past month peaks a bit below the current MTD.
const mtdReading = (newest: number, captureDay: string, newestDay: string, seed: string): number => {
  if (!Number.isFinite(newest) || newest <= 0) {
    return Math.max(0, round2(newest))
  }

  const month = monthKey(captureDay)
  const current = month === monthKey(newestDay)
  const anchorDom = current ? domOf(newestDay) : daysInMonth(captureDay)
  const anchorVal = current ? newest : round2(newest * 0.82)
  const dom = Math.min(domOf(captureDay), anchorDom)

  let total = 0
  let upto = 0

  for (let k = 1; k <= anchorDom; k++) {
    total += 0.5 + seeded(seed, month, k)()

    if (k <= dom) {
      upto = total
    }
  }

  return total > 0 ? round2(anchorVal * (upto / total)) : 0
}

// A bounded walk for a plain level (balance, count, price, a current-period total): the value `back` days older
// than `newest`. Each step's factor is fixed by its index (seeded by i, NOT by back), so value(back) = newest ·
// Πfactor is consistent across calls and never rises going back — day-to-day diffs toward now stay non-negative.
const walkBack = (role: StoredColumn['role'], newest: number, back: number, seed: string): number => {
  if (back <= 0 || !Number.isFinite(newest)) {
    return newest
  }

  if (role === 'percent') {
    let v = newest

    for (let i = 1; i <= back; i++) {
      v -= (seeded(seed, i)() - 0.4) * 1.3 // mild downward drift going back, bounded below
    }

    return Math.max(0, Math.min(100, Math.round(v)))
  }

  let v = newest

  for (let i = 1; i <= back; i++) {
    v *= 1 - (0.004 + seeded(seed, i)() * 0.026)
  }

  v = Math.max(0, v)

  return role === 'count' ? Math.round(v) : round2(v)
}

// A row's date column value (first timestamp-role column), or null when none — used to gate inventory arrival.
const rowDate = (cols: StoredColumn[], row: Record<string, unknown>): string | null => {
  const ts = cols.find((c) => c.role === 'timestamp')

  return ts && typeof row[ts.key] === 'string' ? dayKey(row[ts.key] as string) : null
}

const numericCols = (cols: StoredColumn[]): StoredColumn[] =>
  cols.filter((c) => c.role === 'money' || c.role === 'count' || c.role === 'percent')

const isMonthlyCumulative = (c: StoredColumn): boolean => c.accrual === 'cumulative' && c.resetPeriod === 'monthly'

// Evolve one row's numeric cells for the capture day `back` days before `newestDay`. A monthly-cumulative column
// (a member's MTD spend) is an MTD ramp; every other numeric cell is a bounded level walk. Identity/label/url/
// status cells pass through unchanged (identity columns MUST stay fixed to preserve ledger keying).
const evolveRow = (
  dsId: string,
  cols: StoredColumn[],
  row: Record<string, unknown>,
  rowId: string,
  back: number,
  captureDay: string,
  newestDay: string,
  baseSeed: string
): Record<string, unknown> => {
  const out = { ...row }

  for (const c of numericCols(cols)) {
    const newest = Number(row[c.key])

    if (!Number.isFinite(newest)) {
      continue
    }

    const seed = [baseSeed, dsId, rowId, c.key].join(':')

    out[c.key] = isMonthlyCumulative(c)
      ? mtdReading(newest, captureDay, newestDay, seed)
      : walkBack(c.role, newest, back, seed)
  }

  return out
}

// Is this dataset a keyed time-bucket series (its single key column is a timestamp, e.g. `monthly`)?
const isSeries = (ds: StoredDataset): boolean =>
  ds.shape === 'table' && typeof ds.key === 'string' && ds.columns.find((c) => c.key === ds.key)?.role === 'timestamp'

// The single-column key value of a row (inventory id / series bucket), or null when unkeyed.
const keyOf = (ds: StoredDataset, row: Record<string, unknown>): string | null =>
  typeof ds.key === 'string' && row[ds.key] != null ? String(row[ds.key]) : null

// One dataset's rows as-of a capture day `back` days before now.
const datasetForDay = (
  ds: StoredDataset,
  back: number,
  captureDay: string,
  newestDay: string,
  seed: string
): StoredDataset => {
  // Unkeyed tables + records don't accumulate in the ledger — they render from the latest snapshot. Carry the
  // base rows on every day (they only matter on the newest day, which is the snapshot).
  if (ds.shape !== 'table' || ds.key === undefined) {
    return ds
  }

  if (isSeries(ds)) {
    // A time-bucket series: a bucket whose month/date is after the capture day hasn't happened yet. Past buckets
    // are FIXED (a prior month's spend doesn't change); only the latest (current-period) bucket evolves.
    const newestBucket = ds.rows.reduce((m, r) => (keyOf(ds, r)! > m ? keyOf(ds, r)! : m), '')
    const rows = ds.rows
      .filter((r) => keyOf(ds, r)! <= captureDay.slice(0, keyOf(ds, r)!.length))
      .map((r) =>
        keyOf(ds, r) === newestBucket
          ? evolveRow(ds.id, ds.columns, r, keyOf(ds, r)!, back, captureDay, newestDay, seed)
          : r
      )

    return { ...ds, rows }
  }

  // Inventory (keyed on a non-timestamp id): a row appears only on/after its date column; its numeric cells walk.
  const rows = ds.rows
    .filter((r) => {
      const d = rowDate(ds.columns, r)

      return d === null || d <= captureDay
    })
    .map((r) => evolveRow(ds.id, ds.columns, r, keyOf(ds, r) ?? '', back, captureDay, newestDay, seed))

  return { ...ds, rows }
}

const MONTH_KEY = /^\d{4}-\d{2}$/
const prevMonthKey = (m: string): string =>
  DateTime.fromFormat(m, 'yyyy-MM', { zone: 'utc' }).minus({ months: 1 }).toFormat('yyyy-MM')

// A series row's identity from its non-numeric cells (a stacked series' category), so each category's
// backfilled months walk on their own deterministic seed instead of sharing one.
const rowSignature = (cols: StoredColumn[], keyCol: string, row: Record<string, unknown>): string =>
  cols
    .filter((c) => c.key !== keyCol && c.role !== 'money' && c.role !== 'count' && c.role !== 'percent')
    .map((c) => String(row[c.key] ?? ''))
    .join('|')

// Extend a MONTHLY money/count series backward to `targetMonths` total months so the demo's cross-service
// columns are uniformly dense rather than ragged. Older months clone the oldest real month (carrying any
// stacked categories) with their numeric cells walked gently downward into the past; the newest month and
// every existing bucket are untouched. A non-series dataset, a day-keyed series, or one already at the target
// is returned unchanged. Demo-seed only, zero per-plugin knowledge.
export const backfillMonthlySeries = (ds: StoredDataset, baseSeed: string, targetMonths: number): StoredDataset => {
  if (!isSeries(ds) || typeof ds.key !== 'string') {
    return ds
  }

  const keyCol = ds.key
  const numeric = numericCols(ds.columns)
  const keys = ds.rows.map((r) => String(r[keyCol]))

  if (numeric.length === 0 || keys.length === 0 || !keys.every((k) => MONTH_KEY.test(k))) {
    return ds
  }

  const months = [...new Set(keys)].sort()

  if (months.length >= targetMonths) {
    return ds
  }

  const template = ds.rows.filter((r) => String(r[keyCol]) === months[0])
  const added: Record<string, unknown>[] = []
  let month = months[0]!

  for (let back = 1; months.length + back <= targetMonths; back++) {
    month = prevMonthKey(month)

    for (const tpl of template) {
      const row: Record<string, unknown> = { ...tpl, [keyCol]: month }

      for (const c of numeric) {
        const newest = Number(tpl[c.key])

        if (Number.isFinite(newest)) {
          row[c.key] = walkBack(
            c.role,
            newest,
            back,
            [baseSeed, ds.id, rowSignature(ds.columns, keyCol, tpl), c.key].join(':')
          )
        }
      }

      added.push(row)
    }
  }

  return { ...ds, rows: [...added.reverse(), ...ds.rows] }
}

export const evolveObservations = (
  base: { datasets: StoredDataset[]; summaries: StoredSummary[] },
  opts: EvolveOptions,
  baseSeed: string
): Observation[] => {
  const out: Observation[] = []
  const newestDay = dayKey(opts.now)

  // Oldest first: back = days-1 … 0 (0 = now). back 0 reproduces the snapshot exactly.
  for (let back = opts.days - 1; back >= 0; back--) {
    const capturedAt = dayInstant(opts.now, back)
    const captureDay = dayKey(capturedAt)

    if (opts.skipDay?.(captureDay)) {
      continue
    }

    out.push({
      capturedAt,
      datasets: base.datasets.map((ds) => datasetForDay(ds, back, captureDay, newestDay, baseSeed)),
      summaries: base.summaries.map((s) => {
        const seed = [baseSeed, 'summary', s.section].join(':')

        // The spend section is a month-to-date accumulator (resets on the 1st) — evolved as an MTD ramp so its
        // per-day derivation is clean positive usage with a clean month boundary, not a differenced level.
        return {
          ...s,
          value:
            s.section === 'spend'
              ? mtdReading(s.value, captureDay, newestDay, seed)
              : walkBack(s.role, s.value, back, seed)
        }
      })
    })
  }

  return out
}
