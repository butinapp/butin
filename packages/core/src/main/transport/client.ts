import type {
  AuthStrategy,
  ButinClient,
  ButinPlugin,
  ButinResponse,
  CredentialStore,
  RequestOptions,
  TransportConfig
} from '@butinapp/sdk'

import { getPluginSession } from '../browser/shared-session.js'
import { createAuthResolver, type AuthResolver } from '../plugin/auth-resolve.js'
import { clearSpaBearer } from '../session/spa-session.js'
import { getSetting } from '../store/config-file.js'

import { createElectronClient } from './electron-client.js'
import { createNodeClient } from './node-client.js'
import { getRequestCache, type RequestCache } from './request-cache.js'

// Run an operation; if it throws a status in clearOnStatuses (default [401]), wipe the cookie so
// the UI re-prompts Magic Login (and drop any cached spa-bearer so the next run re-mints), then rethrow.
// A 401 raised by a SECONDARY backend (tagged `fromBackend` by createBackendClient) is left alone: that's the
// backend's own session, and wiping the primary would disconnect the whole service over one tab's expiry —
// the failure just surfaces on its tab. Mirrors testConnection, which never clears for a secondary probe.
// A capability that tags its error `permissionDenied` is also left alone: some services return 401 for a
// per-route authorization denial (the same session reads other routes fine), so that status is not proof the
// session died — it surfaces as a permission error on the failing tab instead of disconnecting the service.
export const wrapClearOnAuthError = <T>(
  plugin: Pick<ButinPlugin, 'auth' | 'meta'>,
  creds: CredentialStore,
  op: () => Promise<T>
): (() => Promise<T>) => {
  const clearOn = plugin.auth.clearOnStatuses ?? [401]

  return async () => {
    try {
      return await op()
    } catch (err) {
      const status = (err as { status?: number }).status
      const fromBackend = (err as { fromBackend?: string }).fromBackend
      const permissionDenied = (err as { permissionDenied?: boolean }).permissionDenied

      if (status && clearOn.includes(status) && !fromBackend && !permissionDenied) {
        creds.set('cookie', '')

        if (plugin.auth.kind === 'spa-bearer') {
          clearSpaBearer(plugin.meta.id)
        }
      }

      throw err
    }
  }
}

// Tag every rejection from a secondary-backend client with its key. A capability's collect() may call both
// the primary client and a backend's; both raise plain HTTP errors, so the primary-scoped clear wrapper can't
// otherwise tell whose session a 401 belongs to. The tag lets it leave the primary session intact.
const tagBackendErrors = (client: ButinClient, backendKey: string): ButinClient => {
  const tag = <T>(p: Promise<T>): Promise<T> =>
    p.catch((err: unknown) => {
      if (err && typeof err === 'object') {
        ;(err as { fromBackend?: string }).fromBackend = backendKey
      }

      throw err
    })

  return {
    request: <T = unknown>(opts: RequestOptions) => tag<ButinResponse<T>>(client.request<T>(opts)),
    get: <T = unknown>(url: string, headers?: Record<string, string>) => tag<T>(client.get<T>(url, headers)),
    post: <T = unknown>(url: string, body?: unknown, headers?: Record<string, string>) =>
      tag<T>(client.post<T>(url, body, headers)),
    graphql: <T = unknown>(url: string, query: string, variables?: Record<string, unknown>) =>
      tag<T>(client.graphql<T>(url, query, variables)),
    getText: (url: string, headers?: Record<string, string>) => tag<string>(client.getText(url, headers))
  }
}

export const createClient = (
  plugin: ButinPlugin,
  creds: CredentialStore,
  config: Record<string, unknown> = {},
  spaBootTimeoutMs?: number
): ButinClient => {
  return buildClient(
    plugin,
    plugin.transport ?? { engine: 'node' },
    plugin.auth,
    creds,
    config,
    plugin.meta.id,
    'cookie',
    spaBootTimeoutMs
  )
}

// A client for one of the plugin's secondary `backends` — same captured creds, but the backend's own
// transport (host/headers) + auth (its own minted Bearer). The spa-bearer cache key is `<pluginId>::<key>`
// so each backend boots/mints independently of the primary and of every other backend.
export const createBackendClient = (
  plugin: ButinPlugin,
  backendKey: string,
  creds: CredentialStore,
  config: Record<string, unknown> = {},
  spaBootTimeoutMs?: number
): ButinClient => {
  const backend = plugin.backends?.[backendKey]

  if (!backend) {
    throw new Error(`unknown backend '${backendKey}' for plugin ${plugin.meta.id}`)
  }

  // A backend with its OWN login captures under `cookie:<key>`; cookie auth must read that field, not the
  // primary 'cookie'. A backend riding the primary session keeps reading 'cookie'.
  const cookieField = backend.session ? `cookie:${backendKey}` : 'cookie'

  const client = buildClient(
    plugin,
    backend.transport ?? { engine: 'node' },
    backend.auth,
    creds,
    config,
    `${plugin.meta.id}::${backendKey}`,
    cookieField,
    spaBootTimeoutMs
  )

  return tagBackendErrors(client, backendKey)
}

// Build the dual-base client for a (transport, auth) pair. `cacheKey` keys the spa-bearer cache (the plugin
// id for the primary, `<pluginId>::<backend>` for a secondary). The base client attaches only the stored
// cookie/bearer (no resolve()), so a resolve() hook can fetch with it — scrape a CSRF nonce, mint a JWT,
// exchange a refresh token. The final client runs the full strategy (resolve()) on top of that working base.
const buildClient = (
  plugin: ButinPlugin,
  transport: TransportConfig,
  auth: AuthStrategy,
  creds: CredentialStore,
  config: Record<string, unknown>,
  cacheKey: string,
  cookieField: string,
  spaBootTimeoutMs?: number
): ButinClient => {
  const useElectron = transport.engine === 'electron' || transport.requiresBrowserEngine === true
  // Electron replay rides the plugin's (profile's) partition session — the same jar capture/boot populated.
  const session = useElectron ? getPluginSession(plugin) : undefined
  // The base client (bare resolver, used by resolve() hooks: nonce scrape / JWT mint / refresh rotation) is
  // NEVER cached — passing the cache only to the final client keeps auth-resolution + rotating tokens off it.
  const make = (resolver: AuthResolver, cache?: RequestCache): ButinClient =>
    useElectron
      ? createElectronClient(transport, resolver, session, cache, plugin.meta.id)
      : createNodeClient(transport, resolver, undefined, cache, plugin.meta.id)

  const baseClient = make(
    createAuthResolver(auth, creds, {} as ButinClient, config, { bare: true, pluginId: cacheKey, cookieField })
  )

  return make(
    createAuthResolver(auth, creds, baseClient, config, { pluginId: cacheKey, cookieField, spaBootTimeoutMs }),
    getRequestCache(cacheKey, getSetting('cacheWindowSeconds') * 1000)
  )
}
