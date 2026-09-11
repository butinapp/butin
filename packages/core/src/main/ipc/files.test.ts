import { join } from 'node:path'
import { expect, test } from 'vitest'

import { isWithin } from './files.js'

test('isWithin accepts the root and its descendants, and rejects everything that resolves outside it', () => {
  const root = join('/home/u/butin', 'profiles', 'personal')

  expect(isWithin(root, root)).toBe(true)
  expect(isWithin(root, join(root, 'claude', 'documents', 'a.pdf'))).toBe(true)
  expect(isWithin(root, join(root, '..', 'other', 'a.pdf'))).toBe(false)
  expect(isWithin(root, join(root, '..'))).toBe(false)
  expect(isWithin(root, `${root}-evil/a.pdf`)).toBe(false)
  expect(isWithin(root, '/etc/passwd')).toBe(false)
})
