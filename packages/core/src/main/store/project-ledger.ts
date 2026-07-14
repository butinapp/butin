import { isAccrualBasis } from '@butinapp/sdk/presets'
import { dayOf, round2 } from '@butinapp/sdk/util'
import {
  deriveDailyByRow,
  deriveDailySpend,
  type DailyPoint,
  type DailySource,
  type DatasetLog,
  type Ledger,
  type PresentationManifest,
  type StoredDataset,
  type StoredSummary
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

// The open-period spend reading representing each month, keyed 'YYYY-MM': the LATEST capture in the month. A
// usage accrual resets every billing period, so the newest reading is the current period's running total — the
// best estimate of the month's bill before the provider posts the settled invoice. (The max would be wrong: a
// reading captured at a period boundary, or before a reset that falls mid-month when billing isn't
// calendar-aligned, is a PRIOR period's near-final total that doesn't belong to this month.)
const monthlyAccrualReadings = (led: Ledger): Map<string, number> => {
  const out = new Map<string, { at: string; value: number }>()

  for (const p of seriesPoints(led, 'spend')) {
    const month = p.date.slice(0, 7)
    const prev = out.get(month)

    if (!prev || p.capturedAt > prev.at) {
      out.set(month, { at: p.capturedAt, value: p.value })
    }
  }

  return new Map([...out].map(([month, r]) => [month, r.value]))
}

// Fill a spend chart's missing month bars from the captured accrual readings. A service billing in arrears
// builds its monthly chart from settled invoices, so the just-closed + current months have no bar until the
// provider posts the invoice — often weeks later. The open-period spend captured in the ledger already holds
// those months' totals, so fill each month the invoice history is missing with its latest captured reading.
// Invoice bars stay authoritative (a present month is never overwritten); only absent months are added. No-op unless the result
// carries a spend summary on an accrual basis (a live open-period figure) whose spark points at one of these
// table datasets — a settled 'invoiced'/'lastInvoice' figure is a past bill, not this month's captured spend,
// so projecting it onto a month with no invoice yet would synthesize a phantom bar.
export const backfillAccrualBars = (
  datasets: StoredDataset[],
  summaries: StoredSummary[],
  manifest: PresentationManifest,
  led: Ledger | null
): StoredDataset[] => {
  const spend = summaries.find((s) => s.section === 'spend')
  const spark = spend ? manifest.summaries?.[spend.section]?.spark : undefined

  if (!led || !spark || !isAccrualBasis(spend?.basis)) {
    return datasets
  }

  const readings = monthlyAccrualReadings(led)

  if (readings.size === 0) {
    return datasets
  }

  return datasets.map((ds) => {
    if (ds.id !== spark.dataset || ds.shape !== 'table') {
      return ds
    }

    const present = new Set(ds.rows.map((r) => String(r[spark.x])))
    const added = [...readings]
      .filter(([month]) => !present.has(month))
      .map(([month, value]) => ({ [spark.x]: month, [spark.y]: round2(value) }))

    if (added.length === 0) {
      return ds
    }

    const rows = [...ds.rows, ...added].sort((a, b) => String(a[spark.x]).localeCompare(String(b[spark.x])))

    return { ...ds, rows }
  })
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
