import {
  clearServiceCookies,
  createMagicToolbar,
  createStatusBar,
  ensureClientHintsPreload,
  type MagicToolbar,
  type NavEntry,
  popupWebPreferences,
  STATUS_BAR_HEIGHT,
  type ToolbarStatus,
  TOOLBAR_EXPANDED_HEIGHT,
  TOOLBAR_HEIGHT,
  wireStatusBar
} from '@butinapp/engine'
import type { ButinPlugin, LocalStorageToken } from '@butinapp/sdk'
import { app, BaseWindow, BrowserWindow, screen, type Session, type WebContents, WebContentsView } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import type { MagicLoginResult } from '../../shared/ipc.js'
import { getPluginSession, partitionFor } from '../browser/shared-session.js'
import { log } from '../log.js'
import { getMagicLoginUiState, getSetting, patchMagicLoginUiState, setSetting } from '../store/config-file.js'
import { createCredentialStore } from '../store/credentials.js'

import { detectSigninBlock, launchChromeSignin } from './chrome-login.js'

export type { MagicLoginResult }

export { partitionFor }

export type Readiness = { markerMatched: boolean; cookiePresent: boolean; ready: boolean }

type Rect = { x: number; y: number; width: number; height: number }

// Keep a remembered window rectangle usable: honor it only if a meaningful slice still lands inside some
// display's work area — a monitor can be unplugged or rearranged between runs, stranding the saved position
// offscreen. Returns the rectangle when visible enough, else null so the caller falls back to the default
// centered geometry. Pure so it's unit-tested; the `screen` lookup that feeds it stays Electron-only.
export const clampMagicWindowBounds = (bounds: Rect, workAreas: Rect[]): Rect | null => {
  const visible = workAreas.some((wa) => {
    const overlapX = Math.min(bounds.x + bounds.width, wa.x + wa.width) - Math.max(bounds.x, wa.x)
    const overlapY = Math.min(bounds.y + bounds.height, wa.y + wa.height) - Math.max(bounds.y, wa.y)

    return overlapX >= 100 && overlapY >= 40
  })

  return visible ? bounds : null
}

// Are the capture conditions met? The page must have settled on a dashboard marker AND the required
// cookie must be present (or, when a plugin names none, any cookie for its domains). Pure so it's unit-
// tested; the cookie/url I/O around it stays Electron-only. Drives both auto-capture and the indicator.
export const computeReadiness = (
  url: string,
  cookieNames: Set<string>,
  dashboardMarkers: string[],
  requiredCookie: string | undefined
): Readiness => {
  const markerMatched = dashboardMarkers.some((m) => url.includes(m))
  const cookiePresent = requiredCookie ? cookieNames.has(requiredCookie) : cookieNames.size > 0

  return { markerMatched, cookiePresent, ready: markerMatched && cookiePresent }
}

// The URL — across the capture window's main view AND any login popup — that satisfies a dashboard marker,
// else the main view's URL (the first entry, kept for the waiting indicator). Some services finish login in a
// `window.open` popup (Ably's Google OAuth lands on `/accounts/…` there), so the marker can match a child
// window the main view never navigates to. `urls` is main-view-first. Pure so it's unit-tested.
export const matchMarkerUrl = (urls: string[], dashboardMarkers: string[]): string =>
  urls.find((u) => dashboardMarkers.some((m) => u.includes(m))) ?? urls[0] ?? ''

// Map readiness → the toolbar indicator next to the Capture button. `manual` only changes the ready copy
// ("click Capture" vs "Ready to capture"), so the user knows they must act.
const statusFor = (r: Readiness, requiredCookie: string | undefined, manual: boolean): ToolbarStatus => {
  if (r.ready) {
    return { text: manual ? 'Ready — click Capture session' : 'Ready to capture', tone: 'ready' }
  }

  if (!r.markerMatched) {
    return { text: 'Waiting — not on the signed-in page yet', tone: 'waiting' }
  }

  return {
    text: requiredCookie ? `Waiting — '${requiredCookie}' cookie not set yet` : 'Waiting — no session cookie yet',
    tone: 'waiting'
  }
}

const cookieHeader = async (ses: Session, domains: string[]): Promise<{ header: string; names: Set<string> }> => {
  const cookies = await ses.cookies.get({})
  const wanted = cookies.filter((c) => domains.some((d) => (c.domain ?? '').includes(d)))

  return { header: wanted.map((c) => `${c.name}=${c.value}`).join('; '), names: new Set(wanted.map((c) => c.name)) }
}

// Per-host cookie footprint for the capture domains — the signal that explains an ADFS/IIS "Header Field
// Too Long" (HTTP 400): which host's cookies are bloating the request and how the total grows across a
// redirect chain. A single host approaching ~8–16KB of cookies is past most servers' request-header limit.
// Returns "<n> cookies, ~<bytes>b — <host>=<n>c/<bytes>b …" sorted by the biggest contributor first.
const cookieFootprint = async (ses: Session, domains: string[]): Promise<{ text: string; maxBytes: number }> => {
  const cookies = (await ses.cookies.get({})).filter((c) => domains.some((d) => (c.domain ?? '').includes(d)))
  const byHost = new Map<string, { n: number; bytes: number }>()

  for (const c of cookies) {
    const host = (c.domain ?? '').replace(/^\./, '')
    const cur = byHost.get(host) ?? { n: 0, bytes: 0 }

    // name=value plus the "; " separator — the bytes this cookie actually contributes to a Cookie header.
    cur.n += 1
    cur.bytes += c.name.length + c.value.length + 3
    byHost.set(host, cur)
  }

  const hosts = [...byHost.entries()].sort((a, b) => b[1].bytes - a[1].bytes)
  const total = hosts.reduce((s, [, v]) => s + v.bytes, 0)
  // The biggest single host is what a server sees on its request — that's what trips the header limit, not
  // the cross-domain sum. Drive the toolbar's red-warning flag off it.
  const maxBytes = hosts[0]?.[1].bytes ?? 0
  const breakdown = hosts.map(([h, v]) => `${h}=${v.n}c/${v.bytes}b`).join(' ')

  return { text: `${cookies.length} cookies, ~${total}b — ${breakdown}`, maxBytes }
}

// Read a token out of the page's localStorage. Supports an exact key, a dynamic key (all of
// `keyIncludes` must appear in it — e.g. Auth0's `@@auth0spajs@@::<clientId>::…`), and an optional
// dotted `jsonPath` into the parsed value (e.g. 'body.refresh_token'). Runs in the page context.
const extractLocalStorageToken = async (contents: WebContents, token: LocalStorageToken): Promise<string | null> => {
  const script = `(function () {
    var exactKey = ${JSON.stringify(token.key ?? null)}
    var includes = ${JSON.stringify(token.keyIncludes ?? null)}
    var k = exactKey
    if (!k && includes) {
      for (var i = 0; i < localStorage.length; i++) {
        var kk = localStorage.key(i)
        if (kk && includes.every(function (s) { return kk.indexOf(s) >= 0 })) { k = kk; break }
      }
    }
    if (!k) return null
    var v = localStorage.getItem(k)
    if (v == null) return null
    var path = ${JSON.stringify(token.jsonPath ?? null)}
    if (!path) return v
    try {
      var obj = JSON.parse(v)
      var parts = path.split('.')
      for (var j = 0; j < parts.length; j++) { obj = obj == null ? null : obj[parts[j]] }
      return typeof obj === 'string' ? obj : (obj == null ? null : JSON.stringify(obj))
    } catch (e) { return null }
  })()`

  try {
    return (await contents.executeJavaScript(script, true)) as string | null
  } catch {
    return null
  }
}

// First value of a header by case-insensitive name. `requestHeaders` is `name → value`; `responseHeaders`
// is `name → values[]` (and either side may vary the casing), so normalize both.
const headerValue = (headers: Record<string, string | string[]> | undefined, name: string): string | undefined => {
  if (!headers) {
    return undefined
  }

  const lower = name.toLowerCase()

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) {
      const v = Array.isArray(value) ? value[0] : value

      return typeof v === 'string' ? v.trim() : undefined
    }
  }

  return undefined
}

// Match a cookie name against a clear/skip list: an entry ending in `*` matches by PREFIX (for a cookie with a
// dynamic suffix, e.g. Ory Hydra's `ory_hydra_login_csrf_<hash>`), otherwise it's an exact name.
export const cookieNameMatches = (name: string, patterns: string[]): boolean =>
  patterns.some((p) => (p.endsWith('*') ? name.startsWith(p.slice(0, -1)) : name === p))

const clearCookies = async (ses: Session, patterns: string[]): Promise<void> => {
  if (patterns.length === 0) {
    return
  }

  for (const c of await ses.cookies.get({})) {
    if (!cookieNameMatches(c.name, patterns)) {
      continue
    }

    const host = (c.domain ?? '').replace(/^\./, '')

    try {
      await ses.cookies.remove(`https://${host}${c.path ?? '/'}`, c.name)
    } catch {
      // best effort
    }
  }
}

// Seed the partition from the saved credential so the capture/browse window opens ALREADY SIGNED IN — the same
// session headless replay uses — instead of a logged-out service that forces a pointless re-login. The stored
// credential is a flat `name=value; …` header (per-cookie attributes are lost), so each is rewritten as a
// durable host cookie on every declared cookieDomain; a host ignores any cookie that isn't its own, and a fresh
// sign-in overwrites these. `skip` drops the transient cookies a login clears (so seeding can't undo that).
// A dead saved session simply doesn't authenticate and the login page shows as before.
const seedSessionFromCredential = async (
  ses: Session,
  cookieDomains: string[],
  header: string,
  skip: string[]
): Promise<void> => {
  const pairs = header
    .split(';')
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => {
      const eq = c.indexOf('=')

      return eq < 0 ? null : { name: c.slice(0, eq).trim(), value: c.slice(eq + 1).trim() }
    })
    .filter(
      (p): p is { name: string; value: string } => p !== null && p.name !== '' && !cookieNameMatches(p.name, skip)
    )

  // A year out, so the seeded cookies are PERSISTENT — they survive the next launch too, not just this window.
  const expirationDate = Date.now() / 1000 + 365 * 24 * 60 * 60

  await Promise.all(
    cookieDomains.flatMap((domain) => {
      const host = domain.replace(/^\./, '')

      return pairs.map(
        (p) =>
          ses.cookies
            .set({
              url: `https://${host}`,
              name: p.name,
              value: p.value,
              domain: `.${host}`,
              path: '/',
              secure: true,
              sameSite: 'no_restriction',
              expirationDate
            })
            .catch(() => {}) // a single malformed pair must not abort the seed
      )
    })
  )
}

// Open a real browser window for hand-login (MFA/SSO/magic-link), reusing the shared persistent session
// so a prior Google/SSO login is remembered. A thin toolbar on top shows the live URL and offers a
// force-capture for when the page never settles on a `dashboardMarker`. When the page settles on a marker
// AND the required cookie has landed, capture the cookie jar + localStorage tokens, store them encrypted,
// and close.
// `backendKey` captures a SECONDARY login (a backend declaring its own `session`) on the same shared
// partition; its cookie is stored under `cookie:<backendKey>` so it coexists with the primary's. Omitted →
// the primary `plugin.session`, stored under `cookie`.
// `mode: 'browse'` opens the SAME captured session at `startUrl` (the service's dashboard) just to look
// around: auto-capture is forced off (only an explicit Capture click captures), no auto-login advance, and
// the existing cookies are never cleared — so you navigate the service as your live session without it
// re-capturing on every visit.
export type MagicLoginOptions = { backendKey?: string; mode?: 'login' | 'browse'; startUrl?: string }

// Reopening the SAME login this soon after a SUCCESSFUL capture is read as a retry: that capture almost
// certainly snapped a stale/half-finished session, and the user re-clicked to fix it. So the retry forces
// manual capture — the window waits for an explicit Capture click instead of snapping the wrong session again.
// Keyed on the last CAPTURE, not the last open, so reopening after a cancel (closed before capturing) is a
// fresh attempt that keeps auto-capture. Keyed per plugin+backend.
const RECENT_REOPEN_MS = 30_000
const lastCapturedAt = new Map<string, number>()

// A grace period after the page starts loading before auto-capture is evaluated. A service whose login URL
// already satisfies a `dashboardMarker` while a stale auth cookie lingers (Videotron's portal root + a prior
// KEYCLOAK_IDENTITY) would otherwise snap that half-finished session on the first poll tick, before sign-in.
// Manual capture and the readiness indicator are unaffected — only the auto-snap waits this out.
const MIN_AUTO_CAPTURE_MS = 1000

export const runMagicLogin = (plugin: ButinPlugin, opts: MagicLoginOptions = {}): Promise<MagicLoginResult> =>
  new Promise<MagicLoginResult>((resolve) => {
    const { backendKey, startUrl } = opts
    const browse = opts.mode === 'browse'
    // Sessionless (`external`) plugins have no capturable login; the IPC layer routes them to the config
    // form instead, so this is a defensive guard (never reached in normal flow).
    const backend = backendKey ? plugin.backends?.[backendKey] : undefined
    const session = backendKey ? backend?.session : plugin.session
    const credentialField = backendKey ? `cookie:${backendKey}` : 'cookie'

    if (!session) {
      resolve({ ok: false, error: `${plugin.meta.name} has no login to capture.` })

      return
    }

    const ses = getPluginSession(plugin)
    const partition = partitionFor(plugin)
    const { dashboardMarkers, cookieDomains, requiredCookie, localStorageTokens } = session

    // Headers the service's SPA emits that carry an id with no URL segment (Groq's `Groq-Organization`
    // response header, Hookdeck's `x-team-id` request header). Watch the shared session's traffic for the
    // window's lifetime, keeping the last seen value per field; `capture()` writes them to creds. The
    // listeners are detached in finish() — the partition is shared across plugins, so they must not outlive
    // this login. Electron allows one listener per event per session, so only attach the events in use.
    const headerCaptures = session.captureFromHeader ?? []
    const requestHeaderCaptures = headerCaptures.filter((c) => c.on === 'request')
    const responseHeaderCaptures = headerCaptures.filter((c) => (c.on ?? 'response') === 'response')
    const capturedHeaders = new Map<string, string>()

    if (requestHeaderCaptures.length > 0) {
      ses.webRequest.onSendHeaders({ urls: ['<all_urls>'] }, (details) => {
        for (const cap of requestHeaderCaptures) {
          const value = headerValue(details.requestHeaders, cap.header)

          if (value) {
            capturedHeaders.set(cap.storeAs, value)
          }
        }
      })
    }

    if (responseHeaderCaptures.length > 0) {
      ses.webRequest.onResponseStarted({ urls: ['<all_urls>'] }, (details) => {
        for (const cap of responseHeaderCaptures) {
          const value = headerValue(details.responseHeaders, cap.header)

          if (value) {
            capturedHeaders.set(cap.storeAs, value)
          }
        }
      })
    }

    const detachHeaderListeners = (): void => {
      if (requestHeaderCaptures.length > 0) {
        ses.webRequest.onSendHeaders(null)
      }

      if (responseHeaderCaptures.length > 0) {
        ses.webRequest.onResponseStarted(null)
      }
    }
    const loginName = backendKey ? `${plugin.meta.name} · ${backend?.label ?? backendKey}` : plugin.meta.name
    const tag = `magic:${plugin.meta.id}${backendKey ? `:${backendKey}` : ''}`

    // A reopen soon after a successful capture is treated as a retry of a botched auto-capture (see
    // RECENT_REOPEN_MS): force manual capture for this run regardless of the global setting. A reopen after a
    // cancel keeps auto-capture. Browse mode is never a login retry.
    const reopenedQuickly = !browse && Date.now() - (lastCapturedAt.get(tag) ?? 0) < RECENT_REOPEN_MS

    // When set, never auto-capture the moment the criteria are met — wait for an explicit Capture click.
    // Mutable so the toolbar's Auto-capture checkbox can flip it live; browse mode forces it on so opening a
    // service to look around never re-captures.
    let manualCapture = browse || reopenedQuickly || session.manualCaptureOnly === true || getSetting('manualCapture')

    if (reopenedQuickly) {
      log.info(
        tag,
        `reopened within ${RECENT_REOPEN_MS / 1000}s — auto-capture disabled for this run (sign in, then click Capture session)`
      )
    }

    // Remembered window state from the last Magic Login (global, last-used wins): geometry, whether DevTools
    // was open, the Debug panel + Freeze/Auto-pause toggles. Restored below.
    const ui = getMagicLoginUiState()

    // The window wears Butin's icon (dev/Linux; a packaged build uses the bundle icon and build/ isn't
    // shipped, so this resolves to nothing and is skipped). The title leads with the service so the chrome
    // reads as "where am I signing in", not the app name.
    const devIcon = join(app.getAppPath(), 'build/icon.png')

    // Reopen at the remembered rectangle when it still lands on a connected display; otherwise the default
    // centered geometry. A maximized window keeps these as its restore bounds, so it un-maximizes sanely.
    const savedBounds = ui.bounds
      ? clampMagicWindowBounds(
          ui.bounds,
          screen.getAllDisplays().map((d) => d.workArea)
        )
      : null

    const win = new BaseWindow({
      width: 1040,
      height: 820,
      ...(savedBounds ?? {}),
      title: browse ? loginName : `Sign in to ${loginName}`,
      autoHideMenuBar: true,
      ...(existsSync(devIcon) ? { icon: devIcon } : {})
    })

    if (ui.maximized) {
      win.maximize()
    }

    win.on('close', () => {
      if (!win.isDestroyed()) {
        patchMagicLoginUiState({ maximized: win.isMaximized(), bounds: win.getNormalBounds() })
      }
    })

    // sandbox:true so the renderer uses Chromium's native WebAssembly streaming compilation. With sandbox off,
    // Electron injects Node, whose wasm_web_api overrides WebAssembly.compileStreaming and aborts the renderer
    // on a login page that calls it (PostHog, Infisical). contextIsolation:false + the client-hints preload
    // still patch navigator.userAgentData in the page's main world (Google "secure browser" / Cloudflare) — a
    // sandboxed preload reaches the main world because isolation is off; it just has no Node, which it doesn't need.
    const site = new WebContentsView({
      webPreferences: { session: ses, contextIsolation: false, sandbox: true, preload: ensureClientHintsPreload() }
    })

    // Login popups (window.open) opened during the flow, kept on the shared partition by wireChildWindows.
    // The cookie jar is shared, so they're tracked only to read their URL for the marker check + their
    // localStorage on capture — a service can finish login in a popup the main view never navigates to.
    const childContents = new Set<WebContents>()
    // `site.webContents` reads undefined once the view is torn down (a poll tick can land mid-await as finish()
    // closes the window), so guard against undefined as well as destroyed.
    const liveContents = (): WebContents[] =>
      [site.webContents, ...childContents].filter((wc): wc is WebContents => Boolean(wc) && !wc.isDestroyed())

    let done = false
    let capturedSomething = false
    let incompleteWarning: string | undefined
    // Set after a forced capture grabbed a jar that's missing `requiredCookie`: the Capture button becomes a
    // "Done" close action so you don't have to hunt for the window's X. The next click re-grabs the freshest
    // jar (capturing cleanly if you've since finished signing in) and closes.
    let awaitingClose = false
    // Wall-clock after which auto-capture may fire; Infinity until the first load starts (set before loadURL),
    // so the freshly-opened window can't snap a stale session before MIN_AUTO_CAPTURE_MS of settle time.
    let autoCaptureAfter = Number.POSITIVE_INFINITY

    // Debug-panel state. `frozen` blocks main-frame navigations (manually, or auto on an HTTP error);
    // `toolbarHeight` grows when the panel is expanded so layout() shrinks the site view; `history` is the
    // recent main-frame nav strip. A single host past this many cookie bytes flags red (most servers cap
    // the request-header field around 8–16KB; warn earlier).
    let frozen = ui.freeze === true
    let autoPause = ui.autoPause === true
    let toolbarHeight = ui.debugExpanded ? TOOLBAR_EXPANDED_HEIGHT : TOOLBAR_HEIGHT
    const history: NavEntry[] = []
    const HEADER_WARN_BYTES = 6000

    const finish = (result: MagicLoginResult): void => {
      if (done) {
        return
      }

      done = true
      clearInterval(timer)
      detachHeaderListeners()
      log.info(
        tag,
        result.ok
          ? `finished — captured${result.warning ? ` (warning: ${result.warning})` : ''}`
          : `finished — ${result.error}`
      )

      // Close any login popup (window.open) still open — it's a separate top-level window, not a child of
      // `win`'s contentView, so closing `win` alone leaves it stranded for the user to dismiss by hand.
      for (const wc of childContents) {
        BrowserWindow.fromWebContents(wc)?.close()
      }

      if (!win.isDestroyed()) {
        win.close()
      }

      resolve(result)
    }

    // Capture the session: store the cookie header + any localStorage / URL tokens, then resolve. The
    // poll calls this gated on a `dashboardMarker`; the toolbar's button calls it with force=true, which
    // skips the marker. On force, an empty jar just warns (stay open to keep trying); a jar that's
    // missing `requiredCookie` still captures but warns the session may be incomplete (and stays open so
    // the warning is visible — a later clean capture closes the window).
    const capture = async (force: boolean): Promise<boolean> => {
      if (done || win.isDestroyed()) {
        return false
      }

      // The view that satisfies a marker (main OR a login popup), so URL-derived capture (captureFromUrl,
      // localStorage) reads from the authed page; falls back to the main view on force / no match.
      const live = liveContents()
      const target = live.find((wc) => dashboardMarkers.some((m) => wc.getURL().includes(m))) ?? live[0]

      if (!target) {
        return false
      }

      const url = target.getURL()

      if (!force && !dashboardMarkers.some((m) => url.includes(m))) {
        return false
      }

      const { header, names } = await cookieHeader(ses, cookieDomains)

      if (!header) {
        if (force) {
          toolbar.setWarning(`No cookies for ${cookieDomains.join(', ')} yet — finish signing in first.`)
        }

        return false
      }

      const missingRequired = Boolean(requiredCookie && !names.has(requiredCookie))

      if (missingRequired && !force) {
        log.debug(
          tag,
          `marker matched at ${url} but not ready — cookies [${[...names].join(', ')}], requiredCookie '${requiredCookie}' present=false`
        )

        return false
      }

      const creds = createCredentialStore(plugin.meta.id)

      creds.set(credentialField, header)
      capturedSomething = true
      // Stamp the capture so a quick reopen of this login is recognized as a redo-the-bad-snap retry (manual).
      lastCapturedAt.set(tag, Date.now())
      const storedLen = creds.get(credentialField)?.length ?? 0

      log.info(
        tag,
        `${force ? 'FORCE-CAPTURED' : 'CAPTURED'} at ${url} — cookies [${[...names].join(', ')}], header ${header.length} chars, stored ${storedLen} chars`
      )

      for (const token of localStorageTokens ?? []) {
        const value = await extractLocalStorageToken(target, token)

        if (typeof value === 'string' && value.length > 0) {
          creds.set(token.storeAs, value)
          log.info(tag, `localStorage token '${token.storeAs}' captured (${value.length} chars)`)
        }
      }

      for (const cap of session.captureFromUrl ?? []) {
        const matched = new RegExp(cap.pattern).exec(url)?.[1]

        if (matched) {
          creds.set(cap.storeAs, matched)
          log.info(tag, `captured '${cap.storeAs}' from URL: ${matched}`)
        }
      }

      for (const cap of headerCaptures) {
        const value = capturedHeaders.get(cap.storeAs)

        if (value) {
          creds.set(cap.storeAs, value)
          log.info(tag, `captured '${cap.storeAs}' from ${cap.on ?? 'response'} header '${cap.header}': ${value}`)
        }
      }

      // Forced capture of an incomplete jar: keep the window open so the warning is seen and the user can
      // finish the login, which re-captures cleanly. The Capture button turns into a "Done" close action so
      // the only way out isn't the window's X. Everything else closes on a clean capture.
      if (missingRequired) {
        awaitingClose = true
        incompleteWarning = `Captured, but "${requiredCookie}" is missing — the session may be incomplete.`
        toolbar.setWarning(`${incompleteWarning} Finish signing in to re-capture cleanly, or click Done to close.`)
        toolbar.setCaptureLabel('Done')

        return true
      }

      finish({ ok: true })

      return true
    }

    // Toolbar (force-capture + live URL + the Debug ▾ panel) docked above the page. Build it before
    // `capture` runs so its setWarning is available; its button drives a forced capture. The debug controls
    // close over the page's webContents/session so they can freeze navigation, open DevTools, and clear the
    // domain cookies + reload (the one-click unblock for an over-the-limit cookie header).
    const toolbar: MagicToolbar = createMagicToolbar({
      // Once the button has become "Done" (a prior force-capture was incomplete), a click re-grabs the
      // freshest jar — which finishes cleanly if the required cookie has since landed — then closes with
      // whatever was captured. Otherwise it's a normal force-capture.
      onForceCapture: () =>
        void (async () => {
          const closing = awaitingClose

          await capture(true)

          if (closing && !done) {
            finish({ ok: true, warning: incompleteWarning })
          }
        })(),
      // The page blocked the built-in browser (Google's "may not be secure"). Hand off to a real Chrome: the
      // user signs in there, Butin gathers the cookies into this same shared partition, then the page reloads
      // riding the seeded session.
      onChromeFallback: () =>
        void (async () => {
          toolbar.setChromeFallback(false)
          toolbar.setWarning('Opening Chrome. Sign in there, then close it and Butin brings the session home.')
          log.info(tag, 'launching real-Chrome sign-in fallback')

          const res = await launchChromeSignin('https://accounts.google.com')

          if (done || win.isDestroyed()) {
            return
          }

          if (res.ok) {
            toolbar.setWarning(`Session brought home (${res.syncedCount ?? 0} cookies). Reloading.`)
            log.info(tag, `chrome fallback synced ${res.syncedCount ?? 0} cookies — reloading ${session.loginUrl}`)
            await site.webContents.loadURL(session.loginUrl)
          } else {
            toolbar.setWarning(res.error ?? 'Chrome sign-in did not complete.')
          }
        })(),
      onNavigate: (raw) => {
        const url = raw.trim()

        if (!url) {
          return
        }

        // Bare host (no scheme) → assume https so the URL bar accepts "github.com" as well as a full URL.
        const target = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`

        log.info(tag, `navigate (toolbar) → ${target}`)
        void site.webContents.loadURL(target).catch(() => {})
      },
      onBack: () => {
        if (site.webContents.navigationHistory.canGoBack()) {
          site.webContents.navigationHistory.goBack()
        }
      },
      onForward: () => {
        if (site.webContents.navigationHistory.canGoForward()) {
          site.webContents.navigationHistory.goForward()
        }
      },
      onSetExpanded: (on) => {
        toolbarHeight = on ? TOOLBAR_EXPANDED_HEIGHT : TOOLBAR_HEIGHT
        layout()
        patchMagicLoginUiState({ debugExpanded: on })
      },
      onSetFreeze: (on) => {
        frozen = on
        patchMagicLoginUiState({ freeze: on })
        log.info(tag, on ? 'freeze ON — main-frame navigations/redirects will be blocked' : 'freeze OFF')
      },
      onSetAutoPause: (on) => {
        autoPause = on
        patchMagicLoginUiState({ autoPause: on })
        log.info(tag, on ? 'auto-pause on HTTP error ON' : 'auto-pause OFF')
      },
      onSetAutoCapture: (on) => {
        manualCapture = !on
        setSetting('manualCapture', !on)
        log.info(tag, on ? 'auto-capture ON' : 'auto-capture OFF — capture only on an explicit click')
      },
      initialFreeze: frozen,
      initialAutoPause: autoPause,
      initialAutoCapture: !manualCapture,
      initialDebugExpanded: ui.debugExpanded === true,
      onOpenDevTools: () => site.webContents.openDevTools({ mode: 'bottom' }),
      onReload: () => {
        log.info(tag, 'reload (debug) — re-fetching current page, cookies intact')
        site.webContents.reload()
      },
      onClearCookies: () =>
        void (async () => {
          await clearServiceCookies(ses, cookieDomains)
          frozen = false
          toolbar.setFrozen(false)
          toolbar.setWarning('')
          log.info(tag, `cleared ${cookieDomains.join(', ')} cookies (debug) — reloading ${session.loginUrl}`)
          await site.webContents.loadURL(session.loginUrl)
        })()
    })

    const statusBar = createStatusBar()

    win.contentView.addChildView(toolbar.view)
    win.contentView.addChildView(site)
    win.contentView.addChildView(statusBar.view)

    const layout = (): void => {
      const { width, height } = win.getContentBounds()
      const siteHeight = Math.max(0, height - toolbarHeight - STATUS_BAR_HEIGHT)

      toolbar.view.setBounds({ x: 0, y: 0, width, height: toolbarHeight })
      site.setBounds({ x: 0, y: toolbarHeight, width, height: siteHeight })
      statusBar.view.setBounds({ x: 0, y: toolbarHeight + siteHeight, width, height: STATUS_BAR_HEIGHT })
    }

    layout()
    win.on('resize', layout)

    const pushUrl = (): void => {
      toolbar.setUrl(site.webContents.getURL())
      const nav = site.webContents.navigationHistory

      toolbar.setNav(nav.canGoBack(), nav.canGoForward())
    }

    const hostOf = (url: string): string => {
      try {
        return new URL(url).host
      } catch {
        return url
      }
    }

    // Detect the "page reloaded and reloaded" redirect loop: too many main-frame navigations to the same
    // host in a short window. ADFS/IIS returns 400 "Header Field Too Long" once the looping accumulates more
    // cookies than its request-header limit, so flagging the loop points straight at the cause. Warns once
    // per crossing (=== threshold), not on every nav after.
    const navTimes: { host: string; t: number }[] = []
    const noteNavigation = (url: string): void => {
      const host = hostOf(url)
      const now = Date.now()

      navTimes.push({ host, t: now })

      while (navTimes.length > 0 && now - navTimes[0].t > 10_000) {
        navTimes.shift()
      }

      const same = navTimes.filter((n) => n.host === host).length

      if (same === 6) {
        log.warn(
          tag,
          `possible redirect loop — ${same} navigations to ${host} in 10s; if it ends in HTTP 400 the request cookies have outgrown the server's header limit (try Disconnect to clear ${cookieDomains.join(', ')} cookies, then retry)`
        )
      }
    }

    // Keep the last few main-frame navigations for the toolbar's Debug ▾ strip (status -1 = a redirect hop).
    const pushHistory = (status: number, url: string): void => {
      history.push({ status, url })

      while (history.length > 6) {
        history.shift()
      }

      toolbar.setHistory(history)
    }

    // Log the cookie footprint AND push it to the Debug panel, flagging red when the biggest host is past
    // the warn threshold — the at-a-glance signal for a "Header Field Too Long".
    const reportFootprint = (when: string): void => {
      void cookieFootprint(ses, cookieDomains)
        .then(({ text, maxBytes }) => {
          log.debug(tag, `cookies ${when}: ${text}`)
          toolbar.setFootprint(text, maxBytes > HEADER_WARN_BYTES)
        })
        .catch(() => {})
    }

    site.webContents.on('did-start-navigation', (_e, url, _isInPlace, isMainFrame) => {
      if (isMainFrame) {
        log.debug(tag, `→ navigating ${url}`)
        noteNavigation(url)
      }
    })

    site.webContents.on('did-redirect-navigation', (_e, url, _isInPlace, isMainFrame) => {
      if (isMainFrame) {
        log.debug(tag, `↪ redirect ${url}`)
        pushHistory(-1, url)
      }
    })

    // `did-navigate` carries the committed main-frame HTTP status — this is where the ADFS 400 surfaces. A
    // 4xx/5xx is warned and pushed to the toolbar so the user sees it without opening Diagnostics; the
    // cookie footprint after each nav shows the growth that led there.
    site.webContents.on('did-navigate', (_e, url, code, statusText) => {
      pushUrl()
      pushHistory(code, url)

      if (code >= 400) {
        log.warn(tag, `nav → ${code} ${statusText} ${url}`)
        toolbar.setWarning(`Server returned ${code} ${statusText} — open Debug ▾ for the cookie footprint.`)

        // Auto-pause: freeze further navigation so the error page stays put for inspection instead of the
        // loop bouncing onward. Reflect the flip in the toolbar's Freeze checkbox.
        if (autoPause && !frozen) {
          frozen = true
          toolbar.setFrozen(true)
          log.warn(tag, `auto-paused on HTTP ${code} — navigations frozen (uncheck Freeze to continue)`)
        }
      } else {
        log.debug(tag, `nav → ${code || ''} ${statusText || ''} ${url}`.replace(/\s+/g, ' ').trim())
      }

      reportFootprint('after nav')
    })

    site.webContents.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      pushUrl()

      if (isMainFrame) {
        log.debug(tag, `in-page → ${url}`)
      }
    })

    // -3 is ERR_ABORTED — normal when a redirect supersedes an in-flight load; everything else is a real
    // failure worth surfacing (DNS, TLS, connection reset).
    site.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (isMainFrame && code !== -3) {
        log.warn(tag, `load failed (${code} ${desc}) ${url}`)
      }
    })

    // A renderer crash / hang is the signal behind "the page paints, then goes white" — the render process
    // is gone (which also drops any attached DevTools, so it can't be debugged in-window). Logs the reason +
    // exit code so a crash on a specific service is diagnosable from the log. Wired on the main view and
    // every login popup (popups can crash where the main view doesn't — different webPreferences/origin).
    const watchCrashes = (wc: WebContents, label: string): void => {
      wc.on('render-process-gone', (_e, details) =>
        log.warn(
          tag,
          `${label} render process gone — reason=${details.reason} exitCode=${details.exitCode} at ${wc.getURL()}`
        )
      )
      wc.on('unresponsive', () => log.warn(tag, `${label} unresponsive at ${wc.getURL()}`))
    }

    watchCrashes(site.webContents, 'site')
    wireStatusBar(site.webContents, statusBar)

    // A sign-in that refuses the embedded browser (Google's "may not be secure") reveals the toolbar's "Sign
    // in with Chrome" hand-off; any other page hides it again. The block can land in EITHER the main view OR a
    // login popup — Google often runs the OAuth round-trip in a `window.open` and refuses it THERE while the
    // main view sits on the service's own login page — so re-evaluate across every live view and offer the
    // hand-off when ANY of them is blocked.
    const refreshSigninBlock = (): void =>
      void Promise.all(liveContents().map(detectSigninBlock)).then((results) => {
        if (done || win.isDestroyed()) {
          return
        }

        const blocked = results.some(Boolean)

        toolbar.setChromeFallback(blocked)

        if (blocked) {
          toolbar.setWarning(
            'This browser is blocked for sign-in. Click "Sign in with Chrome" to finish in your own Chrome.'
          )
          log.info(tag, 'detected an embedded-browser sign-in block — offering the Chrome hand-off')
        }
      })

    site.webContents.on('did-finish-load', refreshSigninBlock)
    site.webContents.on('did-navigate-in-page', refreshSigninBlock)

    // Freeze (debug): cancel navigations/redirects while on, so a runaway redirect loop stops on the
    // current page for inspection instead of bouncing onward and piling cookies past the header limit.
    site.webContents.on('will-redirect', (e, url) => {
      if (frozen) {
        e.preventDefault()
        log.warn(tag, `redirect blocked (frozen): ${url}`)
        toolbar.setWarning('Frozen — redirect blocked. Uncheck Freeze redirects to continue.')
      }
    })

    site.webContents.on('will-navigate', (e, url) => {
      if (frozen) {
        e.preventDefault()
        log.warn(tag, `navigation blocked (frozen): ${url}`)
        toolbar.setWarning('Frozen — navigation blocked. Uncheck Freeze redirects to continue.')
      }
    })

    // Some services run the social-login round-trip in a popup (window.open). Without a handler the child
    // window opens in Electron's DEFAULT session — a separate cookie jar — so the provider's state/CSRF
    // cookie set in our partition is invisible on the callback and validation fails. Keep popups on the
    // SAME partition with the same client-hints identity so auth carries over; recurse for nested popups.
    const wireChildWindows = (contents: WebContents): void => {
      contents.setWindowOpenHandler(() => ({
        action: 'allow',
        overrideBrowserWindowOptions: { webPreferences: popupWebPreferences(partition) }
      }))
      contents.on('did-create-window', (child) => {
        const wc = child.webContents

        childContents.add(wc)
        wc.on('destroyed', () => {
          childContents.delete(wc)
          // The blocked view may have been this popup — re-evaluate so the hand-off button hides once it's gone.
          refreshSigninBlock()
        })
        watchCrashes(wc, 'popup')
        // Google refuses the embedded browser INSIDE the OAuth popup, not the main view — watch it for the block.
        wc.on('did-finish-load', refreshSigninBlock)
        wc.on('did-navigate-in-page', refreshSigninBlock)
        wireChildWindows(wc)
      })
    }

    wireChildWindows(site.webContents)

    // Remember whether DevTools is open so the next window opens to match — observed from the real panel
    // (the toolbar button, F12, or the panel's own close all flow through here).
    site.webContents.on('devtools-opened', () => patchMagicLoginUiState({ devToolsOpen: true }))
    site.webContents.on('devtools-closed', () => patchMagicLoginUiState({ devToolsOpen: false }))

    // One persistent poll: every tick push the readiness indicator to the toolbar, then either capture
    // (auto mode, once the criteria are met) or auto-advance the unattended login steps (if enabled) until
    // a human-only step (password/MFA) or the wall clock. In manual mode, readiness only lights the
    // indicator — the user clicks Capture session to capture.
    let lastReadinessKey = ''
    const timer = setInterval(() => {
      void (async () => {
        if (done || win.isDestroyed()) {
          return
        }

        const { names } = await cookieHeader(ses, cookieDomains)
        const url = matchMarkerUrl(
          liveContents().map((wc) => wc.getURL()),
          dashboardMarkers
        )
        const readiness = computeReadiness(url, names, dashboardMarkers, requiredCookie)

        // Log only on a state change so the panel shows the moments that matter (marker hit, cookie landed,
        // became ready) rather than a line every 800ms.
        const key = `${readiness.markerMatched}|${readiness.cookiePresent}|${readiness.ready}`

        if (key !== lastReadinessKey) {
          lastReadinessKey = key
          log.debug(
            tag,
            `readiness — marker=${readiness.markerMatched} cookie=${readiness.cookiePresent} ready=${readiness.ready}`
          )
        }

        toolbar.setStatus(
          browse
            ? { text: 'Browsing your captured session', tone: 'ready' }
            : statusFor(readiness, requiredCookie, manualCapture)
        )

        if (readiness.ready) {
          // Auto mode captures + closes once past the initial grace; manual mode waits for the Capture button.
          if (!manualCapture && Date.now() >= autoCaptureAfter) {
            await capture(false)
          }

          return
        }
      })()
    }, 800)

    // Closing the window resolves the run: a forced-but-incomplete capture still counts as ok (with the
    // warning surfaced), otherwise it's a cancel.
    win.on('closed', () =>
      finish(
        capturedSomething
          ? { ok: true, warning: incompleteWarning }
          : { ok: false, canceled: true, error: 'Window closed before sign-in completed' }
      )
    )

    const openUrl = startUrl ?? session.loginUrl

    void (async () => {
      // Browse mode never touches the cookie jar — clearing anything would log you out of the very session
      // you came to look at. The clears below exist only to prepare a clean SIGN-IN.
      if (!browse) {
        // A `persistCookies:false` service (a bank whose stale token poisons re-auth → access-profile error)
        // starts EVERY sign-in from a clean jar: wipe all of its cookies first, so no expired-but-lingering
        // token corrupts the fresh login handshake. (Its cookies are also never promoted on quit.)
        if (session.persistCookies === false) {
          await clearServiceCookies(ses, cookieDomains)
        }

        // Drop only the transient cookies a plugin lists in `clearCookiesBeforeCapture` (e.g. GitHub's
        // ephemeral `_gh_sess`, which `promoteSessionCookies` wrongly persists and which then poisons the
        // social-login OAuth `state`). Durable auth cookies (GitHub's `user_session`) are left intact, so
        // re-clicking Magic Login while a session is still valid keeps you logged in and just re-captures.
        await clearCookies(ses, session.clearCookiesBeforeCapture ?? [])
      }

      // Seed the window from the saved session so it opens signed in (browse to look around, or Reconnect on a
      // still-live session), reusing the exact credential headless replay uses. ONLY for a plain `cookie` session,
      // whose stored credential IS the session and is modest. A minted-jwt / spa-bearer service carries a large
      // SSO jar (Clerk/Auth0) and authenticates by a minted token, not the cookie — reinjecting that whole jar
      // would blow the server's cookie-header limit (platform.openai.com → 400 "Request Header Or Cookie Too
      // Large"), and its window already signs in from the partition its login wrote. Skipped too for a
      // `persistCookies:false` service (clean-jar sign-in) and when there's no saved credential yet.
      const seedAuthKind = backend ? backend.auth.kind : plugin.auth.kind

      if (session.persistCookies !== false && seedAuthKind === 'cookie') {
        const saved = createCredentialStore(plugin.meta.id).get(credentialField)

        if (saved) {
          await seedSessionFromCredential(ses, cookieDomains, saved, session.clearCookiesBeforeCapture ?? [])
        }
      }

      log.info(
        tag,
        `opening ${browse ? 'browse' : 'login'} window → ${openUrl} (markers: ${dashboardMarkers.join(', ') || 'none'})`
      )
      reportFootprint('at open')

      // Reopen DevTools when it was open last time, so a failure during the very first load is inspectable
      // without re-toggling it each session.
      if (ui.devToolsOpen) {
        site.webContents.openDevTools({ mode: 'bottom' })
      }

      // Start the auto-capture grace clock from the first load, so an instant marker+cookie match can't snap
      // a stale session before the user has had a chance to sign in.
      autoCaptureAfter = Date.now() + MIN_AUTO_CAPTURE_MS
      await site.webContents.loadURL(openUrl)
    })()
  })
