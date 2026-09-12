import type { UpdateStateDto } from '../../shared/ipc.js'

// What the updater reports, reduced onto UpdateStateDto. Kept off electron-updater's own event types so the
// reduction is testable without Electron.
export type UpdateEvent =
  | { type: 'checking' }
  | { type: 'available'; version: string }
  | { type: 'progress'; percent: number }
  | { type: 'downloaded'; version: string }
  | { type: 'not-available'; at: string }
  | { type: 'error'; message: string }

// A downloaded update stays ready whatever the updater reports afterwards: the bytes are on disk and the restart
// still applies them, so a later failure (a re-check while offline) must not hide the restart button.
export const reduceUpdateEvent = (state: UpdateStateDto, event: UpdateEvent): UpdateStateDto => {
  if (state.kind === 'ready') {
    return state
  }

  switch (event.type) {
    case 'checking':
      return { kind: 'checking' }
    case 'available':
      return { kind: 'downloading', version: event.version, percent: 0 }
    case 'progress':
      return {
        kind: 'downloading',
        version: state.kind === 'downloading' ? state.version : '',
        percent: Math.round(event.percent)
      }
    case 'downloaded':
      return { kind: 'ready', version: event.version }
    case 'not-available':
      return { kind: 'upToDate', checkedAt: event.at }
    case 'error':
      return { kind: 'error', message: event.message }
  }
}

// Why this run cannot update, or null when it can. A Linux build updates by replacing the AppImage file, which
// exists only when the AppImage runtime launched the app (it sets APPIMAGE to that path).
export const updaterAvailability = (run: {
  isDev: boolean
  platform: NodeJS.Platform
  appImage: string | undefined
}): 'dev' | 'not-appimage' | null => {
  if (run.isDev) {
    return 'dev'
  }

  if (run.platform === 'linux' && !run.appImage) {
    return 'not-appimage'
  }

  return null
}
