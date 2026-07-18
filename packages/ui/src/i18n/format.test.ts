import { expect, test } from 'vitest'

import { formatMoney } from '../lib/format.js'

import {
  DEFAULT_FORMAT_PREFS,
  formatDateTime,
  formatRelative,
  moneyLocale,
  resolveMoneyLocale,
  resolveNumberLocale
} from './format.js'

test('resolveNumberLocale maps each style, match falls back', () => {
  expect(resolveNumberLocale('us', 'fr-CA')).toBe('en-US')
  expect(resolveNumberLocale('fr', 'en-US')).toBe('fr-CA')
  expect(resolveNumberLocale('eu', 'en-US')).toBe('de-DE')
  expect(resolveNumberLocale('match', 'fr-CA')).toBe('fr-CA')
})

test('moneyLocale puts the base currency in its home region, keeping the app language', () => {
  expect(moneyLocale('CAD', 'en-US')).toBe('en-CA')
  expect(moneyLocale('USD', 'en-US')).toBe('en-US')
  expect(moneyLocale('CAD', 'fr-CA')).toBe('fr-CA')
  expect(moneyLocale('EUR', 'en-US')).toBe('en-IE')
  // Unmapped / absent → the app locale unchanged (no forced prefix, no crash).
  expect(moneyLocale('XYZ', 'en-US')).toBe('en-US')
  expect(moneyLocale(undefined, 'fr-CA')).toBe('fr-CA')
})

test('resolveMoneyLocale follows the base currency under match; a pinned style wins', () => {
  expect(resolveMoneyLocale({ currencyStyle: 'match', dateFormat: 'locale', baseCurrency: 'CAD' }, 'en-US')).toBe(
    'en-CA'
  )
  expect(resolveMoneyLocale({ currencyStyle: 'match', dateFormat: 'locale' }, 'en-US')).toBe('en-US')
  expect(resolveMoneyLocale({ currencyStyle: 'us', dateFormat: 'locale', baseCurrency: 'CAD' }, 'fr-CA')).toBe('en-US')
})

test('a base-currency amount renders home-plain; a foreign amount is disambiguated', () => {
  // The user-facing contract: the CAD base shows a plain symbol, a foreign USD amount is prefixed — driven
  // entirely by the locale, no per-value branching.
  const loc = moneyLocale('CAD', 'en-US')

  expect(formatMoney(100, 'CAD', loc)).not.toContain('CA$')
  expect(formatMoney(100, 'USD', loc)).not.toBe(formatMoney(100, 'CAD', loc))
})

test('formatDateTime honors the date preset, in the local zone', () => {
  // A local-wall-clock date, so the rendered fields don't depend on the machine's zone.
  const local = new Date(2026, 5, 14, 15, 42)

  expect(formatDateTime(local, { currencyStyle: 'match', dateFormat: 'iso' }, 'en-US')).toBe('2026-06-14 15:42')
  expect(formatDateTime(local, { currencyStyle: 'match', dateFormat: 'us' }, 'fr-CA')).toContain('2026')
  expect(formatDateTime('', DEFAULT_FORMAT_PREFS, 'en-US')).toBe('—')
})

test('formatRelative picks the largest unit, localized', () => {
  const now = new Date('2026-06-14T12:00:00Z')

  expect(formatRelative(new Date('2026-06-14T10:00:00Z'), now, 'en-US')).toBe('2 hours ago')
  expect(formatRelative(new Date('2026-06-14T11:59:30Z'), now, 'en-US')).toBe('30 seconds ago')
  expect(formatRelative(new Date('2026-06-12T12:00:00Z'), now, 'en-US')).toBe('2 days ago')
  expect(formatRelative(new Date('2026-06-14T10:00:00Z'), now, 'fr-CA')).toContain('il y a')
})
