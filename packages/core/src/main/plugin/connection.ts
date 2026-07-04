import type { ButinPlugin } from '@butinapp/sdk'

import type { SecondarySessionDto } from '../../shared/ipc.js'
import { createCredentialStore } from '../store/credentials.js'
import { hasPluginConfig } from '../store/plugin-config.js'

// Whether a plugin is "connected" (can run a fresh fetch). For session plugins that means a captured
// cookie is stored; for `external` plugins (no session) it means the plugin's config — which IS its
// credential — has been filled in. Shared by the Data-status summary and the Overview tile state.
export const isPluginConnected = (plugin: ButinPlugin): boolean =>
  plugin.auth.kind === 'external'
    ? hasPluginConfig(plugin.meta.id, plugin.config ?? { fields: [] })
    : Boolean(createCredentialStore(plugin.meta.id).get('cookie'))

// The plugin's secondary logins (backends declaring their own `session`) + whether each is captured. Its
// cookie is stored under `cookie:<key>` by the secondary Magic Login. [] for the common single-login plugin.
export const secondarySessions = (plugin: ButinPlugin): SecondarySessionDto[] => {
  const creds = createCredentialStore(plugin.meta.id)

  return Object.entries(plugin.backends ?? {})
    .filter(([, backend]) => backend.session)
    .map(([key, backend]) => ({ key, label: backend.label ?? key, connected: Boolean(creds.get(`cookie:${key}`)) }))
}
