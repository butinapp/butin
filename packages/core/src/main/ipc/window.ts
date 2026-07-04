import { log } from '../log.js'

import type { IpcHandlers } from './result.js'
import { getMainWindow } from './window-ref.js'

export const windowHandlers = {
  // Sync the window chrome to the active theme on every light/dark switch. Two effects:
  //  - the window's own background color, so a reload (a profile switch repoints the roots and reloads the
  //    window) shows the app's surface in the gap before the renderer repaints — not the OS scheme the window
  //    launched with. Honored on every platform.
  //  - the native window-controls overlay tile/glyphs — drawn only on Windows/Linux; setTitleBarOverlay throws
  //    elsewhere, so it's guarded.
  setTitleBarOverlay: (_event, colors: { color: string; symbolColor: string }) => {
    const mainWindow = getMainWindow()

    if (!mainWindow) {
      return
    }

    mainWindow.setBackgroundColor(colors.color)

    if (process.platform === 'darwin') {
      return
    }

    try {
      mainWindow.setTitleBarOverlay({ ...colors, height: 48 })
    } catch (err) {
      log.warn('window', 'setTitleBarOverlay failed', err)
    }
  }
} satisfies IpcHandlers['window']
