import { z } from 'zod'

import { MtdBasisSchema } from '../presets/mtd-basis.js'

// Which Overview section a summary feeds. Only 'spend' sums across services (the combined spend total + chart);
// 'balance' and 'other' are shown per-service, never summed. Additive: a future summing band (e.g. 'revenue')
// is a new enum value plus a one-line rollup rule.
export const SectionSchema = z.enum(['spend', 'balance', 'other'])
export type Section = z.infer<typeof SectionSchema>

export const SummarySchema = z.object({
  section: SectionSchema,
  label: z.string(),
  value: z.number(),
  role: z.enum(['money', 'count', 'percent']),
  currency: z.string().optional(),
  // What a spend figure measures (accrued / invoiced / flat / upcoming / lastInvoice) — a display label.
  basis: MtdBasisSchema.optional(),
  spark: z.object({ dataset: z.string(), x: z.string(), y: z.string() }).optional(),
  // Force this summary to be the service's headline (overrides the spend > balance > other default).
  headline: z.boolean().optional()
})
export type Summary = z.infer<typeof SummarySchema>
