import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// The at-rest encryption core, scoped to a profile directory. One random 256-bit Data Encryption Key (DEK)
// per encrypted profile seals every file in that profile; the DEK itself lives on disk only as two wrapped
// copies (a password slot + a recovery slot) in the profile's vault.json, and in memory only while unlocked.
// Everything here keys off the profile DIRECTORY (not a profile id) so the cross-profile move can hold two
// vaults at once and the store layer can pass the same root it already threads (configRoot / dataRoot).

const KEY_LEN = 32 // AES-256
const SALT_LEN = 16
const IV_LEN = 12 // GCM standard nonce
const TAG_LEN = 16
const MAGIC = Buffer.from('BTNV') // file-envelope marker, so a sealed blob is self-identifying
const ENVELOPE_VERSION = 1
const HEADER_LEN = MAGIC.length + 1 + IV_LEN + TAG_LEN

// scrypt cost. 128 * N * r bytes of memory (~64 MiB at N=2^16) — a deliberate per-guess tax against an
// offline attacker with the disk. Stored per-slot in vault.json so a future bump stays self-describing and
// tests can dial it down.
export type ScryptParams = { N: number; r: number; p: number }
let defaultScryptParams: ScryptParams = { N: 2 ** 16, r: 8, p: 1 }
const MAXMEM = 256 * 1024 * 1024

// Test seam — lower the KDF cost so the crypto tests aren't dominated by key derivation.
export const setScryptParamsForTest = (params: ScryptParams): void => {
  defaultScryptParams = params
}

// A key wrapped under one secret. Two of these (a password slot + a recovery slot) guard the same key, so
// either secret opens it. Used by the profile vault and by the portable profile archive.
export type Slot = { kdf: ScryptParams; salt: string; iv: string; tag: string; wrapped: string }

export type VaultMigration = { phase: 'encrypt' | 'decrypt'; startedAt: string }

type VaultFile = {
  version: number
  slots: { password: Slot; recovery: Slot }
  migration?: VaultMigration
}

export type VaultState = 'off' | 'locked' | 'unlocked'

// The in-memory DEK registry, keyed by the resolved profile dir. A DEK is present exactly while that profile
// is unlocked; lock() zeroes the buffer before dropping it.
const deks = new Map<string, Buffer>()

const keyOf = (dir: string): string => resolve(dir)
const vaultPath = (dir: string): string => join(dir, 'vault.json')

const b64 = (b: Buffer): string => b.toString('base64')
const fromB64 = (s: string): Buffer => Buffer.from(s, 'base64')

const deriveKek = (secret: string, salt: Buffer, kdf: ScryptParams): Buffer =>
  scryptSync(secret.normalize('NFKC'), salt, KEY_LEN, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: MAXMEM })

// AES-256-GCM a buffer under a 32-byte key → a self-identifying envelope (magic + version + iv + tag + ct).
export const sealBytes = (key: Buffer, plaintext: Buffer): Buffer => {
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()])

  return Buffer.concat([MAGIC, Buffer.from([ENVELOPE_VERSION]), iv, cipher.getAuthTag(), ct])
}

// Reverse sealBytes; throws on a wrong key or any tampering (GCM auth-tag verification) or a non-envelope.
export const unsealBytes = (key: Buffer, data: Buffer): Buffer => {
  if (data.length < HEADER_LEN || !data.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('not a butin vault envelope')
  }

  const iv = data.subarray(MAGIC.length + 1, MAGIC.length + 1 + IV_LEN)
  const tag = data.subarray(MAGIC.length + 1 + IV_LEN, HEADER_LEN)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)

  decipher.setAuthTag(tag)

  return Buffer.concat([decipher.update(data.subarray(HEADER_LEN)), decipher.final()])
}

// True when a buffer carries the vault envelope marker — lets the store layer pass plaintext through
// untouched on an OFF profile and tolerate a not-yet-migrated file without throwing.
export const isSealed = (data: Buffer): boolean =>
  data.length >= MAGIC.length && data.subarray(0, MAGIC.length).equals(MAGIC)

export const wrapDek = (secret: string, dek: Buffer): Slot => {
  const salt = randomBytes(SALT_LEN)
  const kdf = defaultScryptParams
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', deriveKek(secret, salt, kdf), iv)
  const wrapped = Buffer.concat([cipher.update(dek), cipher.final()])

  return { kdf, salt: b64(salt), iv: b64(iv), tag: b64(cipher.getAuthTag()), wrapped: b64(wrapped) }
}

// Unwrap a slot's DEK with a secret. null (not throw) on the wrong secret — the caller tries the next slot.
export const unwrapDek = (secret: string, slot: Slot): Buffer | null => {
  try {
    const decipher = createDecipheriv('aes-256-gcm', deriveKek(secret, fromB64(slot.salt), slot.kdf), fromB64(slot.iv))

    decipher.setAuthTag(fromB64(slot.tag))

    return Buffer.concat([decipher.update(fromB64(slot.wrapped)), decipher.final()])
  } catch {
    return null
  }
}

// A printable recovery key: 20 symbols from an unambiguous 32-char alphabet (no O/0/I/1), grouped in fives →
// ~100 bits. 256 % 32 === 0, so the byte→symbol map is unbiased.
const RC_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export const generateRecoveryCode = (): string => {
  const bytes = randomBytes(20)
  let out = ''

  for (const b of bytes) {
    out += RC_ALPHABET[b % 32]
  }

  return (out.match(/.{1,5}/g) ?? []).join('-')
}

// Normalize a typed-back recovery key: case-fold + drop the grouping hyphens/spaces, so formatting is forgiven.
export const normalizeRecovery = (code: string): string => code.toUpperCase().replace(/[^A-Z0-9]/g, '')

const readVaultFile = (dir: string): VaultFile => JSON.parse(readFileSync(vaultPath(dir), 'utf8')) as VaultFile

const writeVaultFile = (dir: string, file: VaultFile): void =>
  writeFileSync(vaultPath(dir), JSON.stringify(file, null, 2))

export const vaultExists = (dir: string): boolean => existsSync(vaultPath(dir))

export const isUnlocked = (dir: string): boolean => deks.has(keyOf(dir))

// True when ANY profile is currently unlocked — the idle/sleep auto-lock skips its work when nothing is open.
export const anyUnlocked = (): boolean => deks.size > 0

export const vaultState = (dir: string): VaultState =>
  !vaultExists(dir) ? 'off' : isUnlocked(dir) ? 'unlocked' : 'locked'

// The unwrapped DEK for an unlocked profile dir, or undefined. Internal to the store layer's envelope.
export const dekForDir = (dir: string): Buffer | undefined => deks.get(keyOf(dir))

// Enable encryption on a profile: mint a fresh DEK, wrap it under the password + a generated recovery key,
// write vault.json, and register the DEK (so the profile is immediately unlocked for the encrypt migration
// the caller runs next). Returns the recovery key to show the user ONCE. Throws if a vault already exists.
export const setupVault = (dir: string, password: string): { recoveryCode: string } => {
  if (vaultExists(dir)) {
    throw new Error('vault already exists for this profile')
  }

  const dek = randomBytes(KEY_LEN)
  const recoveryCode = generateRecoveryCode()

  writeVaultFile(dir, {
    version: 1,
    slots: { password: wrapDek(password, dek), recovery: wrapDek(normalizeRecovery(recoveryCode), dek) }
  })
  deks.set(keyOf(dir), dek)

  return { recoveryCode }
}

// Unlock with a password OR a recovery key (either slot). Registers the DEK and returns true on success;
// false on a wrong secret — never throws for a bad guess.
export const unlockVault = (dir: string, secret: string): boolean => {
  if (!vaultExists(dir)) {
    return false
  }

  const { slots } = readVaultFile(dir)
  const dek = unwrapDek(secret, slots.password) ?? unwrapDek(normalizeRecovery(secret), slots.recovery)

  if (!dek) {
    return false
  }

  deks.set(keyOf(dir), dek)

  return true
}

// Check a password OR recovery key against the slots WITHOUT changing lock state — for re-proving the secret
// before a destructive action (disabling encryption) even while the profile is already unlocked.
export const verifySecret = (dir: string, secret: string): boolean => {
  if (!vaultExists(dir)) {
    return false
  }

  const { slots } = readVaultFile(dir)

  return unwrapDek(secret, slots.password) !== null || unwrapDek(normalizeRecovery(secret), slots.recovery) !== null
}

const zeroAndDrop = (key: string): void => {
  deks.get(key)?.fill(0)
  deks.delete(key)
}

export const lockVault = (dir: string): void => zeroAndDrop(keyOf(dir))

// Zero + drop every registered DEK (app quit / OS sleep / idle timeout).
export const lockAll = (): void => {
  for (const key of [...deks.keys()]) {
    zeroAndDrop(key)
  }
}

// Re-wrap the password slot under a new password, proving the old secret (password or recovery) first.
// false on a wrong old secret.
export const changePassword = (dir: string, oldSecret: string, newPassword: string): boolean => {
  const file = readVaultFile(dir)
  const dek = unwrapDek(oldSecret, file.slots.password) ?? unwrapDek(normalizeRecovery(oldSecret), file.slots.recovery)

  if (!dek) {
    return false
  }

  file.slots.password = wrapDek(newPassword, dek)
  writeVaultFile(dir, file)

  return true
}

// Forgotten-password path: prove the recovery key, set a new password, and leave the profile unlocked.
export const resetViaRecovery = (dir: string, recoveryCode: string, newPassword: string): boolean => {
  const file = readVaultFile(dir)
  const dek = unwrapDek(normalizeRecovery(recoveryCode), file.slots.recovery)

  if (!dek) {
    return false
  }

  file.slots.password = wrapDek(newPassword, dek)
  writeVaultFile(dir, file)
  deks.set(keyOf(dir), dek)

  return true
}

// Tear down the vault record + in-memory DEK. The caller decrypts the tree back to plaintext FIRST (while
// still unlocked); this only removes vault.json and drops the key.
export const disableVault = (dir: string): void => {
  rmSync(vaultPath(dir), { force: true })
  lockVault(dir)
}

// --- migration marker (the resumable enable/disable state) --------------------------------------------

export const getMigration = (dir: string): VaultMigration | undefined =>
  vaultExists(dir) ? readVaultFile(dir).migration : undefined

export const setMigration = (dir: string, migration: VaultMigration | undefined): void => {
  const file = readVaultFile(dir)

  if (migration) {
    file.migration = migration
  } else {
    delete file.migration
  }

  writeVaultFile(dir, file)
}

// --- the store layer's envelope ------------------------------------------------------------------------
// seal/unseal a file's bytes for a profile dir. Only ever called when the dir is unlocked (the store layer
// gates on vaultState); a missing DEK is a programming error, so it throws loudly.

export const sealForDir = (dir: string, plaintext: Buffer): Buffer => {
  const dek = deks.get(keyOf(dir))

  if (!dek) {
    throw new Error('cannot seal: vault is locked')
  }

  return sealBytes(dek, plaintext)
}

export const unsealForDir = (dir: string, data: Buffer): Buffer => {
  const dek = deks.get(keyOf(dir))

  if (!dek) {
    throw new Error('cannot unseal: vault is locked')
  }

  return unsealBytes(dek, data)
}
