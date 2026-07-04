import { expect, test } from 'vitest'

import { formatSize } from './doc-models.js'

test('formatSize renders human units, and a dash when unknown', () => {
  expect(formatSize(undefined)).toBe('—')
  expect(formatSize(900)).toBe('900 B')
  expect(formatSize(2048)).toBe('2.0 KB')
  expect(formatSize(5_242_880)).toBe('5.0 MB')
})
