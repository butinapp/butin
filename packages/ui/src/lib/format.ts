// Format a number in an explicit ISO-4217 currency (e.g. 1234.5, 'CAD' → "CA$1,234.50").
export const formatMoney = (n: number, currency = 'USD', locale = 'en-US'): string =>
  n.toLocaleString(locale, { style: 'currency', currency })

// Compact money in an explicit currency via Intl compact notation: 2_230_000 CAD → "CA$2.2M", 12_400 → "$12K".
export const formatMoneyCompact = (n: number, currency = 'USD', locale = 'en-US'): string =>
  n.toLocaleString(locale, { style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1 })
