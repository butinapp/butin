// Pure, node-testable display-format helpers. The currency style overrides the NUMBER-formatting locale
// only (grouping/symbol placement) — never the amount, never the currency code (no FX). Dates render in the
// configured preset: `formatDateTime` for an instant, `formatTimestamp` for a value whose own precision
// (date-only vs date+time) must survive.

import { DateTime } from 'luxon'

export type CurrencyStyle = 'match' | 'us' | 'fr' | 'eu'
export type DateFormatPreset = 'locale' | 'iso' | 'us' | 'eu'

export type FormatPrefs = {
  currencyStyle: CurrencyStyle
  dateFormat: DateFormatPreset
  // The Overview's base currency. With the default 'match' style, money formats in this currency's home region
  // so it renders with a plain symbol ($) and only foreign currencies get a disambiguating prefix (US$, CA$).
  baseCurrency?: string
}

export const DEFAULT_FORMAT_PREFS: FormatPrefs = { currencyStyle: 'match', dateFormat: 'locale' }

const NUMBER_LOCALES: Record<Exclude<CurrencyStyle, 'match'>, string> = {
  us: 'en-US',
  fr: 'fr-CA',
  eu: 'de-DE'
}

// 'match' follows the app's intlLocale; the named presets pin a region's number/currency formatting.
export const resolveNumberLocale = (style: CurrencyStyle, fallbackLocale: string): string =>
  style === 'match' ? fallbackLocale : NUMBER_LOCALES[style]

// The region whose home currency is each key — so formatting in `${lang}-${region}` renders that currency with
// a plain symbol and disambiguates the rest. Only the currencies the app rolls up into need an entry.
const CURRENCY_REGION: Record<string, string> = {
  USD: 'US',
  CAD: 'CA',
  EUR: 'IE',
  GBP: 'GB',
  AUD: 'AU',
  CHF: 'CH',
  JPY: 'JP',
  NZD: 'NZ',
  MXN: 'MX'
}

// A locale whose HOME currency is `baseCurrency`, so Intl renders it plainly ($, €) and every OTHER currency
// disambiguated (US$, CA$). Keeps the app language, swaps the region. Falls back to the app locale for an
// unmapped/absent currency (the prior behaviour — no forced prefix, no crash).
export const moneyLocale = (baseCurrency: string | undefined, appLocale: string): string => {
  const region = baseCurrency ? CURRENCY_REGION[baseCurrency] : undefined

  return region ? `${appLocale.split('-')[0] || 'en'}-${region}` : appLocale
}

// The locale MONEY is formatted in: the default 'match' style follows the base currency's region (home-plain,
// foreign-prefixed); a pinned style (us/fr/eu) wins, exactly as it does for plain numbers.
export const resolveMoneyLocale = (prefs: FormatPrefs, appLocale: string): string =>
  prefs.currencyStyle === 'match' ? moneyLocale(prefs.baseCurrency, appLocale) : NUMBER_LOCALES[prefs.currencyStyle]

// An ISO-look 'YYYY-MM-DD HH:mm' in the machine's local zone (a plain toISOString can't — it's always UTC).
// Year→minute fields for the meta-line display.
const isoLocal = (date: Date): string => DateTime.fromJSDate(date).toFormat('yyyy-MM-dd HH:mm')

// The locale a preset formats in: the named presets pin a region, 'locale' follows the app.
const presetLocale = (preset: DateFormatPreset, fallbackLocale: string): string =>
  preset === 'us' ? 'en-US' : preset === 'eu' ? 'en-GB' : fallbackLocale

export const formatDateTime = (value: string | number | Date, prefs: FormatPrefs, fallbackLocale: string): string => {
  if (value === '' || value == null) {
    return '—'
  }

  const date = value instanceof Date ? value : new Date(value)

  if (Number.isNaN(date.getTime())) {
    return String(value)
  }

  if (prefs.dateFormat === 'iso') {
    return isoLocal(date)
  }

  return date.toLocaleString(presetLocale(prefs.dateFormat, fallbackLocale), {
    dateStyle: 'medium',
    timeStyle: 'short'
  })
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]/

// A date whose own precision must survive: a date-only 'YYYY-MM-DD' stays a date and is parsed ZONE-FREE —
// read as an instant it is UTC midnight, which any negative-offset zone renders as the PREVIOUS day. A value
// that is neither unambiguously a date nor a date+time (a 'YYYY-MM' month key, an opaque id) passes through
// verbatim: `new Date` would invent a day for it.
export const formatTimestamp = (value: unknown, prefs: FormatPrefs, fallbackLocale: string): string => {
  if (value == null || value === '') {
    return '—'
  }

  if (typeof value === 'string' && DATE_ONLY.test(value)) {
    if (prefs.dateFormat === 'iso') {
      return value
    }

    return DateTime.fromISO(value)
      .toJSDate()
      .toLocaleDateString(presetLocale(prefs.dateFormat, fallbackLocale), { dateStyle: 'medium' })
  }

  const instant =
    value instanceof Date || typeof value === 'number' || (typeof value === 'string' && DATE_TIME.test(value))

  return instant ? formatDateTime(value as string | number | Date, prefs, fallbackLocale) : String(value)
}

// Largest unit whose magnitude is >= 1 (down to seconds), localized. Wording comes from the locale.
export const formatRelative = (then: Date, now: Date, locale: string): string =>
  DateTime.fromJSDate(then).toRelative({ base: DateTime.fromJSDate(now), locale }) ?? ''

// A byte count as a compact human size (B / KB / MB / GB / TB). Locale-independent: the unit suffixes are the
// same everywhere Butin renders, and only the magnitude carries meaning.
export const formatBytes = (n: number): string => {
  if (n < 1024) {
    return `${n} B`
  }

  const units = ['KB', 'MB', 'GB', 'TB']
  let value = n / 1024
  let unit = 0

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }

  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}
