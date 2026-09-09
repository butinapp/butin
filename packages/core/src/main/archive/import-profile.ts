import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'

import { encryptValueFor, isSecretField, readConfigAt, writeConfigAt } from '../store/config-file.js'
import { adoptProfileTree, type ProfileSummary, profilesDir } from '../store/profiles.js'

import { type ArchiveIndex, type ArchiveProgress, openArchive, servicesIn } from './container.js'

// Restoring a packed profile. Everything lands in a dot-prefixed staging folder first and is verified as it is
// written; only once the whole tree is down does it become a profile (a same-volume rename, then the registry
// entry). Any failure removes the staging folder, so there is no partially-imported state and no registry entry
// pointing at half a profile.

export type ProfileImportPreview = {
  profileName: string
  color?: string
  createdAt: string
  appVersion: string
  packedAt: string
  fileCount: number
  totalBytes: number
  services: string[]
  reHomed: string[]
  unreadableSecrets: string[]
  sourceEncrypted: boolean
}

export type ProfileImportResult = ProfileImportPreview & { profile: ProfileSummary }

const toPreview = (index: ArchiveIndex): ProfileImportPreview => ({
  profileName: index.profile.name,
  color: index.profile.color,
  createdAt: index.profile.createdAt,
  appVersion: index.appVersion,
  packedAt: index.createdAt,
  fileCount: index.entries.length,
  totalBytes: index.totalBytes,
  services: servicesIn(index),
  reHomed: index.reHomed ?? [],
  unreadableSecrets: index.unreadableSecrets ?? [],
  sourceEncrypted: index.sourceEncrypted ?? false
})

// Unseal only the index, so the user sees what an import would land before anything is written.
export const inspectProfileArchive = async (path: string, secret: string): Promise<ProfileImportPreview> => {
  const reader = await openArchive(path, secret)

  try {
    return toPreview(reader.index)
  } finally {
    await reader.close()
  }
}

// An archive path resolved under the staging dir, or null when it tries to escape it. Entry paths come from a
// file the user was handed by someone else, so they are treated as untrusted input.
const resolveEntryPath = (stagingDir: string, path: string): string | null => {
  const segments = path.split('/')

  if (/^([a-zA-Z]:|[\\/])/.test(path) || segments.some((s) => s === '' || s === '.' || s === '..')) {
    return null
  }

  return join(stagingDir, ...segments)
}

// Re-encrypt every stored secret under THIS machine's safeStorage. The archive carries them in portable
// plaintext (sealed by the container, not by the OS user), which is exactly why they survived the trip — and
// exactly why they must be re-keyed before the profile goes live.
const rekeySecrets = (dir: string): void => {
  const config = readConfigAt(dir)

  for (const entry of Object.values(config.plugins)) {
    for (const [field, value] of Object.entries(entry)) {
      if (!isSecretField(field) || typeof value !== 'string') {
        continue
      }

      const { stored, enc } = encryptValueFor(dir, value)

      entry[field] = stored
      entry[`${field}_enc`] = enc
    }
  }

  writeConfigAt(dir, config)
}

// `name` renames the profile as it lands (the import panel offers it, pre-filled from the archive). Blank or
// absent keeps the archived name.
export const importProfileArchive = async (
  path: string,
  secret: string,
  opts: { name?: string; onProgress?: ArchiveProgress } = {}
): Promise<ProfileImportResult> => {
  const { name, onProgress } = opts
  const reader = await openArchive(path, secret)
  const preview = toPreview(reader.index)
  const stagingDir = join(profilesDir(), `.import-${Date.now().toString(36)}`)

  try {
    await mkdir(stagingDir, { recursive: true })

    let done = 0

    for await (const { entry, chunks } of reader.entries()) {
      const target = resolveEntryPath(stagingDir, entry.path)

      if (!target) {
        throw new Error(`the archive contains an unsafe path: ${entry.path}`)
      }

      onProgress?.({ phase: 'restoring', message: entry.path, completed: done, total: preview.totalBytes })

      const hash = createHash('sha256')

      await mkdir(dirname(target), { recursive: true })
      // Straight to disk, hashing in passing: a documents tree holds files far too large to hold whole.
      await pipeline(async function* () {
        for await (const chunk of chunks) {
          hash.update(chunk)
          done += chunk.length
          onProgress?.({ phase: 'restoring', message: entry.path, completed: done, total: preview.totalBytes })

          yield chunk
        }
      }, createWriteStream(target))

      // Verified after the write, not before it — the staging folder is thrown away whole on any failure, so a
      // bad file never reaches a real profile.
      if (hash.digest('hex') !== entry.sha256) {
        throw new Error(`${entry.path} did not survive the trip intact`)
      }
    }

    rekeySecrets(stagingDir)

    const adopted = adoptProfileTree(stagingDir, { ...reader.index.profile, name: name?.trim() || preview.profileName })

    return { ...preview, profileName: adopted.name, profile: adopted }
  } catch (err) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {})

    throw err
  } finally {
    await reader.close()
  }
}
