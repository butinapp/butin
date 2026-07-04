import type { ExportBundle } from '@butinapp/shapes/bundle'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { isSealed, lockAll, setScryptParamsForTest, setupVault } from '../vault/vault.js'

import { exportFileName, writeExportFile } from './export-data.js'

const bundle: ExportBundle = { formatVersion: 1, generatedAt: '2026-06-17T12:00:00.000Z', plugins: [], overview: [] }

describe('exportFileName', () => {
  it('builds a filesystem-safe, second-trimmed name', () => {
    expect(exportFileName('Work / Home', new Date('2026-06-17T09:08:07.123Z'))).toBe(
      'butin-Work-Home-2026-06-17T09-08-07.json'
    )
  })
})

describe('writeExportFile', () => {
  afterEach(() => lockAll())

  it('writes a plaintext JSON bundle when not encrypting', async () => {
    const destPath = join(mkdtempSync(join(tmpdir(), 'butin-export-')), 'out.json')

    const { path } = await writeExportFile({ bundle, root: tmpdir(), destPath, encrypt: false })

    expect(path).toBe(destPath)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(bundle)
  })

  it('ignores encrypt when the profile has no vault (plaintext, no .btnv suffix)', async () => {
    const destPath = join(mkdtempSync(join(tmpdir(), 'butin-export-')), 'out.json')

    const { path } = await writeExportFile({ bundle, root: tmpdir(), destPath, encrypt: true })

    expect(path).toBe(destPath)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(bundle)
  })

  it('seals with the profile vault and suffixes .btnv when encrypting an unlocked profile', async () => {
    setScryptParamsForTest({ N: 2 ** 8, r: 8, p: 1 })

    const root = mkdtempSync(join(tmpdir(), 'butin-export-vault-'))

    setupVault(root, 'pw') // leaves the profile unlocked

    const destPath = join(root, 'out.json')
    const { path } = await writeExportFile({ bundle, root, destPath, encrypt: true })

    expect(path).toBe(`${destPath}.btnv`)
    expect(isSealed(readFileSync(path))).toBe(true)
    expect(() => JSON.parse(readFileSync(path, 'utf8'))).toThrow()
  })
})
