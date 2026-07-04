import { z } from 'zod'

// A point on a monthly money axis ('YYYY-MM' → amount in major units). The shared shape the billing presets
// emit (monthlySpend) and the cross-service Overview rollup consumes, so the two can't drift. Schema-defined
// so the export-bundle validator can reuse it at the cross-version boundary.
export const MonthPointSchema = z.object({ month: z.string(), amount: z.number() })
export type MonthPoint = z.infer<typeof MonthPointSchema>
