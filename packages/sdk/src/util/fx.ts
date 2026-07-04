// Currency conversion against a rates table keyed RELATIVE TO ONE TARGET (base) currency:
// rates[c] = how many units of the target currency one unit of `c` is worth. The target needs no entry
// (it is identity). A currency absent from the table cannot be converted — convert returns null rather
// than fabricate a number, so callers exclude it from a total instead of poisoning the sum.
export type FxRates = Record<string, number>

export const convert = (amount: number, from: string, to: string, rates: FxRates): number | null => {
  if (from === to) {
    return amount
  }

  const rate = rates[from]

  return rate === undefined ? null : amount * rate
}
