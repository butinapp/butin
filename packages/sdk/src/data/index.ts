// @butinapp/sdk/data — the data-view contract a capability's collect()/build() emits: datasets (table ·
// record with semantic-role columns), views, summaries, the typed builders (table · record ·
// capabilityResult), and the currency/role/series shapes they compose. The plugin DESCRIPTOR (definePlugin ·
// defineCapability · meta/session/auth/transport/config) is the root '@butinapp/sdk' — this is the separate
// "what a capability returns" tier. Prefer the high-altitude presets ('@butinapp/sdk/presets') over
// hand-building datasets/views. The internal zod *Schema objects stay off this surface — annotate the TYPES.
export { rawTable, rawRecord } from './dataset.js'
export type {
  SemanticRole,
  BadgeTone,
  Accrual,
  ResetPeriod,
  Column,
  TableDataset,
  RecordDataset,
  Dataset
} from './dataset.js'
export type { MonthPoint } from './series.js'
export type { RolesFor } from './roles.js'
export { table, record, capabilityResult, addSections } from './builders.js'
export type { ViewSpec, RowColumn, FileTableSpec, TableHandle, StatFieldSpec, RecordHandle } from './builders.js'
export { resolveTableFiles } from './view.js'
export type { FileSource, TableFiles, StatTone, StatField, View } from './view.js'
export type { Section, Summary } from './summary.js'
export { validateCapabilityResult } from './result.js'
export type { CapabilityResult } from './result.js'
export { resolveCurrencies } from './currency.js'
export type { CurrencyCode } from './currency.js'
