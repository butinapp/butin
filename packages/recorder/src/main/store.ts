import { app } from 'electron'
import { resolve } from 'node:path'

// Dev recordings live under the user's home, never in the repo or under Documents — same local-first
// rule as captured plugin data. BUTIN_HOME relocates the whole store (tests, isolated runs), mirroring
// the logic in @butinapp/core's env.ts so the recorder and core agree on the home root.
const butinHome = (): string =>
  process.env.BUTIN_HOME ? resolve(process.env.BUTIN_HOME) : `${app.getPath('home')}/butin`

export const recordingsRoot = (): string => `${butinHome()}/.recordings`

export const domainsFile = (): string => `${recordingsRoot()}/domains.json`

// The recorder's own small preference store (the last-selected profile, so a relaunch reopens where you left
// off). Recorder-local — distinct from the app's profiles registry, which the recorder only reads.
export const recorderPrefsFile = (): string => `${recordingsRoot()}/recorder-prefs.json`

// The app's profile registry, shared via BUTIN_HOME. The recorder reads it (never writes) so a recording
// can target the same browser session a given app profile uses.
export const profilesRegistry = (): string => `${butinHome()}/profiles.json`

// The app's heartbeat lock (written by @butinapp/core while it runs). The recorder reads it (never writes)
// to refuse recording a profile whose browser partition the app currently holds open.
export const appLockFile = (): string => `${butinHome()}/app.lock`
