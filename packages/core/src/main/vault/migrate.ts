import { readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { dekForDir, getMigration, isSealed, sealForDir, setMigration, unsealForDir } from './vault.js'

// Encrypt (enable) or decrypt (disable) a profile's whole tree IN PLACE. Both directions are idempotent and
// crash-safe: each file is written temp-then-rename (atomic), already-converted files are skipped (so a
// re-run finishes an interrupted pass), and a marker in vault.json records that a pass is underway so boot
// can resume one. vault.json itself is the one file left in the clear (it's the header — no secrets).

const VAULT_FILE = 'vault.json'
const TMP_SUFFIX = '.btn-migrate-tmp'

const allFiles = (dir: string): string[] => {
  const out: string[] = []

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name)

    if (entry.isDirectory()) {
      out.push(...allFiles(abs))
    } else if (entry.isFile()) {
      out.push(abs)
    }
  }

  return out
}

const atomicWrite = (path: string, bytes: Buffer): void => {
  const tmp = `${path}${TMP_SUFFIX}`

  writeFileSync(tmp, bytes)
  renameSync(tmp, path)
}

// Convert every eligible file in the tree with `transform`, skipping vault.json, leftover temp files (a
// crashed prior pass — removed), and files `transform` returns null for (already in the target state).
const convertTree = (dir: string, phase: 'encrypt' | 'decrypt', transform: (raw: Buffer) => Buffer | null): void => {
  setMigration(dir, { phase, startedAt: new Date().toISOString() })

  for (const file of allFiles(dir)) {
    if (file.endsWith(TMP_SUFFIX)) {
      rmSync(file, { force: true })

      continue
    }

    if (file === join(dir, VAULT_FILE)) {
      continue
    }

    const next = transform(readFileSync(file))

    if (next !== null) {
      atomicWrite(file, next)
    }
  }

  setMigration(dir, undefined)
}

// Seal every plaintext file (skip already-sealed). The profile must be unlocked (DEK registered).
export const encryptProfileTree = (dir: string): void =>
  convertTree(dir, 'encrypt', (raw) => (isSealed(raw) ? null : sealForDir(dir, raw)))

// Unseal every sealed file back to plaintext (skip files already in the clear). The profile must be unlocked.
export const decryptProfileTree = (dir: string): void =>
  convertTree(dir, 'decrypt', (raw) => (isSealed(raw) ? unsealForDir(dir, raw) : null))

// Finish an interrupted enable/disable, once the profile is unlocked. No-op (returns false) when there's no
// pending marker or the profile is still locked. Idempotent — safe to call on every boot.
export const resumeMigration = (dir: string): boolean => {
  const migration = getMigration(dir)

  if (!migration || !dekForDir(dir)) {
    return false
  }

  if (migration.phase === 'encrypt') {
    encryptProfileTree(dir)
  } else {
    decryptProfileTree(dir)
  }

  return true
}
