import { expect, test } from 'vitest'

import { formatMoney, formatMoneyCompact } from './format.js'

test('formatMoney renders exact cents, defaulting to USD', () => {
  expect(formatMoney(1234.5)).toBe('$1,234.50')
  expect(formatMoney(0)).toBe('$0.00')
})

test('formatMoneyCompact abbreviates large values and keeps the sign', () => {
  expect(formatMoneyCompact(2_230_000)).toBe('$2.2M')
  expect(formatMoneyCompact(12_400)).toBe('$12.4K')
  expect(formatMoneyCompact(52)).toBe('$52')
  expect(formatMoneyCompact(-2000)).toBe('-$2K')
})
