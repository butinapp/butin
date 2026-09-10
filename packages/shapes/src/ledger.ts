import type { Retention, SemanticRole, Section } from '@butinapp/sdk/data'
import type { MtdBasis } from '@butinapp/sdk/presets'

// Bumped on any change to roles/sections/ledger semantics. Stamped on each ledger + bundle; gateway reads it to
// pick an ingest parser. There is no on-disk migrator (history is erased on the cutover that introduces this).
export const SCHEMA_VERSION = 1

// A column in the stored, data-first form — only facts about the value (no label/badges/hidden; those are
// presentation, carried by the manifest).
export type StoredColumn = {
  key: string
  role: SemanticRole
  currency?: string
  accrual?: 'cumulative' | 'incremental'
  resetPeriod?: 'monthly' | 'none'
}

export type StoredDataset = {
  id: string
  shape: 'table' | 'record'
  columns: StoredColumn[]
  rows: Record<string, unknown>[]
  key?: string | string[]
  // How a keyed table's rows are retained across fetches ('rollup' | 'snapshot'; absent → append log). See the
  // SDK's TableDataset.retention.
  retention?: Retention
}

export type StoredSummary = {
  section: Section
  value: number
  role: 'money' | 'count' | 'percent'
  currency?: string
  basis?: MtdBasis
}

// One value of one row, valid over [from, to). The newest version of a row has no `to`.
export type RowVersion = {
  from: string
  to?: string
  data: Record<string, unknown>
}

// A row's full version history + presence window. firstSeen = first capture; seenTo = last fetch the key
// appeared in (drives "gone since").
export type LedgerRow = {
  id: string
  firstSeen: string
  seenTo: string
  versions: RowVersion[]
}

export type DatasetLog = {
  id: string
  key?: string | string[]
  columns: StoredColumn[]
  rows: LedgerRow[]
  // Carried from the dataset so the log is self-describing: a projection can tell an append log from a
  // snapshot without the fetch that produced it.
  retention?: Retention
  // The last fetch that carried rows for this log. A snapshot row whose `seenTo` predates it was absent from
  // that fetch — departed. An empty fetch never advances it, so a transient no-data fetch departs nobody.
  lastFetchedAt?: string
}

// Per-section headline history — at most one point per UTC day (the day's latest capture).
export type SectionPoint = {
  capturedAt: string
  value: number
  currency?: string
}

export type SectionSeries = {
  section: Section
  points: SectionPoint[]
}

// The on-disk ledger for one capability: the sole source of truth.
export type Ledger = {
  schemaVersion: number
  datasets: DatasetLog[]
  series: SectionSeries[]
}
