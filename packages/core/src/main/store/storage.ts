import { app, session, shell } from 'electron'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { StorageLocationDto, StorageLocationKind, StorageSurface } from '../../shared/ipc.js'
import { activePartition, activePartitionDir } from '../browser/shared-session.js'
import { clearLogs, logDir } from '../log.js'
import { clearAllSpaBearers } from '../session/spa-session.js'

import { clearAllCredentials } from './credentials.js'
import { homeRootDir } from './profiles.js'
import { computeFolderStats } from './service-detail.js'
import { dataRootDir } from './store.js'

// Files inside the active profile's data folder that are config, not captured data — kept when clearing the
// cached-data surface (the encrypted credentials + the vault envelope), so a re-fetch rebuilds without a re-login.
const PROFILE_CONFIG_FILES = new Set(['config.json', 'vault.json'])

// The absolute path of a storage location. Butin-owned folders live under ~/butin (or its active profile);
// the system trio is Electron's per-user app data + the folder the running binary sits in.
const locationPath = (kind: StorageLocationKind): string => {
  switch (kind) {
    case 'data':
      return dataRootDir()
    case 'session':
      return activePartitionDir()
    case 'logs':
      return logDir()
    case 'install':
      return dirname(app.getPath('exe'))
  }
}

const SYSTEM_KINDS = new Set<StorageLocationKind>(['install'])
const LOCATION_KINDS: StorageLocationKind[] = ['data', 'session', 'logs', 'install']

export const storageLocations = (): StorageLocationDto[] =>
  LOCATION_KINDS.map((kind) => ({ kind, path: locationPath(kind), system: SYSTEM_KINDS.has(kind) }))

// One location's on-disk byte total via the shared async walk (0 for a folder that doesn't exist yet).
export const storageLocationSize = async (kind: StorageLocationKind): Promise<number> =>
  (await computeFolderStats(locationPath(kind))).totalBytes

// Open a location in the OS file manager; a Butin-owned folder may not exist until first use, so ensure it.
export const revealStorageLocation = async (kind: StorageLocationKind): Promise<void> => {
  const dir = locationPath(kind)

  await mkdir(dir, { recursive: true }).catch(() => {})
  await shell.openPath(dir)
}

// Empty the active profile's browser-session partition — cookies, cache, local/IndexedDB storage — and drop
// any in-memory minted bearers tied to it.
const clearBrowserSessions = async (): Promise<void> => {
  const ses = session.fromPartition(activePartition())

  await ses.clearStorageData()
  await ses.clearCache()
  clearAllSpaBearers()
}

// Remove every service's data folder in the active profile (cached reports, ledgers, downloaded files,
// extracts, caches), keeping only the profile's config files so connections survive.
const clearCachedData = async (): Promise<void> => {
  const root = dataRootDir()

  let entries: string[]

  try {
    entries = await readdir(root)
  } catch {
    return
  }

  for (const entry of entries) {
    if (!PROFILE_CONFIG_FILES.has(entry)) {
      await rm(join(root, entry), { recursive: true, force: true })
    }
  }
}

// Delete the on-disk log folder (it recreates on the next write) and empty the in-memory ring.
const clearAllLogs = async (): Promise<void> => {
  clearLogs()
  await rm(logDir(), { recursive: true, force: true })
}

// Wipe the entire ~/butin tree (all profiles, saved logins, cached data, logs) plus the active browser
// session, then restart Butin so it boots fresh. Relaunch is scheduled before exit; the new instance reseeds
// a default profile on startup.
const eraseEverything = async (): Promise<void> => {
  await clearBrowserSessions()
  await rm(homeRootDir(), { recursive: true, force: true })
  app.relaunch()
  app.exit(0)
}

export const clearStorageSurface = async (surface: StorageSurface): Promise<void> => {
  switch (surface) {
    case 'browserSessions':
      return clearBrowserSessions()
    case 'savedLogins':
      clearAllCredentials()
      clearAllSpaBearers()

      return
    case 'cachedData':
      return clearCachedData()
    case 'logs':
      return clearAllLogs()
    case 'everything':
      return eraseEverything()
  }
}
