import { createReadStream } from 'node:fs'

import { type Config, decryptValue, readConfigAt } from '../store/config-file.js'
import { listProfiles, profileDir } from '../store/profiles.js'
import { readBytes } from '../store/secure-fs.js'
import { profileWritesInFlight } from '../store/store.js'
import { walkFiles } from '../store/walk.js'
import { vaultExists, vaultState } from '../vault/vault.js'

import { type ArchiveProgress, type ArchiveSource, servicesIn, writeArchive } from './container.js'

// Packing a profile for another computer. What makes this more than a folder copy:
//
//  - `safeStorage` secrets are bound to the OS user, so they are decrypted on the way out (import re-encrypts
//    under the target machine's key). Without that step the copy comes up looking connected while every fetch
//    silently finds no session — decryptValue treats an undecryptable secret as absent by design.
//  - a plugin's documents folder may have been redirected outside the profile tree, so "the profile folder" is
//    not the full set of downloaded files. Those are packed under the plugin's own documents/ path and the
//    override is dropped, since the source path may not exist on the other machine.

// The vault's own files, which never travel: the archive carries the profile's DECRYPTED contents, so a vault
// record would describe a key the tree is no longer sealed with.
const isVaultFile = (rel: string): boolean => rel === 'vault.json' || rel.endsWith('.btn-migrate-tmp')

export type ProfileExportResult = {
  path: string
  recoveryCode: string
  fileCount: number
  totalBytes: number
  services: string[]
  reHomed: string[]
  unreadableSecrets: string[]
  sourceEncrypted: boolean
}

type PlannedFile = { path: string; size: number; abs?: string; bytes?: Buffer }

// A plugin whose documents folder points outside the profile tree, and where it points. Read off the profile
// being exported — never off the active profile's config, which may be a different one entirely.
type DocsOverride = { pluginId: string; dir: string }

// The profile's config with every secret in portable form: `safeStorage` values decrypted (the `_enc` flag
// dropped with them), and each redirected documents folder un-redirected, since export re-homes those files
// into the profile's own tree. A secret that will not decrypt HERE is dropped and named, so the archive never
// ships a broken value that would look like a working session on the other machine.
const portableConfig = (dir: string): { config: Config; unreadableSecrets: string[]; overrides: DocsOverride[] } => {
  const config = readConfigAt(dir)
  const unreadableSecrets: string[] = []
  const overrides: DocsOverride[] = []

  for (const [pluginId, entry] of Object.entries(config.plugins)) {
    for (const key of Object.keys(entry)) {
      if (!key.endsWith('_enc') || entry[key] !== true) {
        continue
      }

      const field = key.slice(0, -'_enc'.length)
      const stored = entry[field]
      const plain = typeof stored === 'string' ? decryptValue(stored, true) : undefined

      if (plain === undefined) {
        unreadableSecrets.push(`${pluginId}.${field}`)
        delete entry[field]
      } else {
        entry[field] = plain
      }

      delete entry[key]
    }

    if (typeof entry.documentsOutputDir === 'string' && entry.documentsOutputDir !== '') {
      overrides.push({ pluginId, dir: entry.documentsOutputDir })
      delete entry.documentsOutputDir
    }
  }

  return { config, unreadableSecrets, overrides }
}

// A path no earlier entry claimed. An external documents folder can hold a file whose name matches one already
// in the profile's own documents/ — they are different files, so the newcomer is suffixed rather than dropped.
const uniquePath = (taken: Set<string>, path: string): string => {
  if (!taken.has(path)) {
    taken.add(path)

    return path
  }

  const dot = path.lastIndexOf('.')
  const [stem, ext] = dot > path.lastIndexOf('/') ? [path.slice(0, dot), path.slice(dot)] : [path, '']

  for (let n = 2; ; n += 1) {
    const candidate = `${stem}-${n}${ext}`

    if (!taken.has(candidate)) {
      taken.add(candidate)

      return candidate
    }
  }
}

// Read one of the profile's files. An encrypted profile's files are whole-file sealed envelopes, so they are
// decrypted in memory; a plaintext file streams off disk and never lands in memory whole.
const openFile = (dir: string, abs: string, sealed: boolean): (() => AsyncIterable<Buffer>) =>
  sealed
    ? async function* () {
        const bytes = await readBytes(dir, abs)

        if (bytes === null) {
          throw new Error(`could not read ${abs} from the profile`)
        }

        yield bytes
      }
    : () => createReadStream(abs)

export const exportProfileArchive = async (
  profileId: string,
  target: string,
  secret: string,
  appVersion: string,
  onProgress?: ArchiveProgress
): Promise<ProfileExportResult> => {
  const record = listProfiles().find((p) => p.id === profileId)

  if (!record) {
    throw new Error('profile not found')
  }

  const dir = profileDir(profileId)

  if (vaultState(dir) === 'locked') {
    throw new Error('unlock this profile before exporting it')
  }

  // A capability run or a download in flight is writing into this tree right now; a file caught half-written
  // would restore as corrupt data on the other machine.
  if (profileWritesInFlight()) {
    throw new Error('a refresh is running — wait for it to finish, then export')
  }

  const sealed = vaultExists(dir)
  const { config, unreadableSecrets, overrides } = portableConfig(dir)
  const reHomed = overrides.map((o) => o.pluginId)
  const taken = new Set<string>()
  const planned: PlannedFile[] = []
  const configBytes = Buffer.from(JSON.stringify(config, null, 2))

  planned.push({ path: uniquePath(taken, 'config.json'), size: configBytes.length, bytes: configBytes })

  for (const file of await walkFiles(dir)) {
    if (file.rel === 'config.json' || isVaultFile(file.rel)) {
      continue
    }

    planned.push({ path: uniquePath(taken, file.rel), size: file.size, abs: file.abs })
  }

  for (const { pluginId, dir: outside } of overrides) {
    for (const file of await walkFiles(outside)) {
      planned.push({ path: uniquePath(taken, `${pluginId}/documents/${file.rel}`), size: file.size, abs: file.abs })
    }
  }

  const totalBytes = planned.reduce((sum, f) => sum + f.size, 0)
  const sources: ArchiveSource[] = planned.map((f) => ({
    path: f.path,
    size: f.size,
    open: f.bytes
      ? async function* () {
          yield f.bytes!
        }
      : openFile(dir, f.abs!, sealed)
  }))

  const { recoveryCode, index } = await writeArchive(
    target,
    secret,
    {
      profile: { name: record.name, color: record.color, createdAt: record.createdAt },
      appVersion,
      reHomed,
      unreadableSecrets,
      sourceEncrypted: sealed
    },
    sources,
    totalBytes,
    onProgress
  )

  return {
    path: target,
    recoveryCode,
    fileCount: index.entries.length,
    totalBytes: index.totalBytes,
    services: servicesIn(index),
    reHomed,
    unreadableSecrets,
    sourceEncrypted: sealed
  }
}
