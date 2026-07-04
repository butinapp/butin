import type { LogLevel } from './app.js'

// App-level settings exposed to the renderer.
export type AppSettingsDto = {
  manualCapture: boolean
  // Throttle outbound provider requests with a jittered 100–500ms gap so the tool stays a gentle client.
  // Default true.
  paceRequests: boolean
  // Page the app opens on launch: the Overview, or the last route the renderer was on. Default 'overview'.
  startPage: 'overview' | 'last'
  // Minutes of OS idle before unlocked encrypted profiles auto-lock; 0 disables idle locking. Default 15.
  idleLockMinutes: number
  // Lock encrypted profiles on machine sleep. Default true.
  lockOnSleep: boolean
  // Seconds a fetched response is reused by the per-plugin read cache (spans a refresh-all batch). Default 30.
  cacheWindowSeconds: number
  currencyStyle: 'match' | 'us' | 'fr' | 'eu'
  dateFormat: 'locale' | 'iso' | 'us' | 'eu'
  // Days of daily log files to keep before pruning (0 = forever). Default 7.
  logRetentionDays: number
  // Global minimum log level — below-threshold lines are never emitted (no ring, no file, no console).
  // Default 'info'. Per-target overrides (keyed by plugin id or scope tag) let one noisy source go to debug
  // without flooding the rest.
  logLevel: LogLevel
  logLevelOverrides: Record<string, LogLevel>
  // Surface debug tooling (the raw daily-change ledger in each service's Settings tab). Default false.
  devMode: boolean
}

// The user's currency settings: the currency the Overview rolls up into + the manual/fetched rate table
// (`rates[c]` = value in baseCurrency of 1 unit of c). `source`/`fetchedAt` record where the table came from.
export type FxConfigDto = {
  baseCurrency: string
  rates: Record<string, number>
  source?: string
  fetchedAt?: string
}

// A column sort: which column, ascending or descending.
export type TableSortDto = { key: string; dir: 'asc' | 'desc' }

// Persisted per-capability table state, structurally matching @butinapp/ui's DataTableState but declared here
// so shared/ has no UI dependency. Returned by getTablePrefs, accepted by setTablePrefs.
export type TablePrefsDto = {
  sort?: TableSortDto
  columnOrder?: string[]
  columnVisibility?: Record<string, boolean>
  pageSize?: number
}
