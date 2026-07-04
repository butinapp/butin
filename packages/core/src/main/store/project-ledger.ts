import { dayOf } from '@butinapp/sdk/util'
import {
  deriveDailyByRow,
  deriveDailySpend,
  type DailyPoint,
  type DailySource,
  type DatasetLog,
  type Ledger
} from '@butinapp/shapes'

// The open (newest) version's data for a ledger row.
const newest = (versions: DatasetLog['rows'][number]['versions']): Record<string, unknown> =>
  versions[versions.length - 1]!.data

// Latest projection per dataset: each row's newest version. Keyed by dataset id.
export const projectCurrent = (led: Ledger): Map<string, { id: string; rows: Record<string, unknown>[] }> => {
  const out = new Map<string, { id: string; rows: Record<string, unknown>[] }>()

  for (const d of led.datasets) {
    out.set(d.id, { id: d.id, rows: d.rows.map((r) => ({ ...newest(r.versions) })) })
  }

  return out
}

// Union projection: every row ever seen (newest seenTo first), stamped with presence metadata. A row whose
// seenTo predates the latest fetch is flagged `__gone` with the date it was last seen.
export const projectUnion = (
  led: Ledger,
  latestFetch: string
): Map<string, { id: string; rows: Record<string, unknown>[] }> => {
  const out = new Map<string, { id: string; rows: Record<string, unknown>[] }>()

  for (const d of led.datasets) {
    const rows = [...d.rows]
      .sort((a, b) => b.seenTo.localeCompare(a.seenTo))
      .map((r) => ({
        ...newest(r.versions),
        __firstSeen: r.firstSeen,
        __lastSeen: r.seenTo,
        ...(r.seenTo < latestFetch ? { __gone: r.seenTo } : {})
      }))

    out.set(d.id, { id: d.id, rows })
  }

  return out
}

// A section's headline history reshaped to DailySource for deriveDailySpend (date = the capture's day).
export const seriesPoints = (led: Ledger, section: string): DailySource[] => {
  const s = led.series.find((x) => x.section === section)

  if (!s) {
    return []
  }

  // Bucket each reading to its day in the reporting zone (capturedAt is a UTC instant), so the per-day series
  // and the current-month peak agree with the rest of the app on where a day/month boundary sits.
  return s.points.map((p) => ({
    date: dayOf(p.capturedAt) ?? p.capturedAt.slice(0, 10),
    capturedAt: p.capturedAt,
    section,
    value: p.value
  }))
}

// The capability's headline capture history, oldest→newest, for the Settings inventory trend: the spend
// series if present, else the first recorded series. [] when the ledger holds no series at all.
export const primarySeries = (led: Ledger): number[] => {
  const series = led.series.find((s) => s.section === 'spend') ?? led.series[0]

  return series ? series.points.map((p) => p.value) : []
}

// Derive a capability's per-day spend straight from its ledger: find the spend headline series and difference
// it via deriveDailySpend. [] when the ledger holds no spend series (a non-monetary capability).
export const dailySpend = (led: Ledger): DailyPoint[] =>
  led.series.some((s) => s.section === 'spend') ? deriveDailySpend(seriesPoints(led, 'spend')) : []

// Per-row daily series for a cumulative column: each row's version readings (from-day, value) differenced via
// deriveDailyByRow. Rows with no finite reading are omitted.
export const dailyByColumn = (
  log: DatasetLog,
  columnKey: string,
  resetPeriod?: 'monthly' | 'none'
): Record<string, DailyPoint[]> => {
  const readingsByRow: Record<string, DailySource[]> = {}

  for (const row of log.rows) {
    const series: DailySource[] = []

    for (const v of row.versions) {
      const value = Number(v.data[columnKey])

      if (!Number.isFinite(value)) {
        continue
      }

      series.push({ date: v.from.slice(0, 10), capturedAt: v.from, section: '', value })
    }

    if (series.length > 0) {
      readingsByRow[row.id] = series
    }
  }

  return deriveDailyByRow(readingsByRow, resetPeriod)
}
