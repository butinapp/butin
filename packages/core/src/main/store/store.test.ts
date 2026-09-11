import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { accumulate, readLedger } from './ledger.js'
import {
  clearCache,
  clearReports,
  clearServiceFolder,
  eraseLegacyStores,
  newestReportTime,
  readCache,
  readCurrent,
  saveCurrent,
  serviceDir,
  setDataRoot,
  writeCache
} from './store.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'butin-data-'))
  setDataRoot(dir)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('saveCurrent then readCurrent round-trips with a timestamp', async () => {
  await saveCurrent('claude', 'billing', { currentMtd: 12.5 })
  const envelope = await readCurrent('claude', 'billing')

  expect(envelope?.data).toEqual({ currentMtd: 12.5 })
  expect(typeof envelope?.lastRunAt).toBe('string')
})

test('reading a missing current cache returns null', async () => {
  expect(await readCurrent('claude', 'usage')).toBeNull()
})

test('writeCache/readCache round-trips a typed payload under a namespace+key, with a timestamp', async () => {
  const orgs = [{ value: 'o1', label: 'Org One' }]

  await writeCache('claude', 'config-options', 'orgId', orgs)

  const envelope = await readCache<typeof orgs>('claude', 'config-options', 'orgId')

  expect(envelope?.data).toEqual(orgs)
  expect(typeof envelope?.cachedAt).toBe('string')
})

test('readCache returns null for a missing key, and clearCache drops the whole namespace', async () => {
  expect(await readCache('claude', 'config-options', 'never')).toBeNull()

  await writeCache('claude', 'config-options', 'orgId', [{ value: 'o1', label: 'Org One' }])
  await clearCache('claude', 'config-options')

  expect(await readCache('claude', 'config-options', 'orgId')).toBeNull()
})

test('newestReportTime returns the newest lastRunAt across a plugin’s capabilities', async () => {
  mkdirSync(join(dir, 'claude', 'current'), { recursive: true })
  writeFileSync(
    join(dir, 'claude', 'current', 'billing.json'),
    JSON.stringify({ lastRunAt: '2026-06-01T00:00:00.000Z' })
  )
  writeFileSync(join(dir, 'claude', 'current', 'usage.json'), JSON.stringify({ lastRunAt: '2026-06-20T00:00:00.000Z' }))

  expect(await newestReportTime('claude')).toBe('2026-06-20T00:00:00.000Z')
})

test('newestReportTime is undefined when the plugin has no cached reports', async () => {
  expect(await newestReportTime('claude')).toBeUndefined()
})

test('clearReports drops the current cache alongside the ledger', async () => {
  await saveCurrent('claude', 'billing', { x: 1 })
  await accumulate('claude', 'billing', {
    capturedAt: '2026-06-15T00:00:00Z',
    datasets: [
      {
        id: 'invoices',
        shape: 'table',
        key: 'id',
        columns: [{ key: 'id', role: 'identifier' }],
        rows: [{ id: 'a' }]
      }
    ],
    summaries: []
  })

  await clearReports('claude')

  expect(await readCurrent('claude', 'billing')).toBeNull()
  expect(await readLedger('claude', 'billing')).toBeNull()
})

test('clearServiceFolder removes the entire service folder, including downloaded documents', async () => {
  await saveCurrent('claude', 'billing', { x: 1 })
  mkdirSync(join(serviceDir('claude'), 'documents'), { recursive: true })
  writeFileSync(join(serviceDir('claude'), 'documents', 'invoice.pdf'), 'pdf')

  await clearServiceFolder('claude')

  expect(existsSync(serviceDir('claude'))).toBe(false)
})

test('clearServiceFolder is a no-op when the folder never existed', async () => {
  await expect(clearServiceFolder('nope')).resolves.toBeUndefined()
})

test('an id that is not a single path segment never reaches the filesystem', async () => {
  for (const id of ['..', '.', '', '../sibling', 'a/b', 'a\b', '.hidden']) {
    await expect(clearServiceFolder(id)).rejects.toThrow(/invalid path segment/)
    await expect(clearReports(id)).rejects.toThrow(/invalid path segment/)
    await expect(readCurrent(id, 'billing')).rejects.toThrow(/invalid path segment/)
    await expect(readCurrent('claude', id)).rejects.toThrow(/invalid path segment/)
  }
})

test('eraseLegacyStores removes reports/, history/, and snapshots/ under each plugin dir, leaves current/ledger intact', async () => {
  // Create a plugin dir with legacy stores and surviving modern stores.
  const pluginDir = join(dir, 'claude')

  mkdirSync(join(pluginDir, 'reports'), { recursive: true })
  mkdirSync(join(pluginDir, 'history'), { recursive: true })
  mkdirSync(join(pluginDir, 'snapshots'), { recursive: true })
  mkdirSync(join(pluginDir, 'current'), { recursive: true })
  mkdirSync(join(pluginDir, 'ledger'), { recursive: true })

  await eraseLegacyStores()

  expect(existsSync(join(pluginDir, 'reports'))).toBe(false)
  expect(existsSync(join(pluginDir, 'history'))).toBe(false)
  expect(existsSync(join(pluginDir, 'snapshots'))).toBe(false)
  expect(existsSync(join(pluginDir, 'current'))).toBe(true)
  expect(existsSync(join(pluginDir, 'ledger'))).toBe(true)
})

test('eraseLegacyStores is a no-op when the data root is empty or missing', async () => {
  // Empty data root — no plugin dirs — should not throw.
  await expect(eraseLegacyStores()).resolves.toBeUndefined()
})
