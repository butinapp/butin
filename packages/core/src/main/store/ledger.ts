import {
  SCHEMA_VERSION,
  latestPerDay,
  type DatasetLog,
  type Ledger,
  type LedgerRow,
  type SectionPoint,
  type StoredDataset,
  type StoredSummary
} from '@butinapp/shapes'

import { readJson, writeJson } from './secure-fs.js'
import { dataRootDir, ledgerPath } from './store.js'

export interface Observation {
  capturedAt: string
  datasets: StoredDataset[]
  summaries: StoredSummary[]
}

const keyParts = (key: string | string[] | undefined): string[] =>
  key === undefined ? [] : Array.isArray(key) ? key : [key]

const rowId = (row: Record<string, unknown>, parts: string[]): string | undefined => {
  const out: string[] = []

  for (const k of parts) {
    const v = row[k]

    if (v === null || v === undefined || v === '') {
      return undefined
    }

    out.push(String(v))
  }

  return out.join('')
}

// Stable structural equality — outer keys are sorted so field ordering can't fake a change. Field VALUES
// are JSON.stringify'd without recursive key sorting, so a nested object whose keys arrive in a different
// order would falsely read as changed; row data in current plugins is flat primitives. Extend to recurse
// if a plugin ever stores nested objects.
const sameData = (a: Record<string, unknown>, b: Record<string, unknown>): boolean => {
  const ak = Object.keys(a).sort()
  const bk = Object.keys(b).sort()

  if (ak.length !== bk.length || ak.some((k, i) => k !== bk[i])) {
    return false
  }

  return ak.every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]))
}

const mergeDatasetLog = (existing: DatasetLog | undefined, ds: StoredDataset, now: string): DatasetLog => {
  const parts = keyParts(ds.key)
  const byId = new Map<string, LedgerRow>(
    (existing?.rows ?? []).map((r) => [r.id, { ...r, versions: r.versions.map((v) => ({ ...v })) }])
  )
  const fetched = new Set<string>()

  for (const row of ds.rows) {
    const id = rowId(row, parts)

    if (id === undefined) {
      continue
    }

    fetched.add(id)
    const prior = byId.get(id)

    if (!prior) {
      byId.set(id, { id, firstSeen: now, seenTo: now, versions: [{ from: now, data: { ...row } }] })
      continue
    }

    const current = prior.versions[prior.versions.length - 1]!

    if (sameData(current.data, row)) {
      prior.seenTo = now
    } else {
      current.to = now
      prior.versions.push({ from: now, data: { ...row } })
      prior.seenTo = now
    }
  }

  let rows = [...byId.values()]

  // A rollup fetch is authoritative for the key-range it covers: drop a retained row at or above the fetch's
  // lowest key that this fetch no longer emits (the bucket moved or was re-dated to another month), keeping only
  // keys BELOW the range — deep history beyond the rolling fetch window. An empty fetch retains everything, so a
  // transient no-data fetch never wipes the series. Append logs (no `rollup`) keep every key ever seen.
  if (ds.rollup && fetched.size > 0) {
    const floor = [...fetched].reduce((lo, id) => (id < lo ? id : lo))

    rows = rows.filter((r) => fetched.has(r.id) || r.id < floor)
  }

  return { id: ds.id, ...(ds.key !== undefined ? { key: ds.key } : {}), columns: ds.columns, rows }
}

// A headline series carries at most one point per UTC day — the day's latest capture (its reading closest to
// day's end), matching how per-day spend is later derived. Repeated same-day fetches replace the day's point
// instead of inflating the trend, and any pre-existing same-day duplicates fold away on the next write. An
// unchanged value across days is kept (a flat day is real information — zero spend — not a redundant row).
const collapseByDay = (points: SectionPoint[]): SectionPoint[] =>
  latestPerDay(
    points,
    (p) => p.capturedAt.slice(0, 10),
    (p) => p.capturedAt
  )

// Fold one fetch into the ledger. Pure — never mutates `existing`. Only keyed table datasets accumulate
// versions; unkeyed datasets carry no history (their latest rows come from current.json, not here). A changed
// row closes its prior version and opens a new one (value history is retained); an unchanged row just advances
// seenTo; an absent key is left untouched (out-of-window rows survive). Each summary records its section's
// point for the day (one point per day; see collapseByDay).
export const appendObservation = (existing: Ledger | undefined, obs: Observation): Ledger => {
  const logs = new Map<string, DatasetLog>((existing?.datasets ?? []).map((d) => [d.id, d]))

  for (const ds of obs.datasets) {
    if (ds.shape !== 'table' || ds.key === undefined) {
      continue
    }

    logs.set(ds.id, mergeDatasetLog(logs.get(ds.id), ds, obs.capturedAt))
  }

  const series = (existing?.series ?? []).map((s) => ({ section: s.section, points: [...s.points] }))
  const bySection = new Map(series.map((s) => [s.section, s]))

  for (const s of obs.summaries) {
    const point = { capturedAt: obs.capturedAt, value: s.value, ...(s.currency ? { currency: s.currency } : {}) }
    const found = bySection.get(s.section)

    if (found) {
      found.points.push(point)
    } else {
      const fresh = { section: s.section, points: [point] }

      bySection.set(s.section, fresh)
      series.push(fresh)
    }
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    datasets: [...logs.values()],
    series: series.map((s) => ({ section: s.section, points: collapseByDay(s.points) }))
  }
}

export const readLedger = async (pluginId: string, capabilityId: string): Promise<Ledger | null> =>
  readJson<Ledger>(dataRootDir(), ledgerPath(pluginId, capabilityId))

// Append one observation to a capability's ledger on disk. Best-effort — warns + never throws into the run.
export const accumulate = async (pluginId: string, capabilityId: string, obs: Observation): Promise<void> => {
  try {
    const next = appendObservation((await readLedger(pluginId, capabilityId)) ?? undefined, obs)

    await writeJson(dataRootDir(), ledgerPath(pluginId, capabilityId), next)
  } catch (err) {
    console.warn(`[butin:ledger] ${pluginId}/${capabilityId}: accumulate failed`, err)
  }
}
