import { BROWSER_UA } from '@butinapp/engine'
import { setReportingZone } from '@butinapp/sdk/util'
import { app, BrowserWindow, ipcMain, Menu, powerMonitor, session } from 'electron'

import { IPC } from '../shared/ipc.js'

import { clearAppLock, writeAppLock } from './app-lock.js'
import { persistAllSessions } from './browser/shared-session.js'
import { env } from './env.js'
import { sweepOpenTempDir } from './export/open-document.js'
import { appHandlers } from './ipc/app.js'
import { chromeSigninHandlers } from './ipc/chrome-signin.js'
import { devHandlers } from './ipc/dev.js'
import { fileHandlers } from './ipc/files.js'
import { jobHandlers } from './ipc/jobs.js'
import { lifecycleHandlers } from './ipc/lifecycle.js'
import { notificationHandlers } from './ipc/notifications.js'
import { profileHandlers } from './ipc/profiles.js'
import { reportHandlers } from './ipc/reports.js'
import type { IpcHandler, IpcHandlers } from './ipc/result.js'
import { serviceHandlers } from './ipc/service.js'
import { settingsHandlers } from './ipc/settings.js'
import { shellHandlers } from './ipc/shell.js'
import { updateHandlers } from './ipc/updates.js'
import { vaultHandlers } from './ipc/vault.js'
import { getMainWindow, setMainWindow } from './ipc/window-ref.js'
import { windowHandlers } from './ipc/window.js'
import { installConsoleCapture, log, pruneLogs, setLogLevels, setLogRetention } from './log.js'
import { loadPlugins, plugins } from './plugin/plugins.js'
import { getLogLevelOverrides, getSetting } from './store/config-file.js'
import { applyActiveProfile, ensureProfilesInitialized, getActiveProfileId, profileDir } from './store/profiles.js'
import { repairSnapshotCurrents } from './store/repair-snapshots.js'
import { eraseLegacyStores } from './store/store.js'
import { configureRequestPacing } from './transport/request-pacer.js'
import { configureUpdater, scheduleLaunchCheck } from './update/updater.js'
import { anyUnlocked, lockAll, vaultState } from './vault/vault.js'
import { createWindow } from './window.js'

// Pin the app identity so `userData` (which holds the safeStorage key + session partitions) is stable and
// independent of the npm package name. Must run before any `app.getPath('userData')`. Without this, Electron
// derives the name from `@butinapp/core`, and renaming the scope would strand the encrypted secrets + sessions.
app.setName('butin')

// Bucket every day/month in the user's own timezone (or an explicit override for a deterministic run), so "this
// month" and the per-day series roll at the user's local midnight instead of 00:00 UTC. Must run before any
// collector buckets a date — set it at module load, ahead of app-ready and the first fetch.
setReportingZone(env.reportingZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone)

// Windows ties the taskbar button (and notification grouping) to the AppUserModelID, NOT to the window icon —
// without one set, the taskbar falls back to the host executable's icon (electron.exe in dev). Pin it to the
// installer's appId so the taskbar shows Butin's own icon. No-op off Windows.
app.setAppUserModelId('dev.butin.app')

// Last-resort safety net: a stray throw/rejection from a collector, a browser callback, or a plugin must
// never reach Electron's fatal "A JavaScript error occurred in the main process" dialog that kills the app.
// IPC bodies already wrap in safeResult; this catches everything outside that path — log and keep running.
process.on('uncaughtException', (err) => log.error('main', 'uncaught exception (ignored):', err))
process.on('unhandledRejection', (reason) => log.error('main', 'unhandled rejection (ignored):', reason))

// Route every console.* across main + plugins into the log buffer/file from the earliest point, so nothing
// logged anywhere is invisible to the Diagnostics panel.
installConsoleCapture()

// Present a real, current Chrome to every webContents (string layer; client-hints + userAgentData are
// applied per-session/per-window). Without this, "secure browser" checks distrust Electron.
app.userAgentFallback = BROWSER_UA
app.on('web-contents-created', (_event, contents) => contents.setUserAgent(BROWSER_UA))

// Butin renders tables, text, and small charts — nothing GPU-heavy — so hardware acceleration is off. It
// also sidesteps a class of GPU-driver renderer crashes (0xC0000005 access violations) that some service
// login pages trigger in the capture window. Must be called before the app is ready.
app.disableHardwareAcceleration()

// Opt-in DevTools-protocol endpoint for driving the app from a CDP client (Playwright / chrome-devtools MCP)
// during development. Off unless BUTIN_REMOTE_DEBUG is set — the open port relaxes the Chromium sandbox, so
// it must never be on for a shipped build. Must be set before the app is ready.
if (env.remoteDebug) {
  app.commandLine.appendSwitch('remote-debugging-port', env.remoteDebugPort)
}

// Only one Butin process may own the active profile's config.json + browser partition at a time — a second
// launch would race the encrypted store and cookie jar. If the lock is already held, hand off to the running
// instance (focus its window) and exit; whenReady never fires for this process.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const mainWindow = getMainWindow()

    if (!mainWindow) {
      return
    }

    if (mainWindow.isMinimized()) {
      mainWindow.restore()
    }

    mainWindow.focus()
  })
}

// The IPC surface: each domain owns a fragment of handlers, composed here into the one domain → method table
// the registration loop walks. The annotation is the full (non-partial) IpcHandlers, so the compiler requires
// every channel of every domain to be covered — a fragment that forgets a channel fails to build.
const handlers: IpcHandlers = {
  app: appHandlers,
  dev: devHandlers,
  services: serviceHandlers,
  lifecycle: lifecycleHandlers,
  jobs: jobHandlers,
  reports: reportHandlers,
  files: fileHandlers,
  shell: shellHandlers,
  settings: settingsHandlers,
  updates: updateHandlers,
  notifications: notificationHandlers,
  chromeSignin: chromeSigninHandlers,
  profiles: profileHandlers,
  vault: vaultHandlers,
  window: windowHandlers
}

// Opt-in IPC tracing: with BUTIN_DEBUG set, every channel logs its name, duration, and ok/err to the log
// buffer + file. Off by default (zero overhead) — a switch you flip when chasing a main↔renderer issue.
const TRACE_IPC = Boolean(process.env['BUTIN_DEBUG'])

// One source of truth → one registration loop. Adding a channel is: a line in IPC, a method on ButinApi,
// a handler in the owning ipc/ fragment. The preload bridge is generated; this walks the domain → method
// table and wires every handler to its channel.
const wireIpc = (): void => {
  for (const domain of Object.keys(handlers) as (keyof IpcHandlers)[]) {
    const channels = IPC[domain] as Record<string, string>
    const fragment = handlers[domain] as Record<string, IpcHandler>

    for (const method of Object.keys(fragment)) {
      const label = `${domain}.${method}`

      ipcMain.handle(channels[method], async (event, ...args) => {
        if (!TRACE_IPC) {
          return fragment[method](event, ...(args as never[]))
        }

        const started = Date.now()

        try {
          const result = await fragment[method](event, ...(args as never[]))

          log.debug('ipc', `${label} ok ${Date.now() - started}ms`)

          return result
        } catch (err) {
          log.error('ipc', `${label} threw after ${Date.now() - started}ms`, err)
          throw err
        }
      })
    }
  }
}

void app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)

  // Apply the persisted retention window: gates whether daily files are written at all (0 = in-memory only),
  // then drops any files past the window on launch.
  setLogRetention(getSetting('logRetentionDays'))
  pruneLogs(getSetting('logRetentionDays'))

  // Load plugins in isolation BEFORE wiring IPC, so the registry is populated when the first listPlugins
  // call lands. A plugin that fails to load is skipped (logged inside loadPlugins), never fatal.
  const { failed } = await loadPlugins()

  if (failed.length > 0) {
    log.warn('main', `${failed.length} plugin(s) skipped (failed to load):`, failed)
  }

  // Establish the active profile context (migrating a legacy layout when one is present) BEFORE wiring IPC,
  // so the first listPlugins/overview read the active profile's config + data roots.
  const activeId = ensureProfilesInitialized(plugins.map((p) => p.meta.id))

  applyActiveProfile(activeId)

  // Publish the heartbeat lock so the dev recorder knows the app is holding this profile's session open.
  writeAppLock(activeId)

  // Best-effort removal of on-disk dirs superseded by the ledger model (reports/ → current/, history/ →
  // ledger/). Fires once per launch, does not block startup.
  void eraseLegacyStores()

  // Bring cached rosters in line with what each service's last fetch actually returned — a roster captured
  // before retention was recorded still projects everyone it ever saw. Derived from stored data, no refetch.
  void repairSnapshotCurrents()

  // Clear any plaintext copies of encrypted documents a prior session opened and couldn't delete (the OS app
  // held them open). Viewers are closed here — this guarantees no leftovers.
  void sweepOpenTempDir()

  // Apply the persisted log level + per-target overrides to the live gate once the active profile's config is
  // readable. Until this runs the logger sits at its 'info' default.
  setLogLevels(getSetting('logLevel'), getLogLevelOverrides())

  // Honor the persisted request-pacing toggle (defaults on); the pacer otherwise stays at its on default.
  configureRequestPacing(getSetting('paceRequests'))

  // Strict CSP on the renderer session in packaged builds. The renderer makes NO outbound requests — every
  // fetch runs in main — so a tight policy is a hard backstop against renderer-side exfiltration, and adds the
  // header-only directives (frame-ancestors/object-src/base-uri) the index.html meta tag can't enforce. Dev is
  // left to the meta tag, since the Vite dev server needs its own looser policy for HMR.
  if (!process.env['ELECTRON_RENDERER_URL']) {
    const csp =
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
      "font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'none'"

    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } })
    })
  }

  wireIpc()
  setMainWindow(createWindow())

  startAutoLock()

  // The one request the user did not click: a delayed, opt-out check for a newer release. Nothing else in the app
  // reaches the network on its own.
  configureUpdater()
  scheduleLaunchCheck()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      setMainWindow(createWindow())
    }
  })
})

// Auto-lock: zero every in-memory DEK on OS sleep and after an idle stretch, so a walked-away-from machine
// can't be read. When the ACTIVE profile is the one that just locked, reload the window so the renderer boots
// back into the lock gate (an unencrypted active profile keeps working — only the backgrounded encrypted ones
// drop their keys). Quit-time locking lives in before-quit. The idle timeout + sleep toggle are read live from
// settings each tick, so changing them takes effect without a restart.
const lockAllAndGate = (): void => {
  if (!anyUnlocked()) {
    return
  }

  lockAll()

  const mainWindow = getMainWindow()

  if (mainWindow && vaultState(profileDir(getActiveProfileId())) === 'locked') {
    const wc = mainWindow.webContents

    void wc.executeJavaScript("location.hash = '#/overview'").finally(() => wc.reload())
  }
}

const startAutoLock = (): void => {
  powerMonitor.on('suspend', () => {
    if (getSetting('lockOnSleep')) {
      lockAllAndGate()
    }
  })
  setInterval(() => {
    const idleLockMinutes = getSetting('idleLockMinutes')

    if (idleLockMinutes > 0 && powerMonitor.getSystemIdleTime() >= idleLockMinutes * 60) {
      lockAllAndGate()
    }
  }, 60_000)
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Promote in-memory session cookies to persistent before quitting, so Google/SSO logins survive the
// next launch instead of forcing a full re-auth. Async, so hold the quit until it's flushed.
let cookiesPersisted = false

app.on('before-quit', (event) => {
  if (cookiesPersisted) {
    return
  }

  // Drop the heartbeat lock first thing so the recorder sees the profile freed even while the async cookie
  // flush below holds the quit open.
  clearAppLock()

  // Zero every in-memory DEK before we go (also covered by process exit, but zeroing is cheap hygiene).
  lockAll()

  event.preventDefault()
  // Plugins that opt out of cookie persistence (session.persistCookies:false) — their cookie hosts are
  // left to expire on quit instead of being promoted, so a stale token can't poison the next sign-in.
  const noPersistDomains = plugins
    .filter((p) => p.session?.persistCookies === false)
    .flatMap((p) => p.session?.cookieDomains ?? [])

  // Sweep this session's decrypted-document temp copies alongside the cookie flush (the ones the OS has let
  // go of); anything still held open is collected by the next boot sweep.
  void Promise.allSettled([persistAllSessions(noPersistDomains), sweepOpenTempDir()]).finally(() => {
    cookiesPersisted = true
    app.quit()
  })
})
