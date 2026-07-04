import { expect, test } from 'vitest'

import { DEFAULT_FORMAT_PREFS, formatDateTime, formatRelative, resolveNumberLocale } from './format.js'

test('resolveNumberLocale maps each style, match falls back', () => {
  expect(resolveNumberLocale('us', 'fr-CA')).toBe('en-US')
  expect(resolveNumberLocale('fr', 'en-US')).toBe('fr-CA')
  expect(resolveNumberLocale('eu', 'en-US')).toBe('de-DE')
  expect(resolveNumberLocale('match', 'fr-CA')).toBe('fr-CA')
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
