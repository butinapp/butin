import type { ButinPlugin } from '@butinapp/sdk'

import type { SecondarySessionDto } from '../../shared/ipc.js'
import type { PluginEntry } from '../store/config-file.js'
import { createCredentialStore } from '../store/credentials.js'
import { configIsFilled, hasPluginConfig } from '../store/plugin-config.js'

// Whether a plugin is "connected" (can run a fresh fetch). For session plugins that means a captured
// cookie is stored; for `external` plugins (no session) it means the plugin's config — which IS its
// credential — has been filled in. Shared by the Data-status summary and the Overview tile state.
export const isPluginConnected = (plugin: ButinPlugin): boolean =>
  plugin.auth.kind === 'external'
    ? hasPluginConfig(plugin.meta.id, plugin.config ?? { fields: [] })
    : Boolean(createCredentialStore(plugin.meta.id).get('cookie'))

// The same question asked of a stored entry read straight off a config file, so a profile that isn't the
// active one can be judged. It matters that this is narrower than "the entry exists": Disconnect keeps the
// entry alive to preserve the plugin's pinned config and its enabled/installed/onboarded flags, so a
// disconnected plugin still has one.
export const entryIsConnected = (plugin: ButinPlugin, entry: PluginEntry | undefined): boolean => {
  if (!entry) {
    return false
  }

  if (plugin.auth.kind === 'external') {
    const raw = entry['config']

    return configIsFilled(
      raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {},
      plugin.config ?? { fields: [] }
    )
  }

  return typeof entry['cookie'] === 'string' && entry['cookie'].length > 0
}

// The plugin's secondary logins (backends declaring their own `session`) + whether each is captured. Its
// cookie is stored under `cookie:<key>` by the secondary Magic Login. [] for the common single-login plugin.
export const secondarySessions = (plugin: ButinPlugin): SecondarySessionDto[] => {
  const creds = createCredentialStore(plugin.meta.id)

  return Object.entries(plugin.backends ?? {})
    .filter(([, backend]) => backend.session)
    .map(([key, backend]) => ({ key, label: backend.label ?? key, connected: Boolean(creds.get(`cookie:${key}`)) }))
}
