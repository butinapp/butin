import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { isSealed, lockAll, lockVault, setScryptParamsForTest, setupVault } from '../vault/vault.js'

import { readBytes, readJson, writeBytes, writeJson } from './secure-fs.js'

// Lower the KDF cost so vault setup/unlock isn't dominated by scrypt.
setScryptParamsForTest({ N: 2 ** 8, r: 8, p: 1 })

describe('secure-fs', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'butin-secure-fs-'))
  })

  // Drop any in-memory DEK so the next case's vault state starts clean.
  afterEach(() => lockAll())

  it('round-trips plaintext on an OFF profile and leaves the file unsealed', async () => {
    const path = join(dir, 'plain.bin')
    const bytes = Buffer.from('hello world')

    await writeBytes(dir, path, bytes)

    expect(await readBytes(dir, path)).toEqual(bytes)
    expect(isSealed(readFileSync(path))).toBe(false)
  })

  it('seals on disk but round-trips through readJson when the vault is unlocked', async () => {
    setupVault(dir, 'pw') // leaves the profile unlocked

    const path = join(dir, 'config.json')
    const value = { plugins: { sentry: { enabled: true } } }

    await writeJson(dir, path, value)

    expect(isSealed(readFileSync(path))).toBe(true)
    expect(await readJson(dir, path)).toEqual(value)
  })

  it('returns null on read and throws on write once the vault is locked', async () => {
    setupVault(dir, 'pw')

    const path = join(dir, 'data.json')

    await writeJson(dir, path, { a: 1 })
    lockVault(dir)

    expect(await readBytes(dir, path)).toBeNull()
    await expect(writeBytes(dir, join(dir, 'other.bin'), Buffer.from('x'))).rejects.toThrow(/locked/i)
  })
})
