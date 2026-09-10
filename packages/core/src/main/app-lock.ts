import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { env } from './env.js'
import { log } from './log.js'

// The shared ~/butin root (BUTIN_HOME relocates it for an isolated dev/test run) — the same resolution as
// store/profiles.ts. The lock lives here, beside profiles.json, so the dev-only recorder (a SEPARATE Electron
// app that now shares this app's userData, and therefore its browser partitions) can read it.
const homeRoot = (): string => env.home ?? join(homedir(), 'butin')

const lockPath = (): string => join(homeRoot(), 'app.lock')

// Heartbeat the running app writes so the recorder can refuse to record the profile this app holds open: a
// browser partition's cookie LevelDB can't be opened by two processes at once, so recording the active
// profile's partition while the app runs would capture an empty session. The recorder reads pid + activeProfileId
// and verifies the pid is alive (a crash leaves a stale file).
export type AppLock = {
  pid: number
  activeProfileId: string
  startedAt: string
}

// Write (or refresh) the lock with this process's pid + the active profile. Boot calls it unconditionally so a
// crash-stale lock from a prior run is overwritten; the profile switch re-writes it to keep activeProfileId
// current. Best-effort — a failure here must never block startup or a switch.
export const writeAppLock = (activeProfileId: string): void => {
  try {
    mkdirSync(homeRoot(), { recursive: true })
    const lock: AppLock = { pid: process.pid, activeProfileId, startedAt: new Date().toISOString() }

    writeFileSync(lockPath(), JSON.stringify(lock, null, 2))
  } catch (err) {
    log.warn('app-lock', 'could not write app.lock', err)
  }
}

// Remove the lock on a clean quit. Best-effort — the next boot overwrites a stale lock regardless.
export const clearAppLock = (): void => {
  try {
    if (existsSync(lockPath())) {
      rmSync(lockPath(), { force: true })
    }
  } catch (err) {
    log.warn('app-lock', 'could not clear app.lock', err)
  }
}
