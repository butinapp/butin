import { type SemanticRole } from '@butinapp/sdk/data'

// The single value -> display-string formatter, keyed by a column's semantic role. `currency` (ISO 4217)
// applies only to the 'money' role and defaults to USD. `locale` (BCP-47) drives Intl number formatting
// and defaults to en-US. null/undefined/'' render as an em dash. A value that can't be coerced to a
// number in a numeric role falls back to its raw string form.
export const formatByRole = (value: unknown, role: SemanticRole, currency = 'USD', locale = 'en-US'): string => {
  if (value == null || value === '') {
    return '—'
  }

  if (role === 'money' || role === 'count' || role === 'percent') {
    const n = Number(value)

    if (!Number.isFinite(n)) {
      return String(value)
    }

    if (role === 'money') {
      return n.toLocaleString(locale, { style: 'currency', currency })
    }

    if (role === 'count') {
      return n.toLocaleString(locale)
    }

    // percent: the value is a 0..1 fraction (0.46 → "46%"); Intl's percent style scales + appends the sign.
    return n.toLocaleString(locale, { style: 'percent', maximumFractionDigits: 1 })
  }

  // timestamp, status, label, identifier, url, text — shown verbatim
  return String(value)
}
