import { uniqBy } from 'lodash-es'

import { omitUndef } from '../util/object.js'

import {
  type Accrual,
  type BadgeTone,
  type Column,
  type Dataset,
  rawRecord,
  rawTable,
  type RecordDataset,
  type ResetPeriod,
  type TableDataset
} from './dataset.js'
import type { CapabilityResult } from './result.js'
import type { RolesFor } from './roles.js'
import type { Section, Summary } from './summary.js'
import type { View } from './view.js'

// A view plus the dataset it draws. capabilityResult() collects the datasets off the sections (de-duped by
// id) so a plugin never assembles the datasets array by hand and a view can't reference a missing dataset.
// `extraDatasets` carries datasets a view references but doesn't render as its own section (a table's row-
// detail child) so they still ship in result.datasets.
export type ViewSpec = { view: View; dataset: Dataset; extraDatasets?: Dataset[] }

// A column whose `key` is a field of Row and whose `role` is constrained by that field's value type.
type TypedColumn<Row, K extends keyof Row> = {
  key: K
  role: RolesFor<Exclude<Row[K], undefined>>
  label?: string
  currency?: string
  badges?: Record<string, BadgeTone>
  // A cumulative column (an MTD-per-row counter resetting each `resetPeriod`) lets core difference its daily
  // readings into a per-row daily breakdown. Requires the table to be keyed (enforced by validateCapabilityResult).
  accrual?: Accrual
  resetPeriod?: ResetPeriod
  // Cap a long free-text column to one ellipsized line (hover peek + click-to-copy popover) so it stops
  // squashing its neighbours. Opt-in; only meaningful for free-text roles.
  truncate?: boolean
  hidden?: boolean
}

export type RowColumn<Row> = { [K in keyof Row]-?: TypedColumn<Row, K> }[keyof Row]

type Key<Row> = keyof Row & string

type FileSource<Row> = { url: Key<Row> } | { fetch: true }

export type FileTableSpec<Row> = {
  title?: string
  name: Key<Row>
  source: FileSource<Row>
  ext?: string
  category?: string
  folder?: Key<Row>
  columns?: Key<Row>[]
  groupBy?: Key<Row>
}

type SummarySpec<Row> = {
  section: Section
  label: string
  value: number
  role?: 'money' | 'count' | 'percent'
  currency?: string
  basis?: Summary['basis']
  // When given, the summary's spark binds to this dataset's series — same (x,y) as a timeseries view, so the
  // two never drift.
  x?: Key<Row>
  y?: Key<Row>
}

// Expand each parent row into a nested table drawn from a child table handle, joined on a field named the same
// on both sides (`on` is a key of the parent row; the child carries the identical field).
export type RowDetailSpec<Row> = { rows: TableHandle<unknown>; on: Key<Row> }

export interface TableHandle<Row> {
  dataset: TableDataset
  table(opts?: { title?: string; columns?: Key<Row>[]; groupBy?: Key<Row>; detail?: RowDetailSpec<Row> }): ViewSpec
  fileTable(opts: FileTableSpec<Row>): ViewSpec
  timeseries(opts: {
    x: Key<Row>
    y: Key<Row>
    granularity?: 'monthly' | 'daily'
    stackBy?: Key<Row>
    title?: string
  }): ViewSpec
  summary(opts: SummarySpec<Row>): Summary
}

// A rich stat field: a row key plus optional presentation the column's role can't carry — a denominator
// (`max` → 'value / max' + progress bar), a unit suffix, a caption line, a value tone. All literals, computed
// by the plugin at build time.
export type StatFieldSpec<Row> = {
  key: Key<Row>
  max?: number
  unit?: string
  caption?: string
  tone?: 'positive' | 'negative' | 'muted'
}

export interface RecordHandle<Row> {
  dataset: RecordDataset
  stat(opts?: { fields?: (Key<Row> | StatFieldSpec<Row>)[]; title?: string }): ViewSpec
  keyvalue(opts?: { title?: string }): ViewSpec
}

type TableView = Extract<View, { type: 'table' }>
type TimeseriesView = Extract<View, { type: 'timeseries' }>
type StatView = Extract<View, { type: 'stat' }>
type KeyValueView = Extract<View, { type: 'keyvalue' }>

// `Row extends object` (not `Record<string, unknown>`) so an `interface` row type is accepted: TS interfaces
// lack an implicit index signature, so they fail the Record constraint even though their fields are known.
export const table = <Row extends object>(spec: {
  id: string
  columns: RowColumn<Row>[]
  rows: Row[]
  key?: Key<Row> | Key<Row>[]
}): TableHandle<Row> => {
  // The typed builder is the only public way to construct a dataset; it delegates the wire-object shape to
  // the low-level rawTable so there's a single place that knows the TableDataset layout.
  const dataset = rawTable(
    spec.id,
    spec.columns as unknown as Column[],
    spec.rows as Record<string, unknown>[],
    spec.key
  )

  // Each method annotates its view against the matching View union variant before omitUndef strips the
  // undefined keys — the annotation structurally checks the builder's field set, so a drift between what the
  // builder emits and the wire schema fails to compile rather than slipping through a cast.
  return {
    dataset,
    table: (opts = {}) => {
      const view: TableView = {
        type: 'table',
        dataset: spec.id,
        title: opts.title,
        columns: opts.columns,
        groupBy: opts.groupBy,
        detail: opts.detail ? { dataset: opts.detail.rows.dataset.id, on: opts.detail.on as string } : undefined
      }

      return {
        dataset,
        view: omitUndef(view),
        ...(opts.detail ? { extraDatasets: [opts.detail.rows.dataset] } : {})
      }
    },
    fileTable: (opts) => {
      const view: TableView = {
        type: 'table',
        dataset: spec.id,
        title: opts.title,
        columns: opts.columns,
        groupBy: opts.groupBy,
        files: omitUndef({
          name: opts.name,
          source: opts.source,
          ext: opts.ext,
          category: opts.category,
          folder: opts.folder
        })
      }

      return { dataset, view: omitUndef(view) }
    },
    timeseries: (opts) => {
      const view: TimeseriesView = {
        type: 'timeseries',
        dataset: spec.id,
        x: opts.x,
        y: opts.y,
        granularity: opts.granularity,
        stackBy: opts.stackBy,
        title: opts.title
      }

      return { dataset, view: omitUndef(view) }
    },
    summary: (opts) => {
      const summary: Summary = {
        section: opts.section,
        label: opts.label,
        value: opts.value,
        role: opts.role ?? 'money',
        currency: opts.currency,
        basis: opts.basis,
        spark: opts.x && opts.y ? { dataset: spec.id, x: opts.x, y: opts.y } : undefined
      }

      return omitUndef(summary)
    }
  }
}

// The stat/keyvalue handle off an already-built record dataset — shared by the typed `record` and the
// dynamic `record.fromColumns`.
const recordHandle = <Row extends object>(dataset: RecordDataset): RecordHandle<Row> => ({
  dataset,
  stat: (opts = {}) => {
    const fields = opts.fields?.map((f) => (typeof f === 'string' ? f : omitUndef(f)))
    const view: StatView = { type: 'stat', dataset: dataset.id, fields, title: opts.title }

    return { dataset, view: omitUndef(view) }
  },
  keyvalue: (opts = {}) => {
    const view: KeyValueView = { type: 'keyvalue', dataset: dataset.id, title: opts.title }

    return { dataset, view: omitUndef(view) }
  }
})

// A record dataset. `record({ id, fields, value })` types the columns against a statically-known row.
// `record.fromColumns({ id, fields, value })` is the dynamic form for a runtime-assembled `Column[]` + value
// object (a preset building an account/credits/payment-method record from optional fields) — no per-row
// generic, no cast at the call site.
export const record = Object.assign(
  <Row extends object>(spec: { id: string; fields: RowColumn<Row>[]; value: Row }): RecordHandle<Row> =>
    recordHandle<Row>(rawRecord(spec.id, spec.fields as unknown as Column[], spec.value as Record<string, unknown>)),
  {
    fromColumns: (spec: {
      id: string
      fields: Column[]
      value: Record<string, unknown>
    }): RecordHandle<Record<string, unknown>> =>
      recordHandle<Record<string, unknown>>(rawRecord(spec.id, spec.fields, spec.value))
  }
)

// Assemble a CapabilityResult from view-specs: collect each section's dataset (de-duped by id, first wins),
// drop falsy sections (conditional panels), and attach optional summaries. Section order is literal array order.
export const capabilityResult = (spec: {
  sections: (ViewSpec | null | undefined | false)[]
  summaries?: Summary[]
}): CapabilityResult => {
  const sections = spec.sections.filter((s): s is ViewSpec => Boolean(s))

  return {
    datasets: uniqBy(
      sections.flatMap((s) => [s.dataset, ...(s.extraDatasets ?? [])]),
      (d) => d.id
    ),
    views: sections.map((s) => s.view),
    ...(spec.summaries?.length ? { summaries: spec.summaries } : {})
  }
}
