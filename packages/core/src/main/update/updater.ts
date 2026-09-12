import { autoUpdater } from 'electron-updater'

import { IPC_EVENT, type UpdateStateDto } from '../../shared/ipc.js'
import { env } from '../env.js'
import { getMainWindow } from '../ipc/window-ref.js'
import { log } from '../log.js'
import { getSetting } from '../store/config-file.js'

import { reduceUpdateEvent, type UpdateEvent, updaterAvailability } from './update-state.js'

// Seconds between the window appearing and the launch check, so the one request the user did not click never
// competes with first paint or the first refresh.
const LAUNCH_CHECK_DELAY_MS = 10_000

const availability = updaterAvailability({ isDev: env.isDev, platform: process.platform, appImage: env.appImage })

let state: UpdateStateDto = availability ? { kind: 'unavailable', reason: availability } : { kind: 'idle' }

export const updateState = (): UpdateStateDto => state

const emit = (event: UpdateEvent): void => {
  state = reduceUpdateEvent(state, event)
  getMainWindow()?.webContents.send(IPC_EVENT.updateState, state)
}

// Bind the updater once the app is ready. Off an updatable build nothing is wired, so a dev run never touches
// electron-updater. The download starts on its own once a newer release is found; the install waits for the
// user's restart, or rides the next normal quit.
export const configureUpdater = (): void => {
  if (availability) {
    return
  }

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = false
  autoUpdater.logger = {
    info: (message: unknown) => log.info('update', message),
    warn: (message: unknown) => log.warn('update', message),
    error: (message: unknown) => log.error('update', message),
    debug: (message: string) => log.debug('update', message)
  }

  autoUpdater.on('checking-for-update', () => emit({ type: 'checking' }))
  autoUpdater.on('update-available', (info) => emit({ type: 'available', version: info.version }))
  autoUpdater.on('update-not-available', () => emit({ type: 'not-available', at: new Date().toISOString() }))
  autoUpdater.on('download-progress', (progress) => emit({ type: 'progress', percent: progress.percent }))
  autoUpdater.on('update-downloaded', (info) => emit({ type: 'downloaded', version: info.version }))
  autoUpdater.on('error', (err) => emit({ type: 'error', message: err.message }))
}

// Ask GitHub for a newer release. A no-op while a check or download is running, and off an updatable build.
// A failure is already reported through the 'error' event, so the rejection carries nothing new.
export const checkForUpdate = (): void => {
  if (availability || state.kind === 'checking' || state.kind === 'downloading') {
    return
  }

  void autoUpdater.checkForUpdates().catch(() => undefined)
}

// The launch check: delayed, and only while the setting allows it. Read at fire time so turning the setting off
// during the delay still cancels the check.
export const scheduleLaunchCheck = (): void => {
  if (availability) {
    return
  }

  setTimeout(() => {
    if (getSetting('autoUpdate')) {
      checkForUpdate()
    }
  }, LAUNCH_CHECK_DELAY_MS)
}

// Restart into the downloaded update. Silent on Windows (the installer reuses the current install directory and
// relaunches); the arguments are ignored elsewhere. Quitting goes through the app's before-quit handler, so the
// session cookies are flushed before the installer takes over.
export const installUpdate = (): void => {
  if (state.kind !== 'ready') {
    return
  }

  autoUpdater.quitAndInstall(true, true)
}
