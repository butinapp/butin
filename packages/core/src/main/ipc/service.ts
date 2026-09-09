import { clearServiceCookies } from '@butinapp/engine'
import type { ConfigField } from '@butinapp/sdk'
import type { ConfigFieldView } from '@butinapp/shapes'

import { type PluginSummary, type Result, type RunReport } from '../../shared/ipc.js'
import { openNavigationBrowser } from '../browser/navigation-browser.js'
import { getPluginSession } from '../browser/shared-session.js'
import { fillCapturedIds } from '../plugin/captured-ids.js'
import { isPluginConnected, secondarySessions } from '../plugin/connection.js'
import { getCachedConfigOptions, listConfigOptions, runCapability, testConnection } from '../plugin/plugin-host.js'
import { pluginById, plugins } from '../plugin/plugins.js'
import { runMagicLogin } from '../session/magic-login.js'
import { getPluginEnabled, getPluginInstalled, getPluginOnboardedAt } from '../store/config-file.js'
import { clearCredentials, createCredentialStore } from '../store/credentials.js'
import { clearPluginConfig, getPublicConfig, setPluginConfig } from '../store/plugin-config.js'
import { buildServiceDetail, getFolderStats } from '../store/service-detail.js'
import { clearReports, listReportTimes, newestReportTime, readCurrent, trackProfileWrite } from '../store/store.js'
import { clearRequestCache } from '../transport/request-cache.js'

import { failureCtx, type IpcHandlers, safeResult } from './result.js'

// The renderer can't receive functions over IPC — drop the runtime-only loadOptions resolver from each
// combobox field, leaving the serialisable schema the settings form renders. The options come via
// listConfigOptions instead.
const publicField = (field: ConfigField): ConfigFieldView => {
  const copy = { ...field }

  delete copy.loadOptions

  return copy
}

const summaries = (): Promise<PluginSummary[]> =>
  Promise.all(
    plugins.map(async (p) => {
      const schema = p.config ?? { fields: [] }

      return {
        id: p.meta.id,
        name: p.meta.name,
        vendor: p.meta.vendor,
        version: p.meta.version,
        description: p.meta.description,
        category: p.meta.category,
        color: p.meta.color,
        icon: p.meta.icon,
        dashboardUrl: p.meta.dashboardUrl,
        messages: p.meta.messages,
        hasCookie: Boolean(createCredentialStore(p.meta.id).get('cookie')),
        connected: isPluginConnected(p),
        sessionless: p.auth.kind === 'external',
        enabled: getPluginEnabled(p.meta.id),
        installed: getPluginInstalled(p.meta.id),
        onboardedAt: getPluginOnboardedAt(p.meta.id),
        troubleshooting: p.meta.troubleshooting,
        configFields: schema.fields.map(publicField),
        config: fillCapturedIds(p, getPublicConfig(p.meta.id, schema)),
        capabilities: p.capabilities.map((c) => ({ id: c.id, label: c.label, incremental: Boolean(c.incremental) })),
        secondarySessions: secondarySessions(p),
        lastRunAt: await newestReportTime(p.meta.id)
      }
    })
  )

// Operating a connected service: capture/read its session, run a capability, read its config + cached
// inventory. (Roster membership lives in lifecycle.ts; long artifact-producing runs in jobs.ts.)
export const serviceHandlers = {
  list: () => summaries(),

  magicLogin: async (_event, pluginId: string, backendKey?: string) => {
    const plugin = pluginById(pluginId)

    if (!plugin) {
      return { ok: false, error: `unknown plugin: ${pluginId}` }
    }

    // A backendKey captures that backend's SECONDARY login; otherwise the primary session.
    const session = backendKey ? plugin.backends?.[backendKey]?.session : plugin.session

    if (!session) {
      return { ok: false, error: `${plugin.meta.name} has no login to capture — configure it in Settings.` }
    }

    return runMagicLogin(plugin, { backendKey })
  },

  // Open the service's dashboard inside the captured session to look around — same window machinery as Magic
  // Login but in browse mode (auto-capture off, cookies untouched). Only meaningful for a session plugin with
  // a dashboard URL; sessionless/external plugins keep their plain external-browser link.
  browse: async (_event, pluginId: string) => {
    const plugin = pluginById(pluginId)

    if (!plugin) {
      return { ok: false, error: `unknown plugin: ${pluginId}` }
    }

    if (!plugin.session || !plugin.meta.dashboardUrl) {
      return { ok: false, error: `${plugin.meta.name} has no dashboard to open in your session.` }
    }

    return runMagicLogin(plugin, { mode: 'browse', startUrl: plugin.meta.dashboardUrl })
  },

  // Open a plugin-less browser on the shared session partition to navigate any signed-in service without
  // capturing — the dev-mode navigation browser.
  openNavigationBrowser: async () => {
    openNavigationBrowser()
  },

  // Disconnect: drop the stored snapshot AND remove only THIS service's cookies from the shared
  // partition — leaving the shared Google/SSO login intact for every other service. A backendKey drops only
  // that secondary session (its keyed cookie + its host's partition cookies), leaving the primary intact.
  disconnect: async (_event, pluginId: string, backendKey?: string) => {
    const plugin = pluginById(pluginId)

    if (backendKey) {
      const backend = plugin?.backends?.[backendKey]

      createCredentialStore(pluginId).set(`cookie:${backendKey}`, '')

      if (plugin && backend?.session) {
        await clearServiceCookies(getPluginSession(plugin), backend.session.cookieDomains)
      }

      clearRequestCache(pluginId)

      return
    }

    clearCredentials(pluginId)
    clearRequestCache(pluginId)

    if (plugin?.session) {
      await clearServiceCookies(getPluginSession(plugin), plugin.session.cookieDomains)
    }

    // For `external` plugins the config IS the credential, so a disconnect wipes it too (clearCredentials
    // deliberately preserves config for session plugins).
    if (plugin?.auth.kind === 'external') {
      clearPluginConfig(pluginId)
    }
  },

  setConfig: (_event, pluginId: string, values: Record<string, string>) => {
    const plugin = pluginById(pluginId)

    if (plugin) {
      setPluginConfig(pluginId, plugin.config ?? { fields: [] }, values)
    }
  },

  // Fetch a combobox field's choices through the authed client — never let a 401/network throw cross IPC.
  listConfigOptions: (_event, pluginId: string, fieldKey: string) =>
    safeResult(() => listConfigOptions(pluginId, fieldKey)),

  getCachedConfigOptions: (_event, pluginId: string, fieldKey: string) => getCachedConfigOptions(pluginId, fieldKey),

  testConnection: (_event, pluginId: string, backendKey?: string) => testConnection(pluginId, backendKey),

  // Never let a collect() rejection cross IPC as an unhandled error — the UI shows it instead.
  runCapability: (_event, pluginId: string, capabilityId: string, force?: boolean): Promise<Result<RunReport>> =>
    safeResult(
      async () => {
        const data = await trackProfileWrite(() => runCapability(pluginId, capabilityId, { force }))
        const report = await readCurrent(pluginId, capabilityId)

        return { report: data, lastRunAt: report?.lastRunAt }
      },
      failureCtx(pluginById(pluginId))
    ),

  reportTimes: (_event, pluginId: string) => listReportTimes(pluginId),

  // The reshaped Settings tab's info payload + the async folder footprint. Both read-only (no collector).
  getServiceDetail: (_event, pluginId: string) => buildServiceDetail(pluginId),
  getFolderStats: (_event, pluginId: string) => getFolderStats(pluginId),

  // Erase a service's cached tab data (reports + manifests); keeps the stored session + downloaded files.
  clearReports: (_event, pluginId: string) => clearReports(pluginId),

  clearQueryCache: (_event, pluginId: string) => {
    clearRequestCache(pluginId)
  }
} satisfies IpcHandlers['services']
