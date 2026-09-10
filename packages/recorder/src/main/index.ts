// @butinapp/recorder is a DEV-ONLY tool (pnpm record). It MUST NOT be imported by @butinapp/core — it is excluded from the shipped product by construction.
import { BROWSER_UA } from '@butinapp/engine'
import { app, BrowserWindow, crashReporter, Menu } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { registerRecorderHandlers } from './ipc.js'

// Present a real, current Chrome to EVERY webContents at the app level — the string-layer UA a window or
// subframe with no explicit override falls back to. Per-session applyBrowserIdentity covers only the main
// site view's requests + its navigator.userAgent; a login popup, and the UA a cross-origin browser-verification
// iframe falls back to, otherwise get Electron's default UA (…Electron/x…), which an edge that verifies a real
// browser reads as an inconsistent / non-Chrome browser and refuses the session. Must run before app-ready.
app.userAgentFallback = BROWSER_UA
app.on('web-contents-created', (_event, contents) => contents.setUserAgent(BROWSER_UA))

// The recorder runs on the real GPU deliberately — do not disable hardware acceleration here. A page that
// leans on WebGL and canvas readback can cost the compositor a frame, and SwiftShader is Chromium's last
// fallback: with hardware off it is the only backend left, so a frame it cannot serve has nowhere to fall back
// TO and the browser process goes down with the run. On the GPU the same failure degrades to software instead.

// Name every child process Chromium loses, with its reason and exit code. When the app dies mid-recording the
// only question that matters is which process went first — without this the trail is a bare exit code.
// Registered before ready so a crash during startup is covered too.
app.on('child-process-gone', (_event, details) => {
  console.error(
    `[recorder] child process gone — type=${details.type} name=${details.name ?? '-'} reason=${details.reason} exitCode=${details.exitCode}`
  )
})

app.on('render-process-gone', (_event, contents, details) => {
  console.error(
    `[recorder] render process gone at ${contents.getURL()} — reason=${details.reason} exitCode=${details.exitCode}`
  )
})

// A capture path that throws asynchronously must not take the recorder down mid-run: the requests already
// written stay valid, and the log line says what failed.
process.on('uncaughtException', (err) => console.error('[recorder] uncaught exception (ignored):', err))
process.on('unhandledRejection', (reason) => console.error('[recorder] unhandled rejection (ignored):', reason))

// Pin the app identity to match @butinapp/core (core/src/main/index.ts). userData holds the session
// partitions on disk (userData/Partitions/<name>), so without this the recorder gets its OWN userData dir
// and its `persist:butin` partition is a different — empty — folder than the app's. Pinning the name points
// both at the same partition store, so a service you're logged into in the app is already live in a
// recording. Must run before any app.getPath('userData') / session.fromPartition.
app.setName('butin')

// Windows ties the taskbar button (and its icon) to the AppUserModelID, NOT to the window icon — without one
// set, the taskbar falls back to the host executable's icon (electron.exe in dev). Give the recorder its own
// id (distinct from the app's `dev.butin.app`) so it gets a separate taskbar group showing the recorder icon.
// No-op off Windows.
app.setAppUserModelId('dev.butin.recorder')

// Collect crash dumps locally. Without a crash handler connected, crashpad catches a native crash in the main
// process, finds nowhere to write it, and self-terminates with one of its own 0xffff70xx termination codes — so
// a browser-process crash leaves nothing behind but that exit code. With one, a minidump carrying the faulting
// stack lands in app.getPath('crashDumps') instead. Crashpad resolves that directory from the app name, so this
// MUST run after setName or the dumps go to a directory nothing reads. Nothing is uploaded: this is a local dev
// tool, and a dump of a recording session would carry the page's memory.
crashReporter.start({ uploadToServer: false })

const createWindow = (): void => {
  // The recorder's own mark (Butin's hub with a red center) — the dev/Linux taskbar icon, so the recording
  // tool is distinguishable from the app. build/ isn't shipped (the recorder is dev-only), so off-disk this
  // skips to Electron's default; no-op, not an error.
  const devIcon = join(app.getAppPath(), 'build/icon.png')

  const win = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 640,
    title: 'Butin Recorder',
    ...(existsSync(devIcon) ? { icon: devIcon } : {}),
    // Charcoal canvas so the window paints dark from the first frame (no white flash before the dark-first
    // renderer mounts) — matches the capture window and the --background token.
    backgroundColor: '#18181b',
    // No native menu bar on this window (belt-and-suspenders with the app-level Menu.setApplicationMenu(null);
    // on Windows the window keeps its own bar otherwise).
    autoHideMenuBar: true,
    // sandbox:false so the ESM (.mjs) preload can initialize contextBridge; contextIsolation stays on
    // (default) so the renderer only sees the `window.recorder` surface, never Node.
    webPreferences: { preload: join(import.meta.dirname, '../preload/index.mjs'), sandbox: false }
  })

  // Strip the menu bar entirely (autoHideMenuBar only hides it until Alt is pressed).
  win.removeMenu()

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile('out/renderer/index.html')
  }
}

void app.whenReady().then(() => {
  // A dump's own id and date stay blank unless a crash server processes it, so the notice points at the
  // directory — the newest .dmp there is the last crash.
  if (crashReporter.getLastCrashReport()) {
    console.error(`[recorder] a previous run crashed — dumps in ${app.getPath('crashDumps')}`)
  }

  // No application menu: the recorder is a focused tool, and the default Electron menu
  // (File/Edit/View/Window/Help with reload + DevTools) is noise here.
  Menu.setApplicationMenu(null)
  registerRecorderHandlers()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
