import type { BrowserWindow } from 'electron'

// The single main window, shared between the app lifecycle (index.ts creates it + the auto-lock gate reads it)
// and the handlers that act on it (profileSwitch reloads it after repointing the roots; setTitleBarOverlay
// re-tints the native overlay on a theme switch).
let mainWindow: BrowserWindow | null = null

export const getMainWindow = (): BrowserWindow | null => mainWindow

export const setMainWindow = (w: BrowserWindow | null): void => {
  mainWindow = w
}
