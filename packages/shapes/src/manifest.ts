import type {
  BadgeTone,
  CapabilityResult,
  Column,
  Dataset,
  RecordDataset,
  Summary,
  TableDataset,
  View
} from '@butinapp/sdk/data'
import { omitUndef } from '@butinapp/sdk/util'

import type { StoredColumn, StoredDataset, StoredSummary } from './ledger.js'

export type ColumnPresentation = {
  label?: string
  badges?: Record<string, BadgeTone>
  hidden?: boolean
  truncate?: boolean
}

export type SummaryPresentation = {
  label?: string
  spark?: { dataset: string; x: string; y: string }
}

// How to draw a capability's data. Re-derived from plugin code per render; bundled on export. Never stored
// next to the ledger (so old data renders with today's UI).
export type PresentationManifest = {
  views: View[]
  columns?: Record<string, Record<string, ColumnPresentation>>
  summaries?: Record<string, SummaryPresentation>
}

const storedColumn = (c: Column): StoredColumn =>
  omitUndef({ key: c.key, role: c.role, currency: c.currency, accrual: c.accrual, resetPeriod: c.resetPeriod })

const columnPresentation = (c: Column): ColumnPresentation | undefined => {
  const p = omitUndef({ label: c.label, badges: c.badges, hidden: c.hidden, truncate: c.truncate })

  return Object.keys(p).length > 0 ? p : undefined
}

const storedDataset = (ds: Dataset): StoredDataset => {
  if (ds.shape === 'table') {
    const out: StoredDataset = { id: ds.id, shape: 'table', columns: ds.columns.map(storedColumn), rows: ds.rows }

    if (ds.key !== undefined) {
      out.key = ds.key
    }

    if (ds.retention) {
      out.retention = ds.retention
    }

    return out
  }

  return { id: ds.id, shape: 'record', columns: ds.fields.map(storedColumn), rows: [ds.value] }
}

const storedSummary = (s: Summary): StoredSummary =>
  omitUndef({ section: s.section, value: s.value, role: s.role, currency: s.currency, basis: s.basis })

// Separate a CapabilityResult into the data-first records + summaries that land in the ledger, and the
// presentation manifest that's re-derived at render. Pure.
export const splitResult = (
  result: CapabilityResult
): { datasets: StoredDataset[]; summaries: StoredSummary[]; manifest: PresentationManifest } => {
  const columns: Record<string, Record<string, ColumnPresentation>> = {}

  for (const ds of result.datasets) {
    const cols = ds.shape === 'table' ? ds.columns : ds.fields
    const byKey: Record<string, ColumnPresentation> = {}

    for (const c of cols) {
      const p = columnPresentation(c)

      if (p) {
        byKey[c.key] = p
      }
    }

    if (Object.keys(byKey).length > 0) {
      columns[ds.id] = byKey
    }
  }

  const summaryMap: Record<string, SummaryPresentation> = {}

  for (const s of result.summaries ?? []) {
    summaryMap[s.section] = omitUndef({ label: s.label, spark: s.spark })
  }

  return {
    datasets: result.datasets.map(storedDataset),
    summaries: (result.summaries ?? []).map(storedSummary),
    manifest: omitUndef({
      views: result.views ?? [],
      columns: Object.keys(columns).length > 0 ? columns : undefined,
      summaries: Object.keys(summaryMap).length > 0 ? summaryMap : undefined
    })
  }
}

const displayColumn = (c: StoredColumn, pres?: ColumnPresentation): Column =>
  omitUndef({
    key: c.key,
    label: pres?.label ?? c.key,
    role: c.role,
    currency: c.currency,
    accrual: c.accrual,
    resetPeriod: c.resetPeriod,
    badges: pres?.badges,
    hidden: pres?.hidden,
    truncate: pres?.truncate
  }) as Column

// Rebuild a full CapabilityResult from the stored data-first records + the presentation manifest. The inverse
// of splitResult: column labels/badges/hidden and summary label/spark come back from the manifest; views are
// the manifest's. A column with no manifest entry falls back to its key as the label.
export const toDisplayResult = (
  datasets: StoredDataset[],
  summaries: StoredSummary[],
  manifest: PresentationManifest
): CapabilityResult => {
  const displayDatasets: Dataset[] = datasets.map((ds) => {
    const pres = manifest.columns?.[ds.id] ?? {}
    const cols = ds.columns.map((c) => displayColumn(c, pres[c.key]))

    if (ds.shape === 'table') {
      const t: TableDataset = {
        id: ds.id,
        shape: 'table',
        columns: cols,
        rows: ds.rows,
        ...(ds.key !== undefined ? { key: ds.key } : {})
      }

      return t
    }

    const r: RecordDataset = { id: ds.id, shape: 'record', fields: cols, value: ds.rows[0] ?? {} }

    return r
  })

  const displaySummaries: Summary[] = summaries.map((s) => {
    const pres = manifest.summaries?.[s.section]

    return omitUndef({
      section: s.section,
      label: pres?.label ?? s.section,
      value: s.value,
      role: s.role,
      currency: s.currency,
      basis: s.basis,
      spark: pres?.spark
    }) as Summary
  })

  return omitUndef({
    datasets: displayDatasets,
    views: manifest.views,
    summaries: displaySummaries.length > 0 ? displaySummaries : undefined
  }) as CapabilityResult
}
