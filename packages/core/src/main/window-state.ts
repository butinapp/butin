import { app, type BrowserWindow, type Rectangle, screen } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { log } from './log.js'

// Window size/position is app-global, not per-profile — it lives under userData (next to the browser
// partition), so switching profiles doesn't move or resize the window.
type WindowState = { bounds?: Rectangle; maximized?: boolean }

const stateFile = (): string => join(app.getPath('userData'), 'window-state.json')

export const readWindowState = (): WindowState => {
  const path = stateFile()

  if (!existsSync(path)) {
    return {}
  }

  try {
    return JSON.parse(readFileSync(path, 'utf8')) as WindowState
  } catch (err) {
    log.warn('window', 'window-state.json failed to parse — opening at default size', err)

    return {}
  }
}

// Saved bounds are only usable if they still intersect a connected display — otherwise a window restored from
// an unplugged monitor opens off-screen and is unreachable.
export const boundsAreVisible = (b: Rectangle): boolean =>
  screen.getAllDisplays().some((d) => {
    const a = d.workArea

    return b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y
  })

export const persistWindowState = (window: BrowserWindow): void => {
  try {
    // getNormalBounds returns the restored ("un-maximized") rectangle even while maximized, so unmaximizing
    // after a relaunch lands back where the window was — getBounds would freeze the maximized rectangle.
    const state: WindowState = { bounds: window.getNormalBounds(), maximized: window.isMaximized() }

    writeFileSync(stateFile(), JSON.stringify(state))
  } catch (err) {
    log.warn('window', 'failed to persist window state', err)
  }
}
