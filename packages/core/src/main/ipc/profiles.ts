import { BrowserWindow } from 'electron'

import { writeAppLock } from '../app-lock.js'
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

import type { IpcHandlers } from './result.js'
import { getMainWindow } from './window-ref.js'

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
    const res = movePluginToProfile(pluginId, getActiveProfileId(), toProfileId)

    return res.ok ? { ok: true as const, data: undefined } : { ok: false as const, error: res.error }
  }
} satisfies IpcHandlers['profiles']
