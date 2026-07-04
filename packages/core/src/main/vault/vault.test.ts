import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import {
  changePassword,
  disableVault,
  getMigration,
  isSealed,
  lockAll,
  lockVault,
  resetViaRecovery,
  sealBytes,
  setMigration,
  setScryptParamsForTest,
  setupVault,
  unlockVault,
  unsealBytes,
  unsealForDir,
  sealForDir,
  vaultExists,
  vaultState,
  verifySecret
} from './vault.js'

// Cheap KDF so the suite isn't dominated by scrypt.
setScryptParamsForTest({ N: 2 ** 8, r: 8, p: 1 })

const dirs: string[] = []

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'butin-vault-'))

  dirs.push(dir)

  return dir
}

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('vault crypto core', () => {
  let dir: string

  beforeEach(() => {
    lockAll()
    dir = tempDir()
  })

  it('starts OFF, becomes UNLOCKED after setup', () => {
    expect(vaultState(dir)).toBe('off')

    const { recoveryCode } = setupVault(dir, 'hunter2')

    expect(recoveryCode).toMatch(/^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/)
    expect(vaultExists(dir)).toBe(true)
    expect(vaultState(dir)).toBe('unlocked')
  })

  it('round-trips a buffer while unlocked', () => {
    setupVault(dir, 'pw')

    const plaintext = Buffer.from('the haul — médical, $1,234.56', 'utf8')
    const sealed = sealForDir(dir, plaintext)

    expect(isSealed(sealed)).toBe(true)
    expect(sealed.equals(plaintext)).toBe(false)
    expect(unsealForDir(dir, sealed).equals(plaintext)).toBe(true)
  })

  it('locks → state LOCKED and seal/unseal throw', () => {
    setupVault(dir, 'pw')
    const sealed = sealForDir(dir, Buffer.from('x'))

    lockVault(dir)

    expect(vaultState(dir)).toBe('locked')
    expect(() => sealForDir(dir, Buffer.from('x'))).toThrow()
    expect(() => unsealForDir(dir, sealed)).toThrow()
  })

  it('unlocks with the correct password, rejects a wrong one', () => {
    const plaintext = Buffer.from('secret')

    setupVault(dir, 'correct horse')
    const sealed = sealForDir(dir, plaintext)

    lockVault(dir)

    expect(unlockVault(dir, 'wrong')).toBe(false)
    expect(vaultState(dir)).toBe('locked')

    expect(unlockVault(dir, 'correct horse')).toBe(true)
    expect(unsealForDir(dir, sealed).equals(plaintext)).toBe(true)
  })

  it('unlocks with the recovery key (formatting forgiven)', () => {
    const { recoveryCode } = setupVault(dir, 'pw')
    const sealed = sealForDir(dir, Buffer.from('data'))

    lockVault(dir)

    // Lowercased + spaces instead of hyphens still unlocks.
    expect(unlockVault(dir, recoveryCode.toLowerCase().replace(/-/g, ' '))).toBe(true)
    expect(unsealForDir(dir, sealed).toString()).toBe('data')
  })

  it('changePassword: new works, old stops working', () => {
    setupVault(dir, 'old-pw')
    lockVault(dir)

    expect(changePassword(dir, 'wrong-old', 'new-pw')).toBe(false)
    expect(changePassword(dir, 'old-pw', 'new-pw')).toBe(true)

    expect(unlockVault(dir, 'old-pw')).toBe(false)
    expect(unlockVault(dir, 'new-pw')).toBe(true)
  })

  it('resetViaRecovery: recovery sets a new password and leaves it unlocked', () => {
    const { recoveryCode } = setupVault(dir, 'forgotten')
    const sealed = sealForDir(dir, Buffer.from('kept'))

    lockVault(dir)

    expect(resetViaRecovery(dir, 'NOTTHE-RIGHT-CODE0-HEREX', 'whatever')).toBe(false)
    expect(resetViaRecovery(dir, recoveryCode, 'brand-new')).toBe(true)
    expect(vaultState(dir)).toBe('unlocked')
    // The pre-existing data still decrypts (same DEK, only the password slot was re-wrapped).
    expect(unsealForDir(dir, sealed).toString()).toBe('kept')

    lockVault(dir)
    expect(unlockVault(dir, 'brand-new')).toBe(true)
  })

  it('verifySecret checks a password/recovery key without changing lock state', () => {
    const { recoveryCode } = setupVault(dir, 'pw')

    // Unlocked + correct → true, and it does NOT lock or unlock (state unchanged).
    expect(verifySecret(dir, 'pw')).toBe(true)
    expect(verifySecret(dir, recoveryCode)).toBe(true)
    expect(verifySecret(dir, 'nope')).toBe(false)
    expect(vaultState(dir)).toBe('unlocked')

    // Still verifiable while locked (reads the slots, doesn't register a DEK).
    lockVault(dir)
    expect(verifySecret(dir, 'pw')).toBe(true)
    expect(vaultState(dir)).toBe('locked')
  })

  it('detects tampering (GCM auth-tag failure)', () => {
    setupVault(dir, 'pw')
    const sealed = sealForDir(dir, Buffer.from('important'))
    const tampered = Buffer.from(sealed)

    tampered[tampered.length - 1] ^= 0xff

    expect(() => unsealForDir(dir, tampered)).toThrow()
  })

  it('disableVault removes vault.json and drops the key', () => {
    setupVault(dir, 'pw')
    expect(vaultExists(dir)).toBe(true)

    disableVault(dir)

    expect(vaultExists(dir)).toBe(false)
    expect(vaultState(dir)).toBe('off')
  })

  it('persists + clears a migration marker', () => {
    setupVault(dir, 'pw')

    expect(getMigration(dir)).toBeUndefined()
    setMigration(dir, { phase: 'encrypt', startedAt: '2026-06-17T00:00:00.000Z' })
    expect(getMigration(dir)?.phase).toBe('encrypt')
    setMigration(dir, undefined)
    expect(getMigration(dir)).toBeUndefined()
  })

  it('a wrong DEK cannot unseal another vault’s data', () => {
    const a = tempDir()
    const b = tempDir()

    setupVault(a, 'pw-a')
    setupVault(b, 'pw-b')

    const sealedA = sealForDir(a, Buffer.from('only-A'))

    expect(() => unsealForDir(b, sealedA)).toThrow()
  })

  it('standalone sealBytes/unsealBytes round-trip with an explicit key', () => {
    const key = Buffer.alloc(32, 7)
    const sealed = sealBytes(key, Buffer.from('payload'))

    expect(unsealBytes(key, sealed).toString()).toBe('payload')
  })

  it('a vault.json written to disk holds no plaintext DEK', () => {
    setupVault(dir, 'pw')
    const raw = readFileSync(join(dir, 'vault.json'), 'utf8')

    // Two wrapped slots, no field literally named dek/key holding the secret.
    expect(raw).toContain('password')
    expect(raw).toContain('recovery')
    expect(raw).not.toContain('"dek"')
  })

  it('treats a foreign (non-envelope) buffer as not sealed', () => {
    writeFileSync(join(dir, 'plain.txt'), 'hello')
    expect(isSealed(readFileSync(join(dir, 'plain.txt')))).toBe(false)
  })
})
