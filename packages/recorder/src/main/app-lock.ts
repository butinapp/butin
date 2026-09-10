import { readFileSync } from 'node:fs'

import { appLockFile } from './store.js'

// What the renderer needs to know about the running app: is it holding a session open, and which profile.
export type AppLockStatus = {
  running: boolean
  /** The profile the app currently holds open — the one a recording must not target. */
  activeProfileId?: string
}

// Is a pid a live process? ESRCH ⇒ no such process (a crash-stale lock); EPERM ⇒ it exists but isn't ours to
// signal (still alive). Anything else, err on "not running" so a quirk never blocks recording.
const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)

    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// Pure evaluation of a lock file's contents, separated from disk + liveness so it can be unit-tested. A
// missing/blank/malformed file, a non-numeric pid, or a dead pid all read as "not running".
export const evaluateAppLock = (text: string | undefined, isAlive: (pid: number) => boolean): AppLockStatus => {
  if (!text) {
    return { running: false }
  }

  try {
    const raw = JSON.parse(text) as { pid?: unknown; activeProfileId?: unknown }

    if (typeof raw.pid !== 'number' || !isAlive(raw.pid)) {
      return { running: false }
    }

    return { running: true, activeProfileId: typeof raw.activeProfileId === 'string' ? raw.activeProfileId : undefined }
  } catch {
    return { running: false }
  }
}

// Read ~/butin/app.lock and decide whether the app is running. Never throws — a missing file is the common
// "app not running" case.
export const readAppLock = (): AppLockStatus => {
  let text: string | undefined

  try {
    text = readFileSync(appLockFile(), 'utf8')
  } catch {
    text = undefined
  }

  return evaluateAppLock(text, isPidAlive)
}
