// Money-unit converters — vendors report in cents / cent-strings / millicents / decimal-strings.
// Normalize everything to MAJOR UNITS of the value's own currency at the edge; the currency itself is
// named separately by `reportingCurrency` / a Column's `currency`. Unit conversion, not currency conversion.
const CENTS_PER_MAJOR = 100
const MILLICENTS_PER_MAJOR = 100_000

export const centsToMajor = (value?: number | null): number => (value ?? 0) / CENTS_PER_MAJOR

export const centsStringToMajor = (value?: string): number => (value ? parseInt(value, 10) / CENTS_PER_MAJOR : 0)

export const millicentsToMajor = (value?: string): number => {
  const n = value ? parseInt(value, 10) : 0

  return Number.isFinite(n) ? n / MILLICENTS_PER_MAJOR : 0
}

export const parseDecimalAmount = (value?: string): number => {
  if (!value) {
    return 0
  }

  const n = parseFloat(value.replace(/[^0-9.-]/g, ''))

  return Number.isFinite(n) ? n : 0
}

// Round to 2 decimals — sheds the float noise a vendor's already-major-unit amount carries (69.90000001 → 69.9).
export const round2 = (n: number): number => Math.round(n * 100) / 100

// French-Canadian money string → major units, rounded to cents. Handles space thousands-seps, a `$` suffix, and a
// comma decimal ("24 716,80 $" | "1 234,56 $" → 24716.8 | 1234.56), while still parsing dot-decimal ("1,234.56").
// A bare comma-decimal (no dot present) is treated as the decimal point; otherwise commas are thousands-seps and
// dropped. 0 when empty or unparseable. (parseDecimalAmount drops commas wholesale, so it can't read the fr form.)
export const parseFrAmount = (raw?: string | null): number => {
  if (!raw) {
    return 0
  }

  const cleaned = raw.replace(/\s/g, '').replace(/\$/g, '')
  const normalized =
    cleaned.includes(',') && !cleaned.includes('.')
      ? cleaned.replace(/\./g, '').replace(',', '.')
      : cleaned.replace(/,/g, '')
  const n = parseFloat(normalized)

  return Number.isFinite(n) ? round2(n) : 0
}
