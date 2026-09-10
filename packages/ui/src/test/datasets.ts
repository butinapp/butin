import type { Column, RecordDataset, TableDataset } from '@butinapp/sdk/data'

// Dataset fixtures for the renderer's own tests. The renderer must draw whatever a plugin emits — including
// shapes the typed `table`/`record` builders would refuse to construct — so these build the wire object
// directly. Test-only: a plugin declares its datasets through the SDK builders, never these.

export const tableFixture = (
  id: string,
  columns: Column[],
  rows: Record<string, unknown>[],
  key?: string | string[],
  rollup?: boolean
): TableDataset => ({ id, shape: 'table', columns, rows, ...(key ? { key } : {}), ...(rollup ? { rollup } : {}) })

export const recordFixture = (id: string, fields: Column[], value: Record<string, unknown>): RecordDataset => ({
  id,
  shape: 'record',
  fields,
  value
})
