import { app, BrowserWindow, nativeTheme, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { boundsAreVisible, persistWindowState, readWindowState } from './window-state.js'

export const createWindow = (): BrowserWindow => {
  // Dev/Linux taskbar icon. In a packaged build the OS uses the electron-builder bundle icon, and
  // build/ isn't shipped, so this resolves to nothing and is skipped — no-op, not an error.
  const devIcon = join(app.getAppPath(), 'build/icon.png')
  const devUrl = process.env['ELECTRON_RENDERER_URL']

  const state = readWindowState()
  const restored = state.bounds && boundsAreVisible(state.bounds) ? state.bounds : undefined

  // First-launch fallback for the window chrome (background + controls overlay): the in-app theme lives in the
  // renderer's storage, which the main process can't read before the renderer boots, so seed from the OS
  // scheme. The renderer re-tints both the overlay AND the window background to the in-app theme once it paints
  // (window IPC setTitleBarOverlay), and keeps them synced on every switch — so reloads track the app theme.
  const chrome = nativeTheme.shouldUseDarkColors
    ? { background: '#0f1115', symbol: '#a1a1aa' }
    : { background: '#fafafb', symbol: '#52525b' }

  const window = new BrowserWindow({
    width: restored?.width ?? 1440,
    height: restored?.height ?? 920,
    ...(restored ? { x: restored.x, y: restored.y } : {}),
    minWidth: 940,
    minHeight: 640,
    title: 'Butin',
    backgroundColor: chrome.background,
    // Drop the native title bar — it would render "Butin" a second time above the in-app header — but keep the
    // OS min/max/close as an overlay the header reserves space for (macOS keeps its inset traffic lights).
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: chrome.background, symbolColor: chrome.symbol, height: 48 },
    ...(existsSync(devIcon) ? { icon: devIcon } : {}),
    // sandbox:false so the ESM (.mjs) preload can initialize contextBridge; contextIsolation stays
    // on (default) so the renderer only sees the `window.butin` surface, never Node.
    webPreferences: { preload: join(import.meta.dirname, '../preload/index.mjs'), sandbox: false }
  })

  if (state.maximized) {
    window.maximize()
  }

  window.on('close', () => persistWindowState(window))

  // The renderer is a fixed local document driven by hash routing (which never triggers navigation). Block
  // any real navigation away from it and any attempt to spawn a window; http(s) links are handed to the OS
  // browser instead. This is the same lockdown the Magic Login window applies to untrusted pages.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url)
    }

    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, url) => {
    // In dev, only the Vite dev-server document (and its HMR full-reloads) may navigate; in a packaged build
    // there is no legitimate navigation at all, so everything is blocked.
    if (!devUrl || !url.startsWith(devUrl)) {
      event.preventDefault()
    }
  })

  if (devUrl) {
    void window.loadURL(devUrl)
  } else {
    void window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }

  return window
}
