import { clearServiceCookies } from '@butinapp/engine'

import { getPluginSession } from '../browser/shared-session.js'
import { requirePlugin } from '../plugin/plugin-context.js'
import { setPluginEnabled, setPluginInstalled, setPluginOnboardedAt, updatePluginEntry } from '../store/config-file.js'
import { clearCredentials } from '../store/credentials.js'
import { clearPluginConfig } from '../store/plugin-config.js'
import { clearReports, clearServiceFolder } from '../store/store.js'
import { clearRequestCache } from '../transport/request-cache.js'

import type { IpcHandlers } from './result.js'

// Roster membership + onboarding — adding/removing a service and toggling it on. (Operating a connected
// service lives in service.ts; long artifact runs in jobs.ts.)
export const lifecycleHandlers = {
  setEnabled: (_event, pluginId: string, enabled: boolean) => {
    setPluginEnabled(pluginId, enabled)
  },

  install: (_event, pluginId: string) => {
    setPluginInstalled(pluginId, true)
    setPluginEnabled(pluginId, true)
  },

  // Full teardown so an uninstalled plugin returns to a pristine Available state: clear credentials + this
  // service's cookies, then drop cached reports + the roster flags. Downloaded files under ~/butin/<id>/ are
  // left in place unless `eraseFolder` is set, which removes the whole service data folder too.
  uninstall: async (_event, pluginId: string, eraseFolder?: boolean) => {
    // Resolved before anything is removed: the id names the folder an erase deletes, so only a registered
    // plugin's id ever reaches the store.
    const plugin = requirePlugin(pluginId)

    clearCredentials(pluginId)
    clearRequestCache(pluginId)

    if (plugin.session) {
      await clearServiceCookies(getPluginSession(plugin), plugin.session.cookieDomains)
    }

    clearPluginConfig(pluginId)

    if (eraseFolder) {
      await clearServiceFolder(pluginId)
    } else {
      await clearReports(pluginId)
    }

    setPluginInstalled(pluginId, false)
    setPluginEnabled(pluginId, false)
    updatePluginEntry(pluginId, (entry) => {
      delete entry.onboardedAt
    })
  },

  markOnboarded: (_event, pluginId: string) => {
    setPluginOnboardedAt(pluginId, Date.now())
  }
} satisfies IpcHandlers['lifecycle']
