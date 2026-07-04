import type { TroubleshootingAction, TroubleshootingCause } from '@butinapp/sdk'

// The recognized failure causes and the controlled actions a failure can offer. The cause union is the SDK's
// TroubleshootingCause — core's failure classifier and the UI's error panel resolve against the same set.
// Carried on a failed Result so the renderer renders the right ErrorPanel without re-classifying.
export type FailureCauseDto = TroubleshootingCause

export type FailureActionDto = TroubleshootingAction

// The one envelope every fallible channel returns: a thrown collector/network error never crosses IPC
// unhandled — it comes back as { ok: false, error }. Success payloads ride under `data`. A failure also
// carries the classified `cause` + `actions` (when known) so the UI can render structured guidance. (Domain
// results that encode their own success/failure — MagicLoginResult, ConnectionTest — stay separate: there
// `ok` means "logged in" / "session healthy", not "no exception".)
export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; cause?: FailureCauseDto; actions?: FailureActionDto[] }

// The host OS, read synchronously on `window.butin` at first paint — the renderer needs it to inset the header
// for the native window controls (no round-trip).
export type ButinPlatform = 'darwin' | 'win32' | 'linux' | string
