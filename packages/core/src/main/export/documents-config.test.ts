import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'

import { setConfigRoot } from '../store/config-file.js'

import { getDocumentsOutputDir, setDocumentsOutputDir } from './documents-config.js'

beforeAll(() => setConfigRoot(mkdtempSync(join(tmpdir(), 'butin-docs-'))))
afterAll(() => setConfigRoot(join(tmpdir(), 'butin-unused')))

test('output dir is undefined until set, then round-trips', () => {
  expect(getDocumentsOutputDir('serper')).toBeUndefined()
  setDocumentsOutputDir('serper', 'D:/exports/serper')
  expect(getDocumentsOutputDir('serper')).toBe('D:/exports/serper')
})
