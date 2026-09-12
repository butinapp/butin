// Where the app stands with the next release, as one value the renderer draws from. `unavailable` is fixed for
// the whole run: a dev run, or a Linux run that is not the AppImage (there is no file to replace). `ready` means
// the update is downloaded and waits for the user's restart — the app never restarts on its own.
export type UpdateStateDto =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'downloading'; version: string; percent: number }
  | { kind: 'ready'; version: string }
  | { kind: 'upToDate'; checkedAt: string }
  | { kind: 'error'; message: string }
  | { kind: 'unavailable'; reason: 'dev' | 'not-appimage' }
