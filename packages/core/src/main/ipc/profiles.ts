import { app, BrowserWindow, dialog, type IpcMainInvokeEvent } from 'electron'

import { type ArchiveProgressDto, IPC_EVENT } from '../../shared/ipc.js'
import { writeAppLock } from '../app-lock.js'
import { exportProfileArchive } from '../archive/export-profile.js'
import { importProfileArchive, inspectProfileArchive } from '../archive/import-profile.js'
import { pluginById } from '../plugin/plugins.js'
import { removeChromeSessionFor } from '../session/chrome-login.js'
import {
  applyActiveProfile,
  createProfile,
  deleteProfile,
  duplicateProfile,
  getActiveProfileId,
  listProfiles,
  movePluginToProfile,
  recolorProfile,
  renameProfile,
  setActiveProfile
} from '../store/profiles.js'
import { repairSnapshotCurrents } from '../store/repair-snapshots.js'

import { type IpcHandlers, safeResult } from './result.js'
import { getMainWindow } from './window-ref.js'

// A filename that reads as the profile it holds, with the date it was packed — an archive is a point-in-time
// copy, and a folder of them is only navigable if each says when it was taken.
const archiveFileName = (name: string): string =>
  `${
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'profile'
  }-${new Date().toISOString().slice(0, 10)}.butin`

const sendArchiveProgress = (event: IpcMainInvokeEvent, p: ArchiveProgressDto): void => {
  event.sender.send(IPC_EVENT.archiveProgress, p)
}

export const profileHandlers = {
  list: () => listProfiles(),

  create: (_event, name: string) => {
    createProfile(name)

    return listProfiles()
  },

  rename: (_event, id: string, name: string) => {
    renameProfile(id, name)

    return listProfiles()
  },

  recolor: (_event, id: string, color: string) => {
    recolorProfile(id, color)

    return listProfiles()
  },

  // Clone a profile's whole footprint into a new inactive one. Fallible (a locked source has no key to read
  // under) → a Result carrying the refreshed list on success.
  duplicate: (_event, id: string) => {
    const res = duplicateProfile(id)

    return res.ok ? { ok: true as const, data: listProfiles() } : { ok: false as const, error: res.error }
  },

  delete: (_event, id: string) => {
    // The profile's real-Chrome sign-in dir lives outside the profile tree (under Electron userData), so the
    // profile-tree delete doesn't reach it — sweep it explicitly so a deleted profile leaves no cookies behind.
    removeChromeSessionFor(id)
    deleteProfile(id)

    return listProfiles()
  },

  // Switch the active profile, then reload the renderer so every query re-runs against the new roots. The
  // open Magic Login window (if any) is on the old partition — close all child windows first.
  switch: (_event, id: string) => {
    const mainWindow = getMainWindow()

    setActiveProfile(id)
    applyActiveProfile(id)
    // Keep the recorder's heartbeat in sync — the held-open profile just changed.
    writeAppLock(id)
    // The data root just repointed: repair the profile we switched TO, as launch does for the initial one.
    void repairSnapshotCurrents()

    for (const w of BrowserWindow.getAllWindows()) {
      if (w !== mainWindow) {
        w.close()
      }
    }

    if (mainWindow) {
      // The repointed roots only reach the renderer through a FULL document reload — every query then
      // re-runs against the new profile's config/data. A hash-only loadURL is a same-document navigation that
      // does NOT reload the document, so it wouldn't pick up the new roots. Point the hash at Management
      // BEFORE reloading so the fresh document boots straight there — setting it post-load races the router
      // boot and leaves the prior service open.
      const wc = mainWindow.webContents

      void wc.executeJavaScript("location.hash = '#/management'").finally(() => wc.reload())
    }
  },

  // Move a plugin's stored state out of the ACTIVE profile into the target. The renderer refreshes its
  // plugin/overview queries on success; no profile switch, so no reload here.
  movePlugin: (_event, pluginId: string, toProfileId: string) => {
    const plugin = pluginById(pluginId)

    if (!plugin) {
      return { ok: false as const, error: 'unknown plugin' }
    }

    const res = movePluginToProfile(plugin, getActiveProfileId(), toProfileId)

    return res.ok ? { ok: true as const, data: undefined } : { ok: false as const, error: res.error }
  },

  // Pack a profile for another computer. The save dialog comes first so a dismissed dialog costs nothing;
  // the recovery code comes back for the one-time reveal.
  exportArchive: (event, id: string, secret: string) =>
    safeResult(async () => {
      const profile = listProfiles().find((p) => p.id === id)

      if (!profile) {
        throw new Error('profile not found')
      }

      const picked = await dialog.showSaveDialog({
        defaultPath: archiveFileName(profile.name),
        filters: [{ name: 'Butin profile archive', extensions: ['butin'] }]
      })

      if (picked.canceled || !picked.filePath) {
        return { canceled: true }
      }

      return await exportProfileArchive(id, picked.filePath, secret, app.getVersion(), (p) =>
        sendArchiveProgress(event, { ...p, phase: 'packing' })
      )
    }),

  // Native open dialog for an archive; null on cancel. Separate from inspect so the passphrase is only asked
  // for once a file is actually chosen.
  pickArchive: async () => {
    const picked = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Butin profile archive', extensions: ['butin'] }]
    })

    return picked.canceled ? null : (picked.filePaths[0] ?? null)
  },

  inspectArchive: (_event, path: string, secret: string) =>
    safeResult(async () => await inspectProfileArchive(path, secret)),

  // Restore as a NEW profile. The active profile is untouched, so there is no reload to do here — the
  // renderer just refreshes its profile list.
  importArchive: (event, path: string, secret: string, name: string) =>
    safeResult(
      async () =>
        await importProfileArchive(path, secret, {
          name,
          onProgress: (p) => sendArchiveProgress(event, { ...p, phase: 'restoring' })
        })
    )
} satisfies IpcHandlers['profiles']
