import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { readJsonSync } from '../store/secure-fs.js'

import { decryptProfileTree, encryptProfileTree, resumeMigration } from './migrate.js'
import {
  getMigration,
  isSealed,
  lockAll,
  setMigration,
  setScryptParamsForTest,
  setupVault,
  vaultExists
} from './vault.js'

setScryptParamsForTest({ N: 2 ** 8, r: 8, p: 1 })

const dirs: string[] = []

const seedProfile = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'butin-migrate-'))

  dirs.push(dir)
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ plugins: { sentry: { cookie: 'abc' } } }))
  mkdirSync(join(dir, 'sentry', 'current'), { recursive: true })
  writeFileSync(join(dir, 'sentry', 'current', 'issues.json'), JSON.stringify({ rows: [1, 2, 3] }))
  mkdirSync(join(dir, 'sentry', 'ledger'), { recursive: true })
  writeFileSync(join(dir, 'sentry', 'ledger', 'issues.json'), JSON.stringify({ points: [] }))

  return dir
}

const fileBytes = (dir: string, ...parts: string[]): Buffer => readFileSync(join(dir, ...parts))

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('per-profile migration', () => {
  let dir: string

  beforeEach(() => {
    lockAll()
    dir = seedProfile()
  })

  it('encrypts every tree file (except vault.json) and reads back via secure-fs', () => {
    setupVault(dir, 'pw') // registers the DEK → unlocked

    encryptProfileTree(dir)

    expect(isSealed(fileBytes(dir, 'config.json'))).toBe(true)
    expect(isSealed(fileBytes(dir, 'sentry', 'current', 'issues.json'))).toBe(true)
    expect(isSealed(fileBytes(dir, 'vault.json'))).toBe(false) // the header stays in the clear
    expect(getMigration(dir)).toBeUndefined() // marker cleared on completion

    // The store layer reads them transparently under the unlocked DEK.
    expect(readJsonSync<{ rows: number[] }>(dir, join(dir, 'sentry', 'current', 'issues.json'))?.rows).toEqual([
      1, 2, 3
    ])
  })

  it('decrypts back to byte-identical plaintext (enable → disable round-trip)', () => {
    const before = fileBytes(dir, 'sentry', 'current', 'issues.json')

    setupVault(dir, 'pw')
    encryptProfileTree(dir)
    decryptProfileTree(dir)

    expect(isSealed(fileBytes(dir, 'config.json'))).toBe(false)
    expect(fileBytes(dir, 'sentry', 'current', 'issues.json').equals(before)).toBe(true)
  })

  it('is idempotent — re-encrypting a sealed tree is a no-op, still decryptable', () => {
    setupVault(dir, 'pw')
    encryptProfileTree(dir)
    const sealed = fileBytes(dir, 'config.json')

    encryptProfileTree(dir) // second pass must NOT double-seal

    expect(fileBytes(dir, 'config.json').equals(sealed)).toBe(true)
    decryptProfileTree(dir)
    expect(readJsonSync<{ plugins: object }>(dir, join(dir, 'config.json'))).toBeTruthy()
  })

  it('resumeMigration finishes an interrupted encrypt pass', () => {
    setupVault(dir, 'pw')
    // Simulate a crash: one file sealed, the marker still set, the rest plaintext.
    setMigration(dir, { phase: 'encrypt', startedAt: '2026-06-17T00:00:00.000Z' })

    expect(resumeMigration(dir)).toBe(true)

    expect(isSealed(fileBytes(dir, 'config.json'))).toBe(true)
    expect(isSealed(fileBytes(dir, 'sentry', 'ledger', 'issues.json'))).toBe(true)
    expect(getMigration(dir)).toBeUndefined()
  })

  it('resumeMigration is a no-op without a marker or while locked', () => {
    setupVault(dir, 'pw')
    expect(resumeMigration(dir)).toBe(false) // no marker

    encryptProfileTree(dir)
    setMigration(dir, { phase: 'encrypt', startedAt: '2026-06-17T00:00:00.000Z' })
    lockAll() // drop the DEK

    expect(resumeMigration(dir)).toBe(false) // marker present but locked → can't run
    expect(vaultExists(dir)).toBe(true)
  })
})
