import type { SemanticRole, Section } from '@butinapp/sdk/data'
import type { MtdBasis } from '@butinapp/sdk/presets'

// Bumped on any change to roles/sections/ledger semantics. Stamped on each ledger + bundle; gateway reads it to
// pick an ingest parser. There is no on-disk migrator (history is erased on the cutover that introduces this).
export const SCHEMA_VERSION = 1

// A column in the stored, data-first form — only facts about the value (no label/badges/hidden; those are
// presentation, carried by the manifest).
export interface StoredColumn {
  key: string
  role: SemanticRole
  currency?: string
  accrual?: 'cumulative' | 'incremental'
  resetPeriod?: 'monthly' | 'none'
}

export interface StoredDataset {
  id: string
  shape: 'table' | 'record'
  columns: StoredColumn[]
  rows: Record<string, unknown>[]
  key?: string | string[]
  // A keyed table that is a re-derived rollup (monthly spend), not an append log: on accumulation a fetch is
  // authoritative for the key-range it covers. See the SDK's TableDataset.rollup.
  rollup?: boolean
}

export interface StoredSummary {
  section: Section
  value: number
  role: 'money' | 'count' | 'percent'
  currency?: string
  basis?: MtdBasis
}

// One value of one row, valid over [from, to). The newest version of a row has no `to`.
export interface RowVersion {
  from: string
  to?: string
  data: Record<string, unknown>
}

// A row's full version history + presence window. firstSeen = first capture; seenTo = last fetch the key
// appeared in (drives "gone since").
export interface LedgerRow {
  id: string
  firstSeen: string
  seenTo: string
  versions: RowVersion[]
}

export interface DatasetLog {
  id: string
  key?: string | string[]
  columns: StoredColumn[]
  rows: LedgerRow[]
}

// Per-section headline history — at most one point per UTC day (the day's latest capture).
export interface SectionPoint {
  capturedAt: string
  value: number
  currency?: string
}

export interface SectionSeries {
  section: Section
  points: SectionPoint[]
}

// The on-disk ledger for one capability: the sole source of truth.
export interface Ledger {
  schemaVersion: number
  datasets: DatasetLog[]
  series: SectionSeries[]
}
