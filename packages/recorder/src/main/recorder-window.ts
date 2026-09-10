import {
  applyBrowserIdentity,
  clearServiceCookies,
  copyCookies,
  createMagicToolbar,
  createStatusBar,
  detectSigninBlock,
  ensureClientHintsPreload,
  launchChromeSignin,
  popupWebPreferences,
  promoteSessionCookies,
  STATUS_BAR_HEIGHT,
  TOOLBAR_EXPANDED_HEIGHT,
  TOOLBAR_HEIGHT,
  wireStatusBar
} from '@butinapp/engine'
import { BaseWindow, session, WebContentsView, type WebContents } from 'electron'

import { hostOf, registrableDomain } from '../detect/url.js'

import { writeHarForRun } from './recording/har.js'
import { formatRunId } from './recording/naming.js'
import { Recorder } from './recording/recorder.js'
import { ensureRunDir, ensureSessionsRoot } from './recording/storage.js'
import type { FilterConfig, RecorderLogLine } from './recording/types.js'
import { recordingsRoot } from './store.js'

/** The shared Butin partition a recording targets when the caller names none — the same session the app uses. */
export const DEFAULT_PARTITION = 'persist:butin'

/** Remembered debugging aids for the recorder window (toggled from the toolbar Debug panel). */
export type DebugSettings = {
  /** Open DevTools on the site view as soon as a recording starts. */
  autoOpenDevTools: boolean
  /** Block server 3xx redirects so a page can be inspected before it bounces away. */
  freezeRedirects: boolean
  /** Auto-pause capture after recording a response with an HTTP error status (>= 400). */
  autoPauseOnError: boolean
  /**
   * Rewrite outgoing request headers to inject Butin's canonical browser identity (Sec-Ch-Ua, drop
   * X-Requested-With). On by default so Chrome-only checks (Slack et al.) pass. Turn OFF for sites
   * whose CSRF gateway requires the native Sec-Fetch-* / Origin headers that onBeforeSendHeaders drops
   * (e.g. Stripe → wsp_400_csrf_invalid_request). `applyBrowserIdentity` always sets the UA regardless;
   * `rewriteHeaders` only controls the per-request header injection.
   */
  browserHeaders: boolean
}

export type RecordingHandle = {
  runId: string
  runDir: string
  partition: string
  window: BaseWindow
  recorder: Recorder
  label: string
  startUrl: string
}

export type CreateRecorderOptions = {
  label: string
  startUrl: string
  /**
   * Persistent session partition to record in. Defaults to `persist:butin` — the shared Butin
   * partition so a logged-in session carries over. Override to `persist:butin-<id>` for a
   * plugin-scoped partition, or omit entirely to share the main app session.
   */
  partition?: string
  /**
   * Record in a fresh in-memory partition (no persisted cookies/localStorage) instead of a profile's shared
   * session — removes the stored cookie jar as a variable when diagnosing a login or browser-verification
   * challenge. Cookies captured here reach the profile's jar only when the run is stopped with the Debug
   * panel's Keep-this-session on; otherwise they die with the window. Overrides `partition`.
   */
  isolated?: boolean
  /**
   * Butin profile id owning the sign-in, keying the persistent real-Chrome user-data-dir the "Sign in with
   * Chrome" hand-off reuses. Same key the app uses, so a Google account signed in from Magic Login is already
   * signed in here. An isolated run uses its profile's key too — the isolation empties the Electron cookie
   * jar, not the identity.
   */
  chromeScopeId: string
  captureAll: boolean
  filters: FilterConfig
  autoRecord: boolean
  exportHar: boolean
  /** Remembered debugging aids (auto-open DevTools, freeze redirects, auto-pause on error). */
  debug: DebugSettings
  icon: string
  onProgress: (counts: { requests: number; websockets: number }) => void
  onLog?: (line: RecorderLogLine) => void
  onClosed: (handle: RecordingHandle) => void
}

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) {
    return `${bytes} B`
  }

  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }

  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`
}

/** F12 / Ctrl+Shift+I that yields the recorder's debugger to DevTools first. */
function bindDevToolsWithHandoff(contents: WebContents, recorder: Recorder): void {
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') {
      return
    }

    const isF12 = input.key === 'F12'
    const isCtrlShiftI = (input.control || input.meta) && input.shift && (input.key === 'I' || input.key === 'i')

    if (!isF12 && !isCtrlShiftI) {
      return
    }

    event.preventDefault()

    if (contents.isDevToolsOpened()) {
      contents.closeDevTools()
    } else {
      recorder.suspendForDevTools(contents)
      contents.openDevTools({ mode: 'detach' })
    }
  })
}

export async function createRecorderWindow(opts: CreateRecorderOptions): Promise<RecordingHandle> {
  const root = recordingsRoot()

  await ensureSessionsRoot(root)
  const runId = formatRunId(new Date(), opts.label)
  const runDir = await ensureRunDir(root, runId)

  // Shared Butin partition by default — the same persist:butin session the main app uses, so a
  // logged-in service session is already live when the recorder opens. Pass opts.partition to scope
  // to a specific plugin's partition (persist:butin-<id>) when that isolation is needed. An isolated
  // recording instead uses an in-memory partition unique to this run (no `persist:` prefix → nothing is
  // read from or written to disk), so a browser-verification challenge sees an empty cookie jar with no stale
  // clearance cookie. The profile's partition is kept alongside: it is where an isolated run's session is
  // carried when the run is stopped with Keep-this-session on.
  const profilePartition = opts.partition ?? DEFAULT_PARTITION
  const partition = opts.isolated ? `butin-iso-${runId}` : profilePartition
  const ses = session.fromPartition(partition)

  // Delegate identity to @butinapp/engine: sets the UA from the real Chromium version and (when
  // rewriteHeaders is true) injects Sec-Ch-Ua on every request, matching the main-app capture window
  // identity exactly. Identity is idempotent — a second call on the same session is a no-op.
  applyBrowserIdentity(ses, { rewriteHeaders: opts.debug.browserHeaders })

  // NOTE: we deliberately do NOT strip embedding/isolation response headers (X-Frame-Options, COOP/COEP,
  // CSP frame-ancestors). An earlier attempt stripped them to silence the ERR_BLOCKED_BY_RESPONSE logged
  // when sites sync sessions across sibling domains via hidden iframes (e.g. Stripe's stripe.com/handoff
  // chain). But those blocks are benign — the cookie-sync iframes simply no-op — whereas relaxing the
  // headers let the handoff half-run and corrupt Stripe's CSRF/session state (wsp_400_csrf_invalid_request).
  // Faithful recording means leaving response headers intact; the handoff console errors are cosmetic.

  // ensureClientHintsPreload() writes the navigator.userAgentData override script to userData once and
  // returns its absolute path — stays in sync with @butinapp/engine's real Chromium version rather
  // than a hardcoded one. Requires contextIsolation:false on the view that loads it (already the case
  // for the site view) so it can override navigator in the page main world.
  const popupPreload = ensureClientHintsPreload()

  const window = new BaseWindow({
    width: 1280,
    height: 920,
    title: `Butin Recorder — ${opts.label}`,
    backgroundColor: '#18181b',
    icon: opts.icon
  })

  const site = new WebContentsView({
    webPreferences: {
      session: ses,
      // contextIsolation:false lets the client-hints preload override navigator.userAgentData in the page's
      // main world so Chrome-only checks see Google Chrome. sandbox stays ON: a sandboxed preload still
      // reaches the main world (isolation is what gates that, not the sandbox), and contextIsolation:false +
      // sandbox:false together crash the renderer/GPU on heavy pages — a real browser sandboxes every page.
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: true,
      preload: popupPreload
    }
  })

  let paused = !opts.autoRecord

  // The status bar (load progress, title, hovered-link URL) — created before the recorder so a captured
  // download can flash a confirmation on it.
  const statusbar = createStatusBar()

  wireStatusBar(site.webContents, statusbar)

  const recorder = new Recorder({
    runDir,
    captureAll: opts.captureAll,
    filters: opts.filters,
    autoRecord: opts.autoRecord,
    autoPauseOnError: opts.debug.autoPauseOnError,
    onProgress: (counts) => {
      opts.onProgress(counts)
      toolbar.setCounts(counts.requests, counts.websockets)
    },
    onLog: opts.onLog,
    onDownload: ({ filename, bytes, savedAs }) => {
      const size = bytes ? ` (${formatBytes(bytes)})` : ''

      statusbar.flash(`⤓ Saved ${filename ?? 'file'}${size} → ${savedAs}`)
    }
  })

  // --- debug aids (toggled live from the toolbar Debug panel) ---
  let freezeRedirects = opts.debug.freezeRedirects
  // Isolated only: carry this run's captured session into the profile's partition when the window closes.
  // Off by default, so a diagnostic run cannot touch the shared session unless it is asked to.
  let keepSession = false

  // Open/close DevTools on the site view via the recorder handoff (one debugger per webContents, so
  // capture on this view pauses while DevTools is open and resumes on devtools-closed — see recorder).
  const setSiteDevTools = (open: boolean) => {
    const wc = site.webContents

    if (wc.isDestroyed()) {
      return
    }

    if (open && !wc.isDevToolsOpened()) {
      recorder.suspendForDevTools(wc)
      wc.openDevTools({ mode: 'detach' })
    } else if (!open && wc.isDevToolsOpened()) {
      wc.closeDevTools()
    }
  }

  // The shared Butin browser chrome: the magic toolbar in its 'record' variant (nav + REC/elapsed/counts +
  // Pause/Stop + the record debug panel) and the status bar (load progress, title, hovered-link URL).
  const toolbar = createMagicToolbar({
    variant: 'record',
    initialCaptureAll: opts.captureAll,
    initialPaused: paused,
    initialFreeze: opts.debug.freezeRedirects,
    initialAutoPause: opts.debug.autoPauseOnError,
    initialAutoOpenDevTools: opts.debug.autoOpenDevTools,
    initialBrowserHeaders: opts.debug.browserHeaders,
    showKeepSession: opts.isolated ?? false,
    onNavigate: (url) => {
      if (url) {
        void site.webContents.loadURL(url).catch(() => {})
      }
    },
    onBack: () => {
      const nav = site.webContents.navigationHistory

      if (nav.canGoBack()) {
        nav.goBack()
      }
    },
    onForward: () => {
      const nav = site.webContents.navigationHistory

      if (nav.canGoForward()) {
        nav.goForward()
      }
    },
    onReload: () => {
      if (!site.webContents.isDestroyed()) {
        site.webContents.reload()
      }
    },
    // The page refused the built-in browser (Google's "may not be secure"). Hand off to a real Chrome: the
    // user signs in there, Butin gathers the cookies into this recording's partition, then the page reloads
    // riding the seeded session — so the recording continues on an authenticated page.
    onChromeFallback: () =>
      void (async () => {
        toolbar.setChromeFallback(false)
        toolbar.setWarning('Opening Chrome. Sign in there, then close it and Butin brings the session home.')
        recorder.log('info', 'chrome-signin', 'Opening a real Chrome for the blocked sign-in')

        const res = await launchChromeSignin('https://accounts.google.com', {
          partition,
          scopeId: opts.chromeScopeId
        })

        if (site.webContents.isDestroyed()) {
          return
        }

        if (res.ok) {
          toolbar.setWarning(`Session brought home (${res.syncedCount ?? 0} cookies). Reloading.`)
          recorder.log('info', 'chrome-signin', `Synced ${res.syncedCount ?? 0} cookies — reloading ${opts.startUrl}`)
          await site.webContents.loadURL(opts.startUrl).catch(() => {})
        } else {
          toolbar.setWarning(res.error ?? 'Chrome sign-in did not complete.')
          recorder.log('warn', 'chrome-signin', res.error ?? 'Chrome sign-in did not complete')
        }
      })(),
    onStop: () => window.close(),
    onTogglePause: () => {
      paused = !paused
      applyPaused()
    },
    onSetExpanded: (on) => {
      toolbarExpanded = on
      layout()
    },
    onSetFreeze: (on) => {
      freezeRedirects = on
    },
    onSetAutoPause: (on) => recorder.setAutoPauseOnError(on),
    onSetAutoOpenDevTools: (on) => setSiteDevTools(on),
    onSetBrowserHeaders: (on) => {
      // Re-applying identity on the live session is a no-op (idempotent WeakSet guard in
      // applyBrowserIdentity) — the toggle takes effect on the NEXT window / session open.
      applyBrowserIdentity(ses, { rewriteHeaders: on })
    },
    onSetKeepSession: (on) => {
      keepSession = on
    },
    // Reset this site and reload, without ending the run. Scoped to the page's registrable domain, so every
    // host and scoping of the service goes together — which is what clears a stale cookie the service keeps
    // rejecting, a host-only one and its subdomain-scoped namesake alike.
    onClearCookies: () =>
      void (async () => {
        const domain = registrableDomain(hostOf(site.webContents.getURL()))

        if (!domain) {
          toolbar.setWarning('No site to clear — navigate somewhere first.')

          return
        }

        await clearServiceCookies(ses, [domain])
        freezeRedirects = false
        toolbar.setFrozen(false)
        toolbar.setWarning(`Cleared ${domain} cookies. Reloading.`)
        recorder.log('info', 'cookies-cleared', `Cleared cookies for ${domain}`, { domain })
        site.webContents.reload()
      })()
  })

  window.contentView.addChildView(toolbar.view)
  window.contentView.addChildView(site)
  window.contentView.addChildView(statusbar.view)

  let toolbarExpanded = false
  const layout = () => {
    const { width, height } = window.getContentBounds()
    const top = toolbarExpanded ? TOOLBAR_EXPANDED_HEIGHT : TOOLBAR_HEIGHT

    toolbar.view.setBounds({ x: 0, y: 0, width, height: top })
    site.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top - STATUS_BAR_HEIGHT) })
    statusbar.view.setBounds({ x: 0, y: height - STATUS_BAR_HEIGHT, width, height: STATUS_BAR_HEIGHT })
  }

  layout()
  window.on('resize', layout)

  // Crash-resilient session persistence. Chromium holds auth session cookies in memory and drops them on exit,
  // so they only survive if promoteSessionCookies runs — which the graceful-close path below does. But a
  // recording can end in a crash, and an abrupt exit never reaches that path, dropping a freshly captured login
  // and forcing a fresh sign-in + MFA next launch. Promote on an interval too, so a captured session survives
  // even when the window never closes cleanly.
  //
  // The manifest rides the same interval and for the same reason: a run dir without one is invisible in the UI,
  // so an abrupt exit would otherwise discard a recording whose requests are all safely on disk.
  const runIdentity = { label: opts.label, startUrl: opts.startUrl, partition }
  const persistInterval = setInterval(() => {
    void promoteSessionCookies(ses, [], { quiet: true })
    void recorder.checkpoint(runIdentity)
  }, 15_000)

  // One immediately, so even a run that dies in its first seconds is listed.
  void recorder.checkpoint(runIdentity)

  const applyPaused = () => {
    recorder.setPaused(paused)
    toolbar.setPaused(paused)
  }

  // Freeze redirects: block server/JS-driven 3xx redirect hops so a page can be inspected before it
  // bounces away (e.g. an auth handoff_complete chain). We only stop will-redirect, never will-navigate,
  // so the user's own link clicks still work. Each blocked hop is logged.
  const bindFreezeRedirects = (contents: WebContents) => {
    contents.on('will-redirect', (event, url) => {
      if (freezeRedirects) {
        event.preventDefault()
        recorder.log('warn', 'redirect-frozen', `Blocked redirect → ${url}`, { url })
      }
    })
  }

  // Surface Electron-level navigation failures (the "Failed to load URL … ERR_*" Electron logs)
  // into the run's trace, so a dead-ended login or blocked page is visible in the panel + log.jsonl.
  // ERR_ABORTED (-3) is the benign SPA double-navigation case we already swallow on the initial load.
  const logLoadFailures = (contents: WebContents) => {
    contents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (errorCode === -3) {
        return
      }

      recorder.log('error', 'load-failed', `${errorDescription || 'load failed'} — ${validatedURL}`, {
        url: validatedURL,
        errorCode,
        errorDescription,
        isMainFrame
      })
    })
  }

  // Reflect the live URL + back/forward availability into the toolbar.
  const pushUrl = (_e: unknown, url: string) => {
    const nav = site.webContents.navigationHistory

    toolbar.setUrl(url)
    toolbar.setNav(nav.canGoBack(), nav.canGoForward())
  }

  const childContents: WebContents[] = []

  // A sign-in that refuses the embedded browser (Google's "may not be secure") reveals the toolbar's "Sign in
  // with Chrome" hand-off; any other page hides it again. The block can land in EITHER the page OR a login
  // popup — Google often runs the OAuth round-trip in a `window.open` and refuses it THERE while the page sits
  // on the service's own login screen — so re-evaluate across every live view and offer the hand-off when ANY
  // of them is blocked.
  const refreshSigninBlock = (): void =>
    void Promise.all(
      [site.webContents, ...childContents].filter((wc) => !wc.isDestroyed()).map(detectSigninBlock)
    ).then((results) => {
      if (site.webContents.isDestroyed()) {
        return
      }

      const blocked = results.some(Boolean)

      toolbar.setChromeFallback(blocked)

      if (blocked) {
        toolbar.setWarning(
          'This browser is blocked for sign-in. Click "Sign in with Chrome" to finish in your own Chrome.'
        )
        recorder.log('warn', 'signin-blocked', 'The page refused the built-in browser — offering the Chrome hand-off')
      }
    })

  // Capture popups / child windows. They open on the same partition (auth carries
  // over), get the browser identity, F12 handoff, and are attached to the same recorder so
  // their traffic lands in this run. Nested popups are wired recursively.
  const wireChildWindows = (contents: WebContents) => {
    contents.setWindowOpenHandler(() => ({
      action: 'allow',
      overrideBrowserWindowOptions: { width: 1100, height: 820, webPreferences: popupWebPreferences(partition) }
    }))
    contents.on('did-create-window', (childWindow) => {
      const child = childWindow.webContents

      childContents.push(child)
      recorder.attachTo(child, 'popup')
      bindDevToolsWithHandoff(child, recorder)
      logLoadFailures(child)
      bindFreezeRedirects(child)
      child.on('did-navigate', (_e, url) => pushUrl(_e, url))
      child.on('did-finish-load', refreshSigninBlock)
      child.on('did-navigate-in-page', refreshSigninBlock)
      wireChildWindows(child)
    })
  }

  bindDevToolsWithHandoff(site.webContents, recorder)
  // F12 on the toolbar pane is useless — redirect it to the site view.
  toolbar.view.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') {
      return
    }

    const isF12 = input.key === 'F12'
    const isCtrlShiftI = (input.control || input.meta) && input.shift && (input.key === 'I' || input.key === 'i')

    if (!isF12 && !isCtrlShiftI) {
      return
    }

    event.preventDefault()

    if (site.webContents.isDevToolsOpened()) {
      site.webContents.closeDevTools()
    } else {
      recorder.suspendForDevTools(site.webContents)
      site.webContents.openDevTools({ mode: 'detach' })
    }
  })

  site.webContents.on('did-navigate', pushUrl)
  site.webContents.on('did-navigate-in-page', pushUrl)
  site.webContents.on('did-finish-load', refreshSigninBlock)
  site.webContents.on('did-navigate-in-page', refreshSigninBlock)
  logLoadFailures(site.webContents)
  bindFreezeRedirects(site.webContents)
  wireChildWindows(site.webContents)

  // Attach the recorder BEFORE the first navigation so nothing is missed.
  recorder.attachTo(site.webContents, 'page')

  recorder.log('info', 'start', `Recording started — ${opts.startUrl}`, {
    url: opts.startUrl,
    partition,
    captureAll: opts.captureAll,
    autoRecord: opts.autoRecord
  })

  // SPA signin pages (and meta-refresh / location.replace patterns) often initiate a second
  // navigation before the first one resolves; Chromium then rejects the original loadURL with
  // ERR_ABORTED even though the page is rendering. The recorder is already attached, so capture
  // is unaffected — just don't surface that as a "start failed" error to the panel.
  await site.webContents.loadURL(opts.startUrl).catch((err) => {
    if (!String(err?.message ?? err).includes('ERR_ABORTED')) {
      throw err
    }
  })

  applyPaused() // sync the toolbar badge with the initial paused state

  // Re-apply a remembered "auto-open DevTools" choice to this fresh recording.
  if (opts.debug.autoOpenDevTools) {
    setSiteDevTools(true)
  }

  const handle: RecordingHandle = {
    runId,
    runDir,
    partition,
    window,
    recorder,
    label: opts.label,
    startUrl: opts.startUrl
  }

  let stopping = false

  window.on('close', (event) => {
    if (stopping) {
      return
    }

    event.preventDefault()
    stopping = true
    clearInterval(persistInterval)
    void recorder
      .stop(runIdentity)
      .then(async () => {
        if (opts.exportHar) {
          await writeHarForRun(runDir).catch((err) => console.error('[recorder] HAR export failed:', err))
        }

        // An isolated run's jar dies with this window, so a session captured in it is carried into the
        // profile's partition BEFORE anything is torn down. Opt-in via the Debug panel's Keep-this-session, so
        // a run that was only diagnosing leaves nothing behind.
        if (opts.isolated && keepSession) {
          const target = session.fromPartition(profilePartition)
          const copied = await copyCookies(ses, target)

          recorder.log('info', 'session-kept', `Carried ${copied} cookies into ${profilePartition}`, {
            partition: profilePartition,
            copied
          })
          await promoteSessionCookies(target)
        }

        // Promote session cookies to persistent so a login captured during this recording survives quit —
        // Chromium drops in-memory session cookies even in a persist: partition. The recorder shares the
        // persist:butin session, so the next recording (or the app) opens already logged in.
        await promoteSessionCookies(ses)
      })
      .catch((err) => console.error('[recorder] stop failed:', err))
      .finally(() => {
        opts.onClosed(handle)

        try {
          window.destroy()
        } catch {
          // already destroyed
        }
      })
  })

  return handle
}
