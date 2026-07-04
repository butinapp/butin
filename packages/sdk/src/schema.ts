// @butinapp/sdk/schema — the runtime zod schemas the HOST composes into the export-bundle / Overview wire
// schema (@butinapp/shapes). NOT the author surface: a plugin author annotates the data-view TYPES on
// @butinapp/sdk/data (`Summary`, `MonthPoint`, …) and never imports these schema objects. Kept off /data
// precisely so the author's autocomplete there carries only what a plugin declares.
export { MonthPointSchema } from './data/series.js'
export { SummarySchema, SectionSchema } from './data/summary.js'
