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

// A basis whose current-month figure is a LIVE open-period accrual that grows through the month (or a fixed
// recurring fee), as opposed to a settled figure keyed to a past invoice. Only an accrual basis may seed the
// current-month bar: its captured peak is a real estimate of the month's spend, whereas an 'invoiced'/'lastInvoice'
// value is a prior bill that would synthesize a phantom bar if projected onto a month with no invoice yet.
export const isAccrualBasis = (basis: MtdBasis | undefined): boolean =>
  basis === 'accrued' || basis === 'upcoming' || basis === 'flat'
