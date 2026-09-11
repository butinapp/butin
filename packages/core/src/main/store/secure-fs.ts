import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { isSealed, isUnlocked, sealForDir, unsealForDir, vaultExists } from '../vault/vault.js'

// The single point where a profile's files meet the disk. Whether a profile is encrypted is invisible to
// every caller: the same read/write calls work either way. `profileDir` is the profile's root (the same
// configRoot/dataRoot the store already threads); `path` is any file under it.
//
//   OFF      (no vault)         → bytes pass straight through (today's behavior)
//   UNLOCKED (vault + DEK)      → bytes are sealed on write, unsealed on read (a not-yet-migrated plaintext
//                                 file is tolerated on read so a half-migrated tree never hard-fails)
//   LOCKED   (vault, no DEK)    → reads yield null (unreadable), writes throw (the store layer never writes a
//                                 locked profile; the lock gate prevents it, and a throw beats silent loss)

const encode = (profileDir: string, bytes: Buffer): Buffer => {
  if (!vaultExists(profileDir)) {
    return bytes
  }

  if (!isUnlocked(profileDir)) {
    throw new Error('cannot write to a locked profile')
  }

  return sealForDir(profileDir, bytes)
}

const decode = (profileDir: string, raw: Buffer): Buffer | null => {
  if (!vaultExists(profileDir)) {
    return raw
  }

  if (!isUnlocked(profileDir)) {
    return null
  }

  return isSealed(raw) ? unsealForDir(profileDir, raw) : raw
}

export const readBytesSync = (profileDir: string, path: string): Buffer | null => {
  if (!existsSync(path)) {
    return null
  }

  return decode(profileDir, readFileSync(path))
}

// A write lands whole or not at all: the bytes go to a sibling temp file that is renamed over the target,
// so a crash mid-write leaves the previous file intact rather than a truncated one. Owner-only mode on the
// platforms that honour it. A leftover temp file (crash between write and rename) is inert: no reader lists it.
const tempPath = (path: string): string => `${path}.${randomBytes(4).toString('hex')}.tmp`

export const writeBytesSync = (profileDir: string, path: string, bytes: Buffer): void => {
  const tmp = tempPath(path)

  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(tmp, encode(profileDir, bytes), { mode: 0o600 })
  renameSync(tmp, path)
}

export const readBytes = async (profileDir: string, path: string): Promise<Buffer | null> => {
  let raw: Buffer

  try {
    raw = await readFile(path)
  } catch {
    return null // absent (or unreadable) — the "no data yet" signal
  }

  return decode(profileDir, raw)
}

export const writeBytes = async (profileDir: string, path: string, bytes: Buffer): Promise<void> => {
  const tmp = tempPath(path)

  await mkdir(dirname(path), { recursive: true })
  await writeFile(tmp, encode(profileDir, bytes), { mode: 0o600 })
  await rename(tmp, path)
}

// JSON convenience wrappers. A locked/absent/corrupt read yields null — the same "no cache yet" signal the
// store layer already treats as empty everywhere.
export const readJsonSync = <T>(profileDir: string, path: string): T | null => {
  const raw = readBytesSync(profileDir, path)

  if (raw === null) {
    return null
  }

  try {
    return JSON.parse(raw.toString('utf8')) as T
  } catch {
    return null
  }
}

export const writeJsonSync = (profileDir: string, path: string, value: unknown): void =>
  writeBytesSync(profileDir, path, Buffer.from(JSON.stringify(value, null, 2), 'utf8'))

export const readJson = async <T>(profileDir: string, path: string): Promise<T | null> => {
  const raw = await readBytes(profileDir, path)

  if (raw === null) {
    return null
  }

  try {
    return JSON.parse(raw.toString('utf8')) as T
  } catch {
    return null
  }
}

export const writeJson = (profileDir: string, path: string, value: unknown): Promise<void> =>
  writeBytes(profileDir, path, Buffer.from(JSON.stringify(value, null, 2), 'utf8'))
