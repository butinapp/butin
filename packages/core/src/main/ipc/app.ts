import { app } from 'electron'

import type { StorageLocationKind, StorageSurface } from '../../shared/ipc.js'
import { clearLogs, getRecentLogs, log, logDir } from '../log.js'
import { getLoadFailures, plugins } from '../plugin/plugins.js'
import { buildPluginDiagnostics } from '../plugin/validate-plugin.js'
import { getSetting } from '../store/config-file.js'
import { getActiveProfileId, listProfiles } from '../store/profiles.js'
import { clearStorageSurface, revealStorageLocation, storageLocations, storageLocationSize } from '../store/storage.js'
import { dataRootDir } from '../store/store.js'

import { type IpcHandlers, safeResult } from './result.js'

export const appHandlers = {
  diagnostics: () => ({
    loaded: buildPluginDiagnostics(plugins),
    failed: getLoadFailures(),
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron ?? 'unknown',
    chromeVersion: process.versions.chrome ?? 'unknown',
    nodeVersion: process.versions.node ?? 'unknown',
    platform: `${process.platform} ${process.arch}`,
    activeProfile: listProfiles().find((p) => p.active)?.name ?? getActiveProfileId(),
    logDir: logDir(),
    dataDir: dataRootDir(),
    captureLevel: getSetting('logLevel')
  }),

  getLogs: () => getRecentLogs(),

  clearLogs: () => {
    clearLogs()
  },

  logClientError: (_event, message: string) => {
    log.error('renderer', message)
  },

  storageLocations: () => storageLocations(),

  folderSize: (_event, kind: StorageLocationKind) => storageLocationSize(kind),

  revealStorage: (_event, kind: StorageLocationKind) => revealStorageLocation(kind),

  // Clear one storage surface; `everything` wipes ~/butin and restarts, so the reply may not reach the renderer.
  clearStorage: (_event, surface: StorageSurface) => safeResult(() => clearStorageSurface(surface))
} satisfies IpcHandlers['app']
