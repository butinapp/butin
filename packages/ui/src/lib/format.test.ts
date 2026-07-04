import { expect, test } from 'vitest'

import { formatUsd, formatUsdCompact } from './format.js'

test('formatUsd renders exact cents', () => {
  expect(formatUsd(1234.5)).toBe('$1,234.50')
  expect(formatUsd(0)).toBe('$0.00')
})

test('formatUsdCompact abbreviates large values and keeps the sign', () => {
  expect(formatUsdCompact(2_230_000)).toBe('$2.23M')
  expect(formatUsdCompact(12_400)).toBe('$12.4k')
  expect(formatUsdCompact(52)).toBe('$52')
  expect(formatUsdCompact(-2000)).toBe('-$2.0k')
})
