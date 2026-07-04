import type { CredentialStore } from '@butinapp/sdk'

import { decryptValue, encryptValue, isSecretField, readConfig, updatePluginEntry, writeConfig } from './config-file.js'

export { setConfigRoot } from './config-file.js'

// Nuke every plugin's stored session/credentials/config/enabled flag + all per-capability table prefs.
// Preserves top-level app settings (e.g. the manual-capture preference) — those aren't captured data.
// The Electron partition (cookies/localStorage) is cleared separately by the IPC handler.
export const clearAllCredentials = (): void => {
  const { settings } = readConfig()

  writeConfig(settings ? { plugins: {}, settings } : { plugins: {} })
}

// The non-session fields Disconnect preserves: the plugin's pinned settings (`config` e.g. orgId, the
// `documentsOutputDir`) and its place in the app (the `enabled` / `installed` / `onboardedAt` lifecycle
// flags). Everything else on the entry is session/credential material (the cookie, captured tokens + ids)
// and is dropped.
const KEEP_ON_DISCONNECT = ['config', 'documentsOutputDir', 'enabled', 'installed', 'onboardedAt'] as const

// Disconnect ("Clear session") drops the stored SESSION — cookie, captured tokens, captured ids — so a stale
// or wedged session can be re-captured, while leaving the plugin exactly where it was: still enabled, still in
// the Installed roster, still onboarded, with its pinned config intact. (Wiping those would silently disable
// the plugin, bounce it to Available, and re-trigger setup — far more than clearing a session.) A full
// teardown is `uninstall`, which resets the lifecycle flags itself after calling this.
export const clearCredentials = (pluginId: string): void => {
  const config = readConfig()
  const entry = config.plugins[pluginId]

  if (!entry) {
    return
  }

  const kept: Record<string, unknown> = {}

  for (const key of KEEP_ON_DISCONNECT) {
    if (entry[key] !== undefined) {
      kept[key] = entry[key]
    }
  }

  if (Object.keys(kept).length === 0) {
    delete config.plugins[pluginId]
  } else {
    config.plugins[pluginId] = kept
  }

  writeConfig(config)
}

export const createCredentialStore = (pluginId: string): CredentialStore => ({
  get: (field = 'cookie') => {
    const entry = readConfig().plugins[pluginId]

    if (!entry || typeof entry[field] !== 'string') {
      return undefined
    }

    return decryptValue(entry[field] as string, entry[`${field}_enc`] === true)
  },
  set: (field, value) =>
    updatePluginEntry(pluginId, (entry) => {
      if (isSecretField(field)) {
        const { stored, enc } = encryptValue(value)

        entry[field] = stored
        entry[`${field}_enc`] = enc
      } else {
        entry[field] = value
      }
    })
})
