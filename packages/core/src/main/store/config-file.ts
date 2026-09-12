import { renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { LogLevel, TableSortDto } from '../../shared/ipc.js'
import { log } from '../log.js'
import { vaultExists } from '../vault/vault.js'

import { readBytesSync, writeJsonSync } from './secure-fs.js'

// safeStorage exists only in the Electron main process. Off-Electron (tests, `serve`) we store
// plaintext. Shared by the credential store and the
// per-plugin config store so there's one config.json reader/writer and one crypto path.
type SafeStorage = {
  isEncryptionAvailable: () => boolean
  encryptString: (s: string) => Buffer
  decryptString: (b: Buffer) => string
  // Linux only: the keyring safeStorage bound to. `basic_text` is an obfuscation with a hardcoded key, which
  // isEncryptionAvailable still reports as available.
  getSelectedStorageBackend?: () => string
}

let safeStorage: SafeStorage | null = null

try {
  const electron = (await import('electron')) as unknown as { safeStorage?: SafeStorage }

  safeStorage = electron.safeStorage ?? null
} catch {
  safeStorage = null
}

// How a secret written outside an encrypted profile is protected at rest: by the OS keystore, by a keystore
// that is reversible by anyone with the file (`weak`), or not at all (no keyring, or off-Electron).
export type SessionEncryption = 'os' | 'weak' | 'none'

export const sessionEncryption = (): SessionEncryption => {
  if (!safeStorage?.isEncryptionAvailable()) {
    return 'none'
  }

  return safeStorage.getSelectedStorageBackend?.() === 'basic_text' ? 'weak' : 'os'
}

let warnedPlaintext = false

let configRoot = join(homedir(), 'butin')

// Test seam — point the store at a temp dir.
export const setConfigRoot = (dir: string): void => {
  configRoot = dir
}

export type PluginEntry = Record<string, unknown>

// Persisted per-capability table prefs, keyed `<pluginId>.<capabilityId>`. A plain setting (not a
// credential), stored unencrypted alongside the plugin entries.
export type TablePrefsEntry = {
  sort?: TableSortDto
  columnOrder?: string[]
  columnVisibility?: Record<string, boolean>
  pageSize?: number
}
// App-level (non-plugin) settings, stored at the top of config.json. `manualCapture` makes Magic Login
// wait for an explicit Capture click instead of auto-capturing the moment the criteria are met.
export type CurrencyStyle = 'match' | 'us' | 'fr' | 'eu'
export type DateFormatPreset = 'locale' | 'iso' | 'us' | 'eu'
// Which page the app opens on launch: the Overview, or wherever you last were (the renderer remembers the
// last route and restores it).
export type StartPage = 'overview' | 'last'

export type FormatPrefs = { currencyStyle: CurrencyStyle; dateFormat: DateFormatPreset }

// Remembered UI state of the Magic Login window, restored on the next open (global — last-used wins across
// every service). `bounds` is the un-maximized rectangle (so un-maximizing later lands sanely); the four
// flags mirror what was last on when the window closed: DevTools open, the Debug panel expanded, and the
// user-driven Freeze redirects / Auto-pause toggles (programmatic freeze flips are not remembered).
export type MagicLoginUiState = {
  bounds?: { x: number; y: number; width: number; height: number }
  maximized?: boolean
  devToolsOpen?: boolean
  debugExpanded?: boolean
  freeze?: boolean
  autoPause?: boolean
}

export type AppSettings = {
  manualCapture?: boolean
  magicLogin?: MagicLoginUiState
  paceRequests?: boolean
  logRetentionDays?: number
  logLevel?: LogLevel
  logLevelOverrides?: Record<string, LogLevel>
  startPage?: StartPage
  // Minutes of OS idle before encrypted profiles auto-lock; 0 disables idle locking.
  idleLockMinutes?: number
  // Lock encrypted profiles when the machine sleeps.
  lockOnSleep?: boolean
  // Seconds a fetched response is reused before a refetch — the per-plugin read cache that spans a refresh-all batch.
  cacheWindowSeconds?: number
  // Surface debug tooling (the raw ledger view in a service's Settings tab).
  devMode?: boolean
  // Let the Overview fill a missing or stale exchange rate from a public rate API. Off by default: a request the
  // app makes on its own has to be asked for.
  fetchExchangeRates?: boolean
  // Ask GitHub for a newer release once per launch. On by default — the one self-initiated request that is
  // opt-out rather than opt-in, disclosed in Settings.
  autoUpdate?: boolean
} & Partial<FormatPrefs>

export type Config = {
  plugins: Record<string, PluginEntry>
  tablePrefs?: Record<string, TablePrefsEntry>
  settings?: AppSettings
}

// Read the config.json in a SPECIFIC profile dir (not necessarily the active one). The profile-transfer
// path needs to touch two profiles' files by absolute path; the active-profile readers below delegate here.
// Reads flow through secure-fs, so an encrypted profile is transparent: an UNLOCKED vault decrypts; a LOCKED
// one yields the empty default (the lock gate re-prompts before any real read); an OFF profile is plaintext.
export const readConfigAt = (dir: string): Config => {
  const path = join(dir, 'config.json')

  let raw: Buffer | null

  // A genuinely-absent file (null) is the first-run case — empty default, silent. A locked vault also yields
  // null and must NOT be treated as corruption. But bytes that won't decrypt OR won't parse ARE corruption:
  // returning empty would let the next write overwrite them, destroying every stored session. Side-step the
  // file (config.json.corrupt-<ts>) so it's recoverable and the overwrite lands on a clean slate.
  try {
    raw = readBytesSync(dir, path)
  } catch (err) {
    return backupCorruptConfig(path, err)
  }

  if (raw === null) {
    return { plugins: {} }
  }

  try {
    return JSON.parse(raw.toString('utf8')) as Config
  } catch (err) {
    return backupCorruptConfig(path, err)
  }
}

const backupCorruptConfig = (path: string, err: unknown): Config => {
  const backup = `${path}.corrupt-${Date.now()}`

  try {
    renameSync(path, backup)
    log.error('config', `config.json unreadable — moved to ${backup} (data preserved)`, err)
  } catch (moveErr) {
    log.error('config', 'config.json unreadable AND could not be backed up', moveErr)
  }

  return { plugins: {} }
}

// Writes flow through secure-fs: an UNLOCKED vault seals the whole file, an OFF profile writes plaintext, a
// LOCKED vault throws (the store layer never writes a locked profile).
export const writeConfigAt = (dir: string, config: Config): void => writeJsonSync(dir, join(dir, 'config.json'), config)

export const readConfig = (): Config => readConfigAt(configRoot)

export const writeConfig = (config: Config): void => writeConfigAt(configRoot, config)

// Read-modify-write one plugin's entry, creating it ({}) when absent. Centralizes the
// readConfig → mutate → writeConfig idiom for every per-plugin setter.
export const updatePluginEntry = (pluginId: string, mutate: (entry: PluginEntry) => void): void => {
  const config = readConfig()
  const entry = config.plugins[pluginId] ?? {}

  mutate(entry)
  config.plugins[pluginId] = entry
  writeConfig(config)
}

export const isSecretField = (field: string): boolean => /cookie|token|key|jwt/i.test(field)

// Encrypt a secret for a GIVEN profile dir. A profile import re-keys into a tree that is not the active one,
// so the vault check has to follow the target dir rather than the ambient config root.
export const encryptValueFor = (dir: string, value: string): { stored: string; enc: boolean } => {
  // Inside an encrypted profile the whole config.json is sealed by the DEK, so per-field safeStorage
  // encryption is redundant AND harmful — it would re-pin the secret to the OS user, breaking the
  // portability the vault provides. Store the field in the clear and let the file's envelope protect it.
  if (vaultExists(dir)) {
    return { stored: value, enc: false }
  }

  if (safeStorage && sessionEncryption() === 'os') {
    return { stored: safeStorage.encryptString(value).toString('base64'), enc: true }
  }

  if (safeStorage && !warnedPlaintext) {
    warnedPlaintext = true
    log.warn(
      'config',
      `no OS keystore protects stored sessions (${sessionEncryption()}) — secrets are written in the clear; encrypt the profile to seal them`
    )
  }

  return { stored: value, enc: false }
}

export const encryptValue = (value: string): { stored: string; enc: boolean } => encryptValueFor(configRoot, value)

export const decryptValue = (stored: string, enc: boolean): string | undefined => {
  if (!enc) {
    return stored
  }

  // Ciphertext with no keystore to open it is not a value; returning it would replay base64 as a cookie.
  if (!safeStorage?.isEncryptionAvailable()) {
    log.warn('config', 'a stored secret is encrypted but no OS keystore is available — treating it as absent')

    return undefined
  }

  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'))
  } catch (err) {
    // An undecryptable secret — a corrupt store, a rotated OS key, or a config.json copied between machines
    // or OS users (e.g. via a synced folder) — is unusable. Treat it as ABSENT instead of letting the throw
    // propagate: listPlugins/overview build their summaries by reading every plugin's credential, so a single
    // bad value would otherwise blank the entire portal.
    log.warn('config', 'failed to decrypt a stored secret — treating it as absent', err)

    return undefined
  }
}

// Per-plugin enable flag. Defaults to false — a fresh plugin is OFF until you actively enable it on the
// Data status page (so adding a plugin doesn't silently start fetching). Stored alongside the plugin's
// other config in config.json — it's a setting, not a credential, so no encryption.
export const getPluginEnabled = (pluginId: string): boolean => readConfig().plugins[pluginId]?.enabled === true

export const setPluginEnabled = (pluginId: string, enabled: boolean): void => {
  updatePluginEntry(pluginId, (entry) => {
    entry.enabled = enabled
  })
}

// `installed` is the explicit roster flag (Available vs Installed). When it's absent on an entry, derive it
// from a real footprint — an enabled plugin, a stored credential, or non-empty config. An empty/untouched
// entry is not-installed.
export const deriveInstalled = (entry: PluginEntry | undefined): boolean => {
  if (entry === undefined) {
    return false
  }

  if (typeof entry.installed === 'boolean') {
    return entry.installed
  }

  const hasCreds = Object.keys(entry).some((k) => isSecretField(k) && typeof entry[k] === 'string')
  const config = entry.config
  const hasConfig = typeof config === 'object' && config !== null && Object.keys(config).length > 0

  return entry.enabled === true || hasCreds || hasConfig
}

export const getPluginInstalled = (pluginId: string): boolean => deriveInstalled(readConfig().plugins[pluginId])

export const setPluginInstalled = (pluginId: string, installed: boolean): void => {
  updatePluginEntry(pluginId, (entry) => {
    entry.installed = installed
  })
}

// Epoch-ms timestamp set when a plugin's first refresh succeeds — drives onboarding-mode (installed but not
// yet onboarded). Undefined until then.
export const getPluginOnboardedAt = (pluginId: string): number | undefined => {
  const v = readConfig().plugins[pluginId]?.onboardedAt

  return typeof v === 'number' ? v : undefined
}

export const setPluginOnboardedAt = (pluginId: string, at: number): void => {
  updatePluginEntry(pluginId, (entry) => {
    entry.onboardedAt = at
  })
}

// How many days of daily log files to keep before pruning. 0 = in-memory only: the live ring buffer is the
// log, nothing is written to disk. A positive value opts into daily files pruned past that window.
export const DEFAULT_LOG_RETENTION_DAYS = 0

// The global minimum log level. Debug is off until you ask for it, so normal runs aren't flooded.
export const DEFAULT_LOG_LEVEL: LogLevel = 'info'

// Minutes of OS idle before an unlocked encrypted profile auto-locks. Long enough to step away briefly,
// short enough that a walked-away-from machine doesn't stay readable. 0 = never idle-lock.
export const DEFAULT_IDLE_LOCK_MINUTES = 15

// Seconds a fetched response stays reusable in the per-plugin read cache, measured from completion.
export const DEFAULT_CACHE_WINDOW_SECONDS = 30

// The defaulted value of every scalar app setting. A key absent from config.json reads as the value here;
// `getSetting`/`setSetting` are typed against this map, so adding a scalar setting is one entry + one
// `AppSettings` field — no new accessor pair. Defaults are nullish-coalesced, so a stored `false`/`0` wins.
//   paceRequests   — pace outbound requests (jittered 100–500ms host gaps); on by default, only explicit false disables.
//   manualCapture  — Magic Login waits for an explicit Capture click instead of auto-capturing when criteria are met.
const SETTING_DEFAULTS = {
  paceRequests: true,
  manualCapture: false,
  logRetentionDays: DEFAULT_LOG_RETENTION_DAYS,
  logLevel: DEFAULT_LOG_LEVEL,
  startPage: 'overview',
  idleLockMinutes: DEFAULT_IDLE_LOCK_MINUTES,
  lockOnSleep: true,
  cacheWindowSeconds: DEFAULT_CACHE_WINDOW_SECONDS,
  devMode: false,
  fetchExchangeRates: false,
  autoUpdate: true
} satisfies Partial<AppSettings>

type ScalarSetting = keyof typeof SETTING_DEFAULTS

// Read-modify-write the top-level settings block; the partial merges so a single field never clobbers its
// siblings. Every app-setting writer routes through here.
const updateSettings = (patch: Partial<AppSettings>): void => {
  const config = readConfig()

  config.settings = { ...(config.settings ?? {}), ...patch }
  writeConfig(config)
}

export const getSetting = <K extends ScalarSetting>(key: K): (typeof SETTING_DEFAULTS)[K] =>
  (readConfig().settings?.[key] as (typeof SETTING_DEFAULTS)[K] | undefined) ?? SETTING_DEFAULTS[key]

export const setSetting = <K extends keyof AppSettings>(key: K, value: AppSettings[K]): void =>
  updateSettings({ [key]: value } as Partial<AppSettings>)

// Magic Login's remembered window state. Empty on a first-ever open (built-in geometry + all-off toggles);
// `patch` merges so a single field update (e.g. just the freeze toggle) never clobbers the others.
export const getMagicLoginUiState = (): MagicLoginUiState => readConfig().settings?.magicLogin ?? {}

export const patchMagicLoginUiState = (patch: Partial<MagicLoginUiState>): void =>
  updateSettings({ magicLogin: { ...(readConfig().settings?.magicLogin ?? {}), ...patch } })

// Per-target level overrides, keyed by plugin id or scope tag. A target with no entry follows the global
// level. Setting an entry to undefined removes it (back to following the global).
export const getLogLevelOverrides = (): Record<string, LogLevel> => readConfig().settings?.logLevelOverrides ?? {}

export const setLogLevelOverride = (target: string, level: LogLevel | undefined): void => {
  const overrides = { ...(readConfig().settings?.logLevelOverrides ?? {}) }

  if (level === undefined) {
    delete overrides[target]
  } else {
    overrides[target] = level
  }

  updateSettings({ logLevelOverrides: overrides })
}

// Display-format prefs (top-level). Defaults: match-app currency, locale date. Dates render in the local zone.
export const getFormatPrefs = (): FormatPrefs => {
  const s = readConfig().settings ?? {}

  return { currencyStyle: s.currencyStyle ?? 'match', dateFormat: s.dateFormat ?? 'locale' }
}

export const setFormatPrefs = (prefs: Partial<FormatPrefs>): void => updateSettings(prefs)

export const getTablePrefs = (key: string): TablePrefsEntry | undefined => readConfig().tablePrefs?.[key]

export const setTablePrefs = (key: string, prefs: TablePrefsEntry): void => {
  const config = readConfig()

  config.tablePrefs = { ...(config.tablePrefs ?? {}), [key]: prefs }
  writeConfig(config)
}
