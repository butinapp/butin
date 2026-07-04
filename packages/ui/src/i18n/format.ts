// Pure, node-testable display-format helpers. The currency style overrides the NUMBER-formatting locale
// only (grouping/symbol placement) — never the amount, never the currency code (no FX). Date helpers apply
// a preset to app-generated dates (meta lines), in the machine's local zone, not to raw plugin-emitted cells.

import { DateTime } from 'luxon'

export type CurrencyStyle = 'match' | 'us' | 'fr' | 'eu'
export type DateFormatPreset = 'locale' | 'iso' | 'us' | 'eu'

export interface FormatPrefs {
  currencyStyle: CurrencyStyle
  dateFormat: DateFormatPreset
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
