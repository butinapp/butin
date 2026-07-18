import type { ButinClient, ButinPlugin, Capability, CollectContext } from '@butinapp/sdk'

import { createBrowserSession } from '../browser/browser-session.js'
import { createLogger } from '../log.js'
import { getCachedBearer } from '../session/spa-session.js'
import { createCredentialStore } from '../store/credentials.js'
import { getPluginConfig } from '../store/plugin-config.js'
import { createBackendClient, createClient } from '../transport/client.js'

import { fillCapturedIds } from './captured-ids.js'
import { pluginById } from './plugins.js'

// Plugin/capability lookup + authed-context construction, shared by every runner (collect, documents,
// export, probe), so the creds + typed config + dual-transport client + namespaced logger are derived
// in one place.

// How long a probe waits for a spa-bearer's offscreen SPA to mint before declaring the session dead. Well
// under the default refresh budget (30s) — test-all is latency-sensitive and the login-redirect watch
// usually fails a dead session sooner anyway.
const PROBE_SPA_BOOT_TIMEOUT_MS = 8_000

export const requirePlugin = (pluginId: string): ButinPlugin => {
  const plugin = pluginById(pluginId)

  if (!plugin) {
    throw new Error(`unknown plugin: ${pluginId}`)
  }

  return plugin
}

export const requireCapability = (plugin: ButinPlugin, capabilityId: string): Capability => {
  const capability = plugin.capabilities.find((c) => c.id === capabilityId)

  if (!capability) {
    throw new Error(`unknown capability: ${plugin.meta.id}/${capabilityId}`)
  }

  return capability
}

// The authed CollectContext for a plugin: creds + decrypted typed config + the auth/transport-applied
// client + a structured logger bound to this plugin + action (scope = capability id, or 'probe'), so every
// line a collector emits is filterable by plugin/action in the Logs view.
export const buildContext = (plugin: ButinPlugin, scope: string): CollectContext => {
  const creds = createCredentialStore(plugin.meta.id)
  // An id auto-captured at sign-in (a Groq org id off a request header, a DNSimple account id off the
  // dashboard URL) fills its config field when the user hasn't pinned one, so an auto-detected id Just Works
  // without a manual Save — the same fallback the Settings form prefill uses.
  const config = fillCapturedIds(plugin, getPluginConfig(plugin.meta.id, plugin.config ?? { fields: [] }))
  // A probe (test-all) only needs connected/not, so it caps a spa-bearer's offscreen-boot wait far below a
  // real refresh's — a dead SSO session is flagged for re-login fast instead of blocking the whole batch.
  const spaBootTimeoutMs = scope === 'probe' ? PROBE_SPA_BOOT_TIMEOUT_MS : undefined
  const client = createClient(plugin, creds, config, spaBootTimeoutMs)

  // Secondary-backend clients are built (+ memoized) only when a collector actually asks for one, so a
  // single-backend run never boots an offscreen SPA it doesn't use.
  const backendClients = new Map<string, ButinClient>()
  const clientFor = (backendKey: string): ButinClient => {
    const existing = backendClients.get(backendKey)

    if (existing) {
      return existing
    }

    const built = createBackendClient(plugin, backendKey, creds, config, spaBootTimeoutMs)

    backendClients.set(backendKey, built)

    return built
  }

  return {
    client,
    clientFor,
    creds,
    config,
    browser: createBrowserSession(plugin),
    // The minted SPA bearer, once a `client` call has cached it — for a collector that must attach it to a
    // browser-side fetch (priming a stateful portal). Undefined for cookie-only sessions.
    authToken: () => getCachedBearer(plugin.meta.id),
    log: createLogger({ plugin: plugin.meta.id, action: scope }).info
  }
}
