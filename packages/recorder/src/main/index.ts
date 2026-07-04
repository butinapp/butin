// @butinapp/recorder is a DEV-ONLY tool (pnpm record). It MUST NOT be imported by @butinapp/core — it is excluded from the shipped product by construction.
import { BROWSER_UA } from '@butinapp/engine'
import { app, BrowserWindow, Menu } from 'electron'
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

// Software rendering. A login page's anti-fraud WebGL / canvas readback — a browser-verification challenge is
// the case in point — destabilizes a real GPU process (UnknownVizError / "GPU state invalid" crashes) and,
// short of crashing, returns an inconsistent WebGL result the check scores as non-genuine. Rendering in
// software dodges both, and the capture window presents a genuine browser identity so it clears the same
// verification a login page runs. Recording is network capture, unaffected by the rendering backend. Must run
// before the app is ready.
app.disableHardwareAcceleration()

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
  // No application menu — like the main app. The recorder is a focused tool; the default Electron menu
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
