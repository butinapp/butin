// Format a number as USD (e.g. 1234.5 → "$1,234.50").
export const formatUsd = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })

// Format a number in an explicit ISO-4217 currency (e.g. 1234.5, 'CAD' → "CA$1,234.50").
export const formatMoney = (n: number, currency = 'USD', locale = 'en-US'): string =>
  n.toLocaleString(locale, { style: 'currency', currency })

// Compact USD for tight spaces: 2_230_000 → "$2.23M", 12_400 → "$12.4k", 52 → "$52". Keeps the sign.
export const formatUsdCompact = (n: number): string => {
  const abs = Math.abs(n)
  const sign = n < 0 ? '-' : ''

  if (abs >= 1_000_000) {
    return `${sign}$${(abs / 1_000_000).toFixed(2)}M`
  }

  if (abs >= 1_000) {
    return `${sign}$${(abs / 1_000).toFixed(1)}k`
  }

  return `${sign}$${Math.round(abs)}`
}

// Compact money in an explicit currency via Intl compact notation: 2_230_000 CAD → "CA$2.2M", 12_400 → "$12K".
export const formatMoneyCompact = (n: number, currency = 'USD', locale = 'en-US'): string =>
  n.toLocaleString(locale, { style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1 })
