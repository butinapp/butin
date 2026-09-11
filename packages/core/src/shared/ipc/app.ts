export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

// One captured log line for the Logs view. `seq` is a monotonic per-session id (stable keys + ordering);
// `scope` is an optional subsystem tag ('ipc', 'net', 'profiles'); `plugin`/`action` carry structured
// origin when a line comes from a plugin's collect (so the viewer filters by them); `data` is optional
// structured context the viewer shows expandable.
export type LogEntryDto = {
  seq: number
  ts: string
  level: LogLevel
  scope?: string
  plugin?: string
  action?: string
  message: string
  data?: Record<string, unknown>
}

// A plugin that failed to load (threw at module-eval, or exported no valid descriptor). `path` is the
// plugin folder name; `reason` is the error message. Surfaced as a non-fatal banner so a missing service
// is explainable.
export type PluginLoadFailureDto = { path: string; reason: string }

// One loaded plugin's resolved engine taxonomy + any non-fatal validation warnings, for the Diagnostics page.
export type PluginDiagnosticDto = {
  id: string
  name: string
  authKind: string
  transport: 'node' | 'electron'
  sessionless: boolean
  capabilities: number
  warnings: string[]
}

// The on-disk locations the Storage tab lists. Butin-owned: `data` (the active profile's data folder),
// `session` (its Electron browser-session partition), `logs` (~/butin/logs). `install` is where the app
// binary lives. Each is shown with its path and an on-demand computed size.
export type StorageLocationKind = 'data' | 'session' | 'logs' | 'install'

// One resolved storage location: its kind + absolute path. `system` flags a non-Butin-owned folder (the
// install dir) so the UI can group it apart from the Butin-owned folders.
export type StorageLocationDto = { kind: StorageLocationKind; path: string; system: boolean }

// A clearable storage surface. Each maps to one self-contained action the Storage tab spells out:
// `browserSessions` empties the partition (cookies/cache/local storage); `savedLogins` drops the stored
// encrypted session keys; `cachedData` removes every service's fetched reports + downloaded files;
// `logs` deletes the on-disk + in-memory log; `everything` wipes the whole ~/butin tree and restarts.
export type StorageSurface = 'browserSessions' | 'savedLogins' | 'cachedData' | 'logs' | 'everything'

// The full diagnostics snapshot: what loaded (with warnings) + what was skipped + app/runtime versions +
// environment (platform/profile) + resolved on-disk paths + the active capture level.
export type DiagnosticsDto = {
  loaded: PluginDiagnosticDto[]
  failed: PluginLoadFailureDto[]
  appVersion: string
  electronVersion: string
  chromeVersion: string
  nodeVersion: string
  platform: string
  activeProfile: string
  logDir: string
  dataDir: string
  captureLevel: LogLevel
  // How the active profile's stored sessions are protected at rest: sealed by the profile's own vault, by the
  // OS keystore, by a keystore anyone with the file can reverse (`weak`), or not at all (`none`).
  sessionEncryption: 'vault' | 'os' | 'weak' | 'none'
}
