import type { ExportBundle } from '@butinapp/shapes/bundle'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { isSealed, lockAll, setScryptParamsForTest, setupVault } from '../vault/vault.js'

import { FileReportStore } from './report-store.js'
import { setDataRoot } from './store.js'

const bundle: ExportBundle = {
  formatVersion: 1,
  generatedAt: '2026-06-14T12:00:00.000Z',
  plugins: [],
  overview: []
}

describe('FileReportStore', () => {
  afterEach(() => setDataRoot(join(tmpdir(), 'butin'))) // leave the seam somewhere harmless

  it('round-trips a bundle through put → list → get', async () => {
    setDataRoot(mkdtempSync(join(tmpdir(), 'butin-store-')))
    const store = new FileReportStore()

    const ref = await store.put(bundle)

    expect(ref.path).toMatch(/exports[\\/]snapshot-.*\.json$/)

    const refs = await store.list()

    expect(refs.map((r) => r.id)).toContain(ref.id)
    expect(await store.get(ref)).toEqual(bundle)
  })

  it('lists nothing when the exports folder was never written', async () => {
    setDataRoot(mkdtempSync(join(tmpdir(), 'butin-store-empty-')))

    expect(await new FileReportStore().list()).toEqual([])
  })

  it('seals the bundle on disk for an encrypted profile but round-trips through get', async () => {
    setScryptParamsForTest({ N: 2 ** 8, r: 8, p: 1 })

    const dir = mkdtempSync(join(tmpdir(), 'butin-store-vault-'))

    setDataRoot(dir)
    setupVault(dir, 'pw') // leaves the profile unlocked

    const store = new FileReportStore()
    const ref = await store.put(bundle)

    expect(isSealed(readFileSync(ref.path!))).toBe(true)
    expect(await store.get(ref)).toEqual(bundle)

    lockAll()
  })
})
