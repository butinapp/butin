import { z } from 'zod'

import { type Dataset, DatasetSchema, type SemanticRole } from './dataset.js'
import { SummarySchema } from './summary.js'
import { ViewSchema } from './view.js'

// collect() returns this. views/summaries omitted → a preset supplies defaults (see presets/). Each entry in
// `summaries` headlines one metric tagged by `section` (spend·balance·other); at most one `spend` summary per
// result (it's the only section that sums across services).
export const CapabilityResultSchema = z.object({
  datasets: z.array(DatasetSchema),
  views: z.array(ViewSchema).optional(),
  summaries: z.array(SummarySchema).optional()
})
export type CapabilityResult = z.infer<typeof CapabilityResultSchema>

const roleOf = (ds: Dataset, key: string): SemanticRole | undefined => {
  const cols = ds.shape === 'table' ? ds.columns : ds.fields

  return cols.find((c) => c.key === key)?.role
}

// Whether `key` is addressable on a table's rows: a declared column, or a hidden row-identity field carried on
// every row (the same rule the accumulation `key` check uses). An empty table can't disprove a hidden field.
const isFieldOf = (ds: Dataset, key: string): boolean => {
  if (ds.shape !== 'table') {
    return false
  }

  if (ds.columns.some((c) => c.key === key)) {
    return true
  }

  return ds.rows.length > 0 && ds.rows.every((r) => key in r)
}

// Referential checks zod can't express ergonomically: refs resolve, view shape fits dataset shape,
// chart x/y point at compatible roles.
const crossRefErrors = (result: CapabilityResult): string[] => {
  const errors: string[] = []
  const byId = new Map<string, Dataset>()

  for (const ds of result.datasets) {
    if (byId.has(ds.id)) {
      // keep the FIRST dataset for an id so later shape checks don't run against a clashing duplicate
      errors.push(`duplicate dataset id '${ds.id}'`)
      continue
    }

    byId.set(ds.id, ds)
  }

  // Accumulation contract: a `key` must name real column(s); a cumulative column needs a key to hang its
  // per-row daily series on.
  for (const ds of result.datasets) {
    if (ds.shape !== 'table') {
      continue
    }

    const colKeys = new Set(ds.columns.map((c) => c.key))
    const keyParts = ds.key === undefined ? [] : Array.isArray(ds.key) ? ds.key : [ds.key]

    // A key part is a column or a hidden row-identity field (members/invoice id). Only flag a part that is
    // neither — and only when there are rows to judge against (an empty table can't disprove a hidden field).
    for (const k of keyParts) {
      if (!colKeys.has(k) && ds.rows.length > 0 && !ds.rows.every((r) => k in r)) {
        errors.push(`key '${k}' is not a column or row field of '${ds.id}'`)
      }
    }

    if (keyParts.length === 0) {
      for (const c of ds.columns) {
        if (c.accrual === 'cumulative') {
          errors.push(`cumulative column '${c.key}' needs a keyed table (table '${ds.id}' is unkeyed)`)
        }
      }
    }

    // Every money value must name a currency (resolveCurrencies fills the plugin default first; an
    // explicit per-value currency overrides it). A money value with no currency is unrenderable + unrollable.
    for (const c of ds.columns) {
      if (c.role === 'money' && !c.currency) {
        errors.push(`money column '${c.key}' in '${ds.id}' has no currency`)
      }
    }
  }

  // Money-currency rule applies to record fields too (record datasets are skipped by the table-only loop above).
  for (const ds of result.datasets) {
    if (ds.shape !== 'record') {
      continue
    }

    for (const c of ds.fields) {
      if (c.role === 'money' && !c.currency) {
        errors.push(`money column '${c.key}' in '${ds.id}' has no currency`)
      }
    }
  }

  const need = (ref: string, where: string): Dataset | undefined => {
    const ds = byId.get(ref)

    if (!ds) {
      errors.push(`${where} references unknown dataset '${ref}'`)
    }

    return ds
  }

  const requireSpark = (ds: Dataset, x: string, y: string, where: string): void => {
    if (roleOf(ds, x) !== 'timestamp') {
      errors.push(`${where} x '${x}' must be a timestamp column`)
    }

    const yRole = roleOf(ds, y)

    if (yRole !== 'money' && yRole !== 'count') {
      errors.push(`${where} y '${y}' must be a money|count column`)
    }
  }

  for (const v of result.views ?? []) {
    const ds = need(v.dataset, `view '${v.type}'`)

    if (!ds) {
      continue
    }

    if (v.type === 'timeseries') {
      requireSpark(ds, v.x, v.y, 'timeseries')
    }

    if ((v.type === 'stat' || v.type === 'keyvalue') && ds.shape !== 'record') {
      errors.push(`view '${v.type}' needs a record dataset; '${ds.id}' is a ${ds.shape}`)
    }

    if (v.type === 'table' && ds.shape !== 'table') {
      errors.push(`view 'table' needs a table dataset; '${ds.id}' is a ${ds.shape}`)
    }

    // groupBy must point at a real column; the files source url / name / folder are row fields (may be hidden,
    // not necessarily columns), so they aren't checked here — the "files needs a byte source" rule lives in
    // core's download path (the only place the capability's fetchFile is visible).
    if (v.type === 'table' && v.groupBy && roleOf(ds, v.groupBy) === undefined) {
      errors.push(`table groupBy '${v.groupBy}' is not a column of '${ds.id}'`)
    }

    // A row-detail binding: the child resolves to a table, and the join field is a field (column or hidden row
    // field) of BOTH the parent and the child — else the nested rows can't be matched to their parent.
    if (v.type === 'table' && v.detail) {
      const child = need(v.detail.dataset, `table detail`)

      if (child && child.shape !== 'table') {
        errors.push(`table detail '${v.detail.dataset}' must be a table dataset; it is a ${child.shape}`)
      }

      if (child && child.shape === 'table') {
        for (const [where, target] of [
          ['parent', ds],
          ['child', child]
        ] as const) {
          if (!isFieldOf(target, v.detail.on)) {
            errors.push(`table detail 'on' field '${v.detail.on}' is not a field of the ${where} table '${target.id}'`)
          }
        }
      }
    }
  }

  let spendCount = 0

  for (const s of result.summaries ?? []) {
    if (s.section === 'spend') {
      spendCount += 1
    }

    if (s.role === 'money' && !s.currency) {
      errors.push(`money summary '${s.label}' has no currency`)
    }

    // A spend summary headlines the Overview's monthly chart + previous-month total, both read off its spark's
    // monthly series. With no spark it silently contributes nothing there — require one (presence, not rows, so a
    // brand-new account with an empty monthly table is still fine).
    if (s.section === 'spend' && !s.spark) {
      errors.push(`spend summary '${s.label}' needs a spark (the monthly series the Overview reads)`)
    }

    if (s.spark) {
      const ds = need(s.spark.dataset, `summary '${s.label}' spark`)

      if (ds) {
        requireSpark(ds, s.spark.x, s.spark.y, `summary '${s.label}' spark`)
      }
    }
  }

  if (spendCount > 1) {
    errors.push('more than one spend summary in a result')
  }

  return errors
}

// Returns a list of human-readable contract errors; [] = valid. Structural errors come from zod,
// referential errors from crossRefErrors. Distinct from a collect() fetch failure.
export const validateCapabilityResult = (result: unknown): string[] => {
  const parsed = CapabilityResultSchema.safeParse(result)

  if (!parsed.success) {
    return parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
  }

  return crossRefErrors(parsed.data)
}
