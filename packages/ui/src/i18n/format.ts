// Pure, node-testable display-format helpers. The currency style overrides the NUMBER-formatting locale
// only (grouping/symbol placement) — never the amount, never the currency code (no FX). Date helpers apply
// a preset to app-generated dates (meta lines), in the machine's local zone, not to raw plugin-emitted cells.

import { DateTime } from 'luxon'

export type CurrencyStyle = 'match' | 'us' | 'fr' | 'eu'
export type DateFormatPreset = 'locale' | 'iso' | 'us' | 'eu'

export interface FormatPrefs {
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

  const locale = prefs.dateFormat === 'us' ? 'en-US' : prefs.dateFormat === 'eu' ? 'en-GB' : fallbackLocale

  return date.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })
}

// Largest unit whose magnitude is >= 1 (down to seconds), localized. Wording comes from the locale.
export const formatRelative = (then: Date, now: Date, locale: string): string =>
  DateTime.fromJSDate(then).toRelative({ base: DateTime.fromJSDate(now), locale }) ?? ''
