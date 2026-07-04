import { expect, test } from 'vitest'

import { formatByRole } from './format-role.js'

test('money formats as currency, honoring the column currency', () => {
  expect(formatByRole(1234.5, 'money')).toBe('$1,234.50')
  expect(formatByRole(1234.5, 'money', 'EUR')).toBe('€1,234.50')
})

test('count gets thousands separators; percent renders a 0..1 fraction as a %', () => {
  expect(formatByRole(1200000, 'count')).toBe('1,200,000')
  expect(formatByRole(0.42, 'percent')).toBe('42%')
  expect(formatByRole(0.46306, 'percent')).toBe('46.3%')
})

test('label/status/identifier/text/url/timestamp pass through as strings', () => {
  expect(formatByRole('paid', 'status')).toBe('paid')
  expect(formatByRole('2026-05-10', 'timestamp')).toBe('2026-05-10')
  expect(formatByRole('https://x/a.pdf', 'url')).toBe('https://x/a.pdf')
})

test('null, undefined, and empty string render as an em dash', () => {
  expect(formatByRole(null, 'money')).toBe('—')
  expect(formatByRole(undefined, 'label')).toBe('—')
  expect(formatByRole('', 'text')).toBe('—')
})

test('a non-numeric value in a numeric role falls back to its string form', () => {
  expect(formatByRole('n/a', 'money')).toBe('n/a')
})
