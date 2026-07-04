import { expect, test } from 'vitest'

import { deriveFilename, planDownloads, sanitizeFilename } from './documents-plan.js'

test('sanitizeFilename strips path separators and illegal characters', () => {
  expect(sanitizeFilename('a/b:c*?.pdf')).toBe('a-b-c-.pdf')
  expect(sanitizeFilename('   ')).toBe('document')
})

test('deriveFilename uses title + ext, sanitized', () => {
  expect(deriveFilename({ id: '1', title: 'Invoice 2026-05', ext: 'pdf' })).toBe('Invoice 2026-05.pdf')
  expect(deriveFilename({ id: '2', title: 'no ext' })).toBe('no ext.bin')
})

test('planDownloads lays files under <category>/ and flags existing ones to skip', () => {
  const exists = (rel: string) => rel === 'Invoices/a.pdf'
  const plan = planDownloads(
    [
      { id: 'a', title: 'a', category: 'Invoices', ext: 'pdf' },
      { id: 'b', title: 'b', ext: 'pdf' }
    ],
    exists
  )

  expect(plan).toEqual([
    { docId: 'a', relPath: 'Invoices/a.pdf', skip: true },
    { docId: 'b', relPath: 'b.pdf', skip: false }
  ])
})

test('planDownloads suffixes collisions within the batch', () => {
  const plan = planDownloads(
    [
      { id: '1', title: 'dup', ext: 'pdf' },
      { id: '2', title: 'dup', ext: 'pdf' }
    ],
    () => false
  )

  expect(plan.map((p) => p.relPath)).toEqual(['dup.pdf', 'dup (2).pdf'])
})
