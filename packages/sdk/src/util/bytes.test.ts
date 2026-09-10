import { expect, test } from 'vitest'

import { isPdfBytes } from './bytes.js'

const bytes = (...b: number[]) => new Uint8Array(b)

test('recognizes a PDF by its %PDF magic number', () => {
  expect(isPdfBytes(bytes(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31))).toBe(true)
})

test('rejects the HTML error page a lost session answers a document request with', () => {
  // '<htm' — a 200 that is not the file, which is the case this guard exists for.
  expect(isPdfBytes(bytes(0x3c, 0x68, 0x74, 0x6d))).toBe(false)
})

test('rejects a body too short to carry the magic number', () => {
  expect(isPdfBytes(bytes(0x25, 0x50))).toBe(false)
  expect(isPdfBytes(bytes())).toBe(false)
})
