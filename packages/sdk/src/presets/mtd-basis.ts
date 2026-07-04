import { z } from 'zod'

// What a `spend.mtd` figure measures — so the Overview groups/labels like with like instead of blind-summing
// a flat fee, an accruing usage total, and a last-month invoice into one meaningless number.
export const MtdBasisSchema = z.enum(['accrued', 'invoiced', 'flat', 'upcoming', 'lastInvoice'])
export type MtdBasis = z.infer<typeof MtdBasisSchema>

export const MTD_BASIS_LABELS: Record<MtdBasis, string> = {
  accrued: 'accrued so far',
  invoiced: 'invoiced this month',
  flat: 'fixed monthly fee',
  upcoming: 'upcoming invoice',
  lastInvoice: 'last invoice'
}
