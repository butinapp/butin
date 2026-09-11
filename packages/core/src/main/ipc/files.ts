import { app, dialog, shell } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

import { type ExportOptionsDto, type FolderKind, type Result, type RevealTarget } from '../../shared/ipc.js'
import { activePartitionDir } from '../browser/shared-session.js'
import { getDocumentsOutputDir, setDocumentsOutputDir } from '../export/documents-config.js'
import { buildExportBundle } from '../export/export-bundle.js'
import { exportFileName, writeExportFile } from '../export/export-data.js'
import { openDocumentFile } from '../export/open-document.js'
import { logDir } from '../log.js'
import { readConfig } from '../store/config-file.js'
import { listProfiles } from '../store/profiles.js'
import { dataRootDir, resolveDocumentsDir, resolveExtractsDir, serviceDir } from '../store/store.js'

import { type IpcHandlers, safeResult } from './result.js'

// Resolve one of a service's local folders. The documents folder honours the per-plugin override; service
// + extracts are derived from the plugin id.
const folderPath = (pluginId: string, kind: FolderKind): string =>
  kind === 'documents'
    ? resolveDocumentsDir(pluginId, getDocumentsOutputDir(pluginId))
    : kind === 'extracts'
      ? resolveExtractsDir(pluginId)
      : serviceDir(pluginId)

// The proposed export target: Downloads + a run-stamped, profile-named file. Both the export write (when no
// destination is picked) and the save dialog's seed read this, so they agree on the default.
const defaultExportPath = (): string =>
  join(app.getPath('downloads'), exportFileName(listProfiles().find((p) => p.active)?.name ?? 'butin', new Date()))

// True when `path` is `root` itself or lies beneath it, compared after normalization.
export const isWithin = (root: string, path: string): boolean => {
  const r = resolve(root)
  const p = resolve(path)

  return p === r || p.startsWith(r + sep)
}

// Where a downloaded document can live: the profile's data tree, or a service's chosen documents folder.
const documentRoots = (): string[] => [
  dataRootDir(),
  ...Object.keys(readConfig().plugins)
    .map((id) => getDocumentsOutputDir(id))
    .filter((dir): dir is string => Boolean(dir))
]

// The destination the save dialog handed back, and the export written last. An export only ever lands on a
// path the dialog produced, and the reveal action only ever highlights a path this process wrote or owns.
let pickedExportPath: string | null = null
let lastExportPath: string | null = null

export const isRevealable = (path: string): boolean =>
  path === lastExportPath || isWithin(dataRootDir(), path) || isWithin(app.getPath('userData'), path)

export const fileHandlers = {
  folderGet: (_event, pluginId: string, kind: FolderKind) => folderPath(pluginId, kind),

  folderPick: async (_event, pluginId: string) => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })

    if (result.canceled || result.filePaths.length === 0) {
      return null
    }

    setDocumentsOutputDir(pluginId, result.filePaths[0])

    return result.filePaths[0]
  },

  // Reveal any folder: app-level logs/data root, or a plugin-scoped service folder. The folder may not exist
  // until the first fetch/download, so ensure it first.
  revealFolder: async (_event, kind: RevealTarget, pluginId?: string) => {
    const dir =
      kind === 'logs'
        ? logDir()
        : kind === 'data'
          ? dataRootDir()
          : kind === 'partition'
            ? activePartitionDir()
            : folderPath(pluginId as string, kind)

    await mkdir(dir, { recursive: true })
    await shell.openPath(dir)
  },

  // Open a downloaded document. A sealed file is decrypted to an isolated temp copy (swept on boot/quit);
  // plaintext opens in place. All handled in open-document.ts. Never throws across IPC.
  openDocument: async (_event, path: string) => {
    if (documentRoots().some((root) => isWithin(root, path))) {
      await openDocumentFile(path)
    }
  },

  // Write an export blob to a user-chosen path. Cancel resolves ok with { canceled: true } (no write).
  saveFile: (_event, suggestedName: string, contents: string): Promise<Result<{ path?: string; canceled?: boolean }>> =>
    safeResult(async () => {
      const result = await dialog.showSaveDialog({ defaultPath: suggestedName })

      if (result.canceled || !result.filePath) {
        return { canceled: true }
      }

      await writeFile(result.filePath, contents, 'utf8')

      return { path: result.filePath }
    }),

  // Write the active profile's cached data as one viewer bundle to a user-reachable path (Downloads by
  // default). Offline — `buildExportBundle` reads cached reports, no collector runs. Returns the path to reveal.
  exportData: (_event, opts: ExportOptionsDto): Promise<Result<{ path: string }>> =>
    safeResult(async () => {
      if (opts.destPath && opts.destPath !== pickedExportPath) {
        throw new Error('the export destination must be chosen through the save dialog')
      }

      const written = await writeExportFile({
        bundle: await buildExportBundle(opts.serviceIds),
        root: dataRootDir(),
        destPath: opts.destPath ?? defaultExportPath(),
        encrypt: Boolean(opts.encrypt)
      })

      lastExportPath = written.path

      return written
    }),

  // Native save dialog seeded with the default export path; resolves the chosen path, or null on cancel.
  exportPickPath: async (): Promise<string | null> => {
    const result = await dialog.showSaveDialog({ defaultPath: defaultExportPath() })

    pickedExportPath = result.canceled || !result.filePath ? null : result.filePath

    return pickedExportPath
  }
} satisfies IpcHandlers['files']
