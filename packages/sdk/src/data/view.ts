import { z } from 'zod'

// Byte source for a downloadable table's rows: a per-row url column (the host GETs it) OR the capability's
// fetchFile(ctx,row) hook (POST/multi-step downloads). Exactly one.
export const FileSourceSchema = z.union([z.object({ url: z.string() }), z.object({ fetch: z.literal(true) })])
export type FileSource = z.infer<typeof FileSourceSchema>

// Marks a table's rows as downloadable files. Presentation only — the renderer adds selection + a Size column
// + per-row View/Open. Download-transport knobs (referer/concurrency) live on the plugin's transport download
// config, not here.
export const TableFilesSchema = z.object({
  name: z.string().optional(), // row field naming each file
  source: FileSourceSchema,
  ext: z.string().optional(),
  category: z.string().optional(), // literal subfolder for all of the table's files
  folder: z.string().optional() // per-row subfolder column (overrides category)
})
export type TableFiles = z.infer<typeof TableFilesSchema>

// Normalize a TableFiles descriptor (`source`/`name`/`folder`) to the flat accessor keys the renderer + the
// download path read. `useFetch` true means the byte source is the capability's fetchFile hook (no url column).
export const resolveTableFiles = (
  f: TableFiles
): { urlKey?: string; nameKey?: string; folderKey?: string; ext?: string; category?: string; useFetch: boolean } => ({
  urlKey: 'url' in f.source ? f.source.url : undefined,
  nameKey: f.name,
  folderKey: f.folder,
  ext: f.ext,
  category: f.category,
  useFetch: 'fetch' in f.source
})

// How a stat value is tinted: 'positive' (green), 'negative' (red), 'muted' (dimmed).
export type StatTone = 'positive' | 'negative' | 'muted'
const STAT_TONES = ['positive', 'negative', 'muted'] as const satisfies readonly StatTone[]

// Per-field presentation for a stat card, beyond the bare value the column's role formats. All optional and
// all literals (collect() runs per fetch with live data, and the view round-trips through the manifest), so a
// plugin computes them at build time. `max` renders `value / max` + a progress bar (value/max); `unit` is a
// muted suffix (e.g. '/mo'); `caption` is a subtext/breakdown line; `tone` tints the value.
export const StatFieldSchema = z.object({
  key: z.string(),
  max: z.number().optional(),
  unit: z.string().optional(),
  caption: z.string().optional(),
  tone: z.enum(STAT_TONES).optional()
})
export type StatField = z.infer<typeof StatFieldSchema>

// A view binds a dataset (by id) to a generic renderer. Adding a view = adding a descriptor.
export const ViewSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('stat'),
    dataset: z.string(),
    // A bare key shows the field's value as-is; a StatField adds denominator/progress, caption, unit, or tone.
    fields: z.array(z.union([z.string(), StatFieldSchema])).optional(),
    title: z.string().optional()
  }),
  z.object({
    type: z.literal('timeseries'),
    dataset: z.string(),
    x: z.string(),
    y: z.string(),
    // Declared cadence of the series, so the renderer picks the chart (monthly spend vs daily trend) from
    // intent rather than sniffing the x-axis label format.
    granularity: z.enum(['monthly', 'daily']).optional(),
    // A category column → a stacked breakdown chart: rows are long-format (each carries x, this category, and
    // y), one stacked series per distinct category, with a legend. Absent → a single-series chart.
    stackBy: z.string().optional(),
    title: z.string().optional()
  }),
  z.object({
    type: z.literal('table'),
    dataset: z.string(),
    columns: z.array(z.string()).optional(),
    title: z.string().optional(),
    // A column key → collapsible grouped sections (per-group select-all + Download).
    groupBy: z.string().optional(),
    files: TableFilesSchema.optional(),
    // Expand each row into a nested table drawn from another (table) dataset in the result, joined on a field
    // present on both sides: a parent row R shows the child rows where child[on] === R[on]. The child renders
    // with its own column roles. This is the static-child-table expansion — distinct from the built-in daily
    // drilldown a cumulative column derives; when both could apply, `detail` wins.
    detail: z.object({ dataset: z.string(), on: z.string() }).optional()
  }),
  z.object({ type: z.literal('keyvalue'), dataset: z.string(), title: z.string().optional() })
])
export type View = z.infer<typeof ViewSchema>
