import { z } from 'zod'

// The semantic role tells the renderer what a column MEANS (money → formatUsd, timestamp → chart axis,
// status → sentiment badge, category → distinct-hue badge, url → link) and lets cross-service rollups find
// comparable fields. The two badge roles split by intent: `status` carries SENTIMENT (active is good, failed
// is bad) — the renderer auto-tones a known vocabulary; `category` carries NO sentiment (a member role, a
// seat tier) — the renderer assigns each value a stable distinct hue. `label` is plain text.
export const SemanticRoleSchema = z.enum([
  'money',
  'count',
  'percent',
  'timestamp',
  'status',
  'category',
  'label',
  'identifier',
  'url',
  'text'
])
export type SemanticRole = z.infer<typeof SemanticRoleSchema>

// The sentiment a status value carries. This is MEANING, not color — the renderer maps each to a themed
// badge variant. A plugin declares a tone only to override or extend what the renderer already infers from a
// status value (categorical coloring for role:'category' values is automatic — the plugin picks no color).
export const BadgeToneSchema = z.enum(['neutral', 'success', 'warning', 'danger', 'info'])
export type BadgeTone = z.infer<typeof BadgeToneSchema>

// How a column's value accrues over time. 'cumulative' is a counter that resets each `resetPeriod` (an MTD
// total) — core keeps a per-row daily reading series and differences it into a daily breakdown. 'incremental'
// (the default) is a point-in-time/period amount kept verbatim.
export const AccrualSchema = z.enum(['cumulative', 'incremental'])
export type Accrual = z.infer<typeof AccrualSchema>

export const ResetPeriodSchema = z.enum(['monthly', 'none'])
export type ResetPeriod = z.infer<typeof ResetPeriodSchema>

export const ColumnSchema = z.object({
  key: z.string(),
  label: z.string().optional(),
  role: SemanticRoleSchema,
  currency: z.string().optional(),
  // value (matched case-insensitively) → sentiment tone, OVERRIDING the renderer's inferred tone for a
  // role:'status' column. Only needed for values the renderer can't infer (service-specific or non-English
  // statuses); common ones (active/paid/failed/…) auto-tone with no map. Ignored for other roles.
  badges: z.record(z.string(), BadgeToneSchema).optional(),
  accrual: AccrualSchema.optional(),
  resetPeriod: ResetPeriodSchema.optional(),
  // Cap a long free-text column to one ellipsized line so it stops absorbing the row's slack and squashing
  // its neighbours. The full value stays reachable: a hover peek (native title) plus a click-to-open popover
  // with the selectable, copyable text. Opt-in per column; only meaningful for free-text roles (label/text).
  truncate: z.boolean().optional(),
  // Declared but not for display: a row field the table carries for machinery (accumulation key, download
  // filename, fetchFile payload) rather than for showing in the table body.
  hidden: z.boolean().optional()
})
export type Column = z.infer<typeof ColumnSchema>

export const TableDatasetSchema = z.object({
  id: z.string(),
  shape: z.literal('table'),
  columns: z.array(ColumnSchema),
  rows: z.array(z.record(z.string(), z.unknown())),
  // Column(s) forming a row's stable identity across fetches. Its presence opts the table into accumulation
  // (rows merge into a kept union instead of overwriting); an array is a composite key. Absent → latest-only.
  key: z.union([z.string(), z.array(z.string())]).optional(),
  // Marks a keyed table as a re-derived ROLLUP (e.g. monthly spend), not an append log. On accumulation the
  // fetch is authoritative for the key-range it covers: a retained row at or above the fetch's LOWEST key that
  // the fetch no longer emits is dropped (the bucket moved or was re-dated), while keys BELOW that range
  // persist (deep history beyond the rolling fetch window). Requires a sortable `key` (a 'YYYY-MM' month, an
  // ISO day). Absent → an append log, where every key ever seen is retained.
  rollup: z.boolean().optional()
})
export type TableDataset = z.infer<typeof TableDatasetSchema>

export const RecordDatasetSchema = z.object({
  id: z.string(),
  shape: z.literal('record'),
  fields: z.array(ColumnSchema),
  value: z.record(z.string(), z.unknown())
})
export type RecordDataset = z.infer<typeof RecordDatasetSchema>

// Two structural primitives; a series is a table with a timestamp column, a stat is a record field.
export const DatasetSchema = z.discriminatedUnion('shape', [TableDatasetSchema, RecordDatasetSchema])
export type Dataset = z.infer<typeof DatasetSchema>

export const rawTable = (
  id: string,
  columns: Column[],
  rows: Record<string, unknown>[],
  key?: string | string[],
  rollup?: boolean
): TableDataset => ({ id, shape: 'table', columns, rows, ...(key ? { key } : {}), ...(rollup ? { rollup } : {}) })

export const rawRecord = (id: string, fields: Column[], value: Record<string, unknown>): RecordDataset => ({
  id,
  shape: 'record',
  fields,
  value
})
