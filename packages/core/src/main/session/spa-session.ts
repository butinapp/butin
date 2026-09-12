import type { SpaBearerAuth } from '@butinapp/sdk'
import { BrowserWindow } from 'electron'

import { getPluginSession, partitionFor } from '../browser/shared-session.js'
import { pluginById } from '../plugin/plugins.js'

// Thrown when the offscreen SPA boot yields no Bearer within the timeout — the durable SSO cookie has
// expired and the user must re-run Magic Login. Surfaced inline by the UI.
export class SpaSessionExpired extends Error {
  constructor(pluginId: string) {
    super(`session expired for ${pluginId} — re-run Magic Login`)
    this.name = 'SpaSessionExpired'
  }
}

// A status-less dead-session marker the failure classifier keys off (the error carries no HTTP code). Matches
// on the name, not instanceof, so it survives an error that crossed a boundary and lost its prototype.
export const isSpaSessionExpired = (err: unknown): boolean =>
  (err as { name?: string } | null)?.name === 'SpaSessionExpired'

// Per-plugin captured Bearer ('Bearer <jwt>'), kept in main-process memory and reused across every
// capability in the run. Re-minted only when cleared (a 401 drops it via wrapClearOnAuthError).
const cache = new Map<string, string>()

export const getCachedBearer = (pluginId: string): string | undefined => cache.get(pluginId)
export const setCachedBearer = (pluginId: string, bearer: string): void => void cache.set(pluginId, bearer)
// Clears the plugin's primary bearer AND every secondary-backend bearer (cache key `<pluginId>::<backend>`),
// so a 401 anywhere in a multi-backend plugin re-mints them all on the next run.
export const clearSpaBearer = (pluginId: string): void => {
  for (const key of cache.keys()) {
    if (key === pluginId || key.startsWith(`${pluginId}::`)) {
      cache.delete(key)
    }
  }
}
// Drop every cached SPA bearer — called on a profile switch (tokens are minted per session/identity, which
// changes with the profile's partition).
export const clearAllSpaBearers = (): void => cache.clear()

// A dead SSO session has no token to mint: the booted SPA bounces the top-level frame to a login page
// instead of firing its authed XHRs. Recognizing that redirect lets the mint fail in ~1s instead of waiting
// out the boot timeout — the fast signal `testConnection` needs to flag a service for re-login. True when
// the navigation leaves the boot URL's origin (off to an identity provider) or lands on a same-origin
// sign-in route; the initial load of `bootUrl` itself (the app shell, no login marker) is not a match.
const LOGIN_PATH = /(?:^|\/)(?:sign[-_]?in|log[-_]?in|login|signin|auth|oauth|sso)(?:\/|$)/i

// Same protocol + port + host modulo a leading `www.`, so an apex↔`www.` canonicalization hop (the host the
// SPA actually serves from) reads as staying put, not as a bounce off to an identity provider.
const sameSite = (a: URL, b: URL): boolean =>
  a.protocol === b.protocol &&
  a.port === b.port &&
  a.hostname.replace(/^www\./, '') === b.hostname.replace(/^www\./, '')

export const looksLikeLoginRedirect = (navUrl: string, bootUrl: string): boolean => {
  try {
    const nav = new URL(navUrl)
    const boot = new URL(bootUrl)

    return !sameSite(nav, boot) || LOGIN_PATH.test(nav.pathname)
  } catch {
    return false
  }
}

// JS injected into the booted SPA to read a freshly-minted token out of sessionStorage, before the SPA
// fires its first authed XHR.
const readSessionStorageToken = (prefix: string): string =>
  `(() => { for (const k of Object.keys(sessionStorage)) { if (k.startsWith(${JSON.stringify(prefix)})) {` +
  ` try { const u = JSON.parse(sessionStorage.getItem(k)); if (u && typeof u.access_token === 'string')` +
  ` return u.access_token } catch (_) {} } } return null })()`

// In-flight mints, keyed by plugin. Without this, every capability that fires before the token is cached
// opens its OWN offscreen window booting the full SPA — several heavy hidden windows at once saturate the
// main process and IPC appears to hang. Concurrent callers await the SAME single boot.
const inflight = new Map<string, Promise<string>>()

// Boot the SPA offscreen on the plugin's (shared) partition so its cookies + identity ride along, then
// race a captured Authorization header (the SPA's own /api/1 XHRs, observed read-only via onSendHeaders
// so it never clobbers the client-hints onBeforeSendHeaders listener) against a sessionStorage read.
const mintBearer = (pluginId: string, strategy: SpaBearerAuth, bootTimeoutMs?: number): Promise<string> => {
  console.log(`[butin:spa] ${pluginId}: booting offscreen SPA to mint a bearer…`)

  // A secondary-backend cache key is `<pluginId>::<backend>`; the plugin (partition + identity) is the part
  // before `::`. The strategy passed in already carries the backend's own bootUrl + capture patterns.
  const plugin = pluginById(pluginId.split('::')[0]!)

  if (!plugin) {
    return Promise.reject(new Error(`unknown plugin: ${pluginId}`))
  }

  const ses = getPluginSession(plugin) // applies browser identity + tracks the partition for promote-on-quit
  const patterns = strategy.authCaptureUrlPatterns
  // A probe passes a tighter budget than a real refresh (test-all is latency-sensitive); the redirect
  // watch below usually fails a dead session well before either fires.
  const timeoutMs = bootTimeoutMs ?? strategy.bootTimeoutMs ?? 30_000
  const win = new BrowserWindow({
    show: false,
    webPreferences: { partition: partitionFor(plugin), backgroundThrottling: false }
  })

  // The page runs unseen on the plugin's authenticated partition; a popup it opens would be a visible window
  // carrying that session with no chrome around it.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  return new Promise<string>((resolvePromise, rejectPromise) => {
    let settled = false

    const finish = (bearer: string | null, err?: Error): void => {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(timer)
      ses.webRequest.onSendHeaders(null)

      if (!win.isDestroyed()) {
        win.destroy()
      }

      if (bearer) {
        console.log(`[butin:spa] ${pluginId}: bearer captured`)
        resolvePromise(bearer)
      } else {
        console.log(`[butin:spa] ${pluginId}: no bearer (session expired or timed out)`)
        rejectPromise(err ?? new SpaSessionExpired(pluginId))
      }
    }

    const tryStorage = (): void => {
      if (settled || win.isDestroyed()) {
        return
      }

      void win.webContents
        .executeJavaScript(readSessionStorageToken(strategy.sessionStorageKeyPrefix ?? 'oidc.user:'), true)
        .then((token: unknown) => {
          if (typeof token === 'string' && token) {
            finish(`Bearer ${token}`)
          }
        })
        .catch(() => {})
    }

    const timer = setTimeout(() => finish(null), timeoutMs)

    ses.webRequest.onSendHeaders({ urls: patterns }, (details) => {
      const headers = details.requestHeaders
      const auth = headers['Authorization'] ?? headers['authorization']

      if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
        finish(auth)
      }
    })

    // A top-level redirect to a login page means the SSO is dead — fail now rather than waiting out the timer.
    const onNavigate = (_e: unknown, url: string): void => {
      if (looksLikeLoginRedirect(url, strategy.bootUrl)) {
        finish(null)
      }
    }

    win.webContents.on('did-finish-load', tryStorage)
    win.webContents.on('did-navigate', onNavigate)
    win.webContents.on('will-redirect', onNavigate)
    win.webContents.loadURL(strategy.bootUrl).catch((err: Error) => finish(null, err))
  })
}

// Return the cached Bearer, the in-flight mint if one is already running, or start a single new mint.
// Caches on success; throws SpaSessionExpired on timeout. Concurrent callers share one offscreen boot.
export const ensureSpaBearer = async (
  pluginId: string,
  strategy: SpaBearerAuth,
  bootTimeoutMs?: number
): Promise<string> => {
  const cached = cache.get(pluginId)

  if (cached) {
    console.log(`[butin:spa] ${pluginId}: reusing cached bearer`)

    return cached
  }

  const pending = inflight.get(pluginId)

  if (pending) {
    console.log(`[butin:spa] ${pluginId}: awaiting in-flight mint`)

    return pending
  }

  const p = mintBearer(pluginId, strategy, bootTimeoutMs)

  inflight.set(pluginId, p)

  try {
    const bearer = await p

    cache.set(pluginId, bearer)

    return bearer
  } finally {
    inflight.delete(pluginId)
  }
}
