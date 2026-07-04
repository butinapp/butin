import type { ConfigOption } from '@butinapp/sdk'
import type { DailyPoint, Ledger } from '@butinapp/shapes'

import type { DiagnosticsDto, LogEntryDto, StorageLocationDto, StorageLocationKind, StorageSurface } from './ipc/app.js'
import type { ButinPlatform, Result } from './ipc/common.js'
import type { DevCookieDto, DevCookieSelector, DevPartitionDto } from './ipc/dev.js'
import type { ExportOptionsDto, FolderKind, RevealTarget } from './ipc/files.js'
import type { AlertConfigDto, NotificationDto } from './ipc/notifications.js'
import type {
  ConnectionTest,
  ExtractOutcome,
  FolderStatsDto,
  JobOutcome,
  JobProgressDto,
  LocatedFile,
  MagicLoginResult,
  PluginSummary,
  RunJobOptions,
  RunReport,
  ServiceDetailDto
} from './ipc/plugins.js'
import type { ProfileSummaryDto, VaultStateDto } from './ipc/profiles.js'
import type { OverviewTileDto, PeopleDto, StoredReport } from './ipc/reports.js'
import type { AppSettingsDto, FxConfigDto, TablePrefsDto } from './ipc/settings.js'

// The DTOs live in per-domain files under ./ipc/; re-export them all so a consumer keeps importing any DTO
// from this one module (`import type { PluginSummary } from '.../shared/ipc.js'`), while authors edit the
// small domain file that owns it. This module itself stays the contract: the IPC map + the ButinApi surface.
export type * from './ipc/app.js'
export type * from './ipc/common.js'
export type * from './ipc/dev.js'
export type * from './ipc/files.js'
export type * from './ipc/notifications.js'
export type * from './ipc/plugins.js'
export type * from './ipc/profiles.js'
export type * from './ipc/reports.js'
export type * from './ipc/settings.js'

// IPC channel ids, grouped by domain. The two-level shape (domain → method → channel) is the ONE source of
// truth: the preload bridge builds `window.butin.<domain>.<method>` from it, and the main-process registration
// walks it to wire each channel to its handler. Adding a channel means one line here, one method on the matching
// ButinApi domain, and one handler in the owning ipc/ fragment; the preload wiring follows for free. The renderer
// never sees these strings — it calls the typed `window.butin.<domain>.*` methods.
export const IPC = {
  app: {
    diagnostics: 'app:diagnostics',
    getLogs: 'app:logs',
    clearLogs: 'app:logs-clear',
    logClientError: 'app:log-client',
    storageLocations: 'storage:locations',
    folderSize: 'storage:size',
    revealStorage: 'storage:reveal',
    clearStorage: 'storage:clear'
  },
  // Developer-panel cookie inspection (dev-mode surface).
  dev: {
    listPartitions: 'dev:partitions',
    listCookies: 'dev:cookies',
    deleteCookie: 'dev:cookie-delete',
    clearCookieDomain: 'dev:cookie-clear-domain'
  },
  // Operating a connected service: capture/read its session, run a capability, read its config + cached
  // inventory. (Roster membership lives in `lifecycle`; long artifact-producing runs live in `jobs`.)
  services: {
    list: 'plugins:list',
    runCapability: 'plugin:run',
    magicLogin: 'plugin:magic-login',
    browse: 'plugin:browse',
    openNavigationBrowser: 'browser:navigate',
    disconnect: 'plugin:disconnect',
    setConfig: 'plugin:set-config',
    listConfigOptions: 'plugin:config-options',
    getCachedConfigOptions: 'plugin:config-options-cached',
    testConnection: 'plugin:test',
    getServiceDetail: 'service:detail',
    getFolderStats: 'service:folder-stats',
    reportTimes: 'data:report-times',
    clearReports: 'data:clear-reports',
    clearQueryCache: 'cache:clear'
  },
  // Roster membership + onboarding: add/remove a service, enable/disable it, mark it onboarded.
  lifecycle: {
    setEnabled: 'plugin:set-enabled',
    install: 'plugin:install',
    uninstall: 'plugin:uninstall',
    markOnboarded: 'plugin:mark-onboarded'
  },
  // Long, artifact-producing runs that stream progress on the job:progress event channel, plus locating the
  // files a run wrote.
  jobs: {
    locateFiles: 'files:locate',
    runJob: 'job:run',
    runExtractAll: 'extract:run'
  },
  reports: {
    get: 'plugin:report',
    dailySpend: 'plugin:daily-spend',
    rowDailySpend: 'plugin:row-daily-spend',
    ledger: 'plugin:ledger',
    overview: 'plugin:overview',
    people: 'plugin:people'
  },
  files: {
    folderGet: 'folder:get',
    folderPick: 'folder:pick',
    revealFolder: 'folder:reveal',
    openDocument: 'documents:open-file',
    saveFile: 'file:save',
    exportData: 'data:export',
    exportPickPath: 'data:export-pick-path'
  },
  shell: {
    revealPath: 'shell:reveal-path',
    openExternal: 'shell:open-external'
  },
  settings: {
    getTablePrefs: 'table-prefs:get',
    setTablePrefs: 'table-prefs:set',
    get: 'settings:get',
    patch: 'settings:patch',
    getFx: 'fx:get',
    setFx: 'fx:set'
  },
  notifications: {
    list: 'notifications:list',
    markRead: 'notifications:mark-read',
    markAllRead: 'notifications:mark-all-read',
    dismiss: 'notifications:dismiss',
    getAlertConfig: 'alerts:get-config',
    setAlertConfig: 'alerts:set-config'
  },
  chromeSignin: {
    status: 'chrome-signin:status',
    start: 'chrome-signin:start',
    remove: 'chrome-signin:remove'
  },
  profiles: {
    list: 'profiles:list',
    create: 'profiles:create',
    rename: 'profiles:rename',
    recolor: 'profiles:recolor',
    duplicate: 'profiles:duplicate',
    delete: 'profiles:delete',
    switch: 'profiles:switch',
    movePlugin: 'profiles:move-plugin'
  },
  vault: {
    status: 'vault:status',
    setup: 'vault:setup',
    unlock: 'vault:unlock',
    lock: 'vault:lock',
    changePassword: 'vault:change-password',
    resetViaRecovery: 'vault:reset-recovery',
    disable: 'vault:disable'
  },
  window: {
    setTitleBarOverlay: 'window:titlebar-overlay'
  }
} as const

// Main → renderer push channels. These are request/response's counterpart: the generated preload wires them
// with `.on` + an unsubscribe (not `.invoke`), and main `.send`s them. Kept apart from the invoke map so the
// codegen never has to filter events out of it. One channel carries progress for every long-running job
// (download / export / extract-all); the other signals the renderer to re-pull notifications.
export const IPC_EVENT = {
  jobProgress: 'job:progress',
  notificationsChanged: 'notifications:changed'
} as const

// The surface exposed to the renderer via contextBridge as `window.butin`. Grouped by domain, mirroring the
// IPC map: each method maps 1:1 to `IPC.<domain>.<method>` (the preload bridge is generated from that map).
// `platform` + the two `on*` subscriptions are cross-cutting and sit at the top level, off any domain.
export type ButinApi = {
  app: {
    // Full diagnostics snapshot for the Diagnostics page: loaded plugins (+ warnings), skipped plugins
    // (`failed` — feeds the load-failures banner; [] when all loaded), versions.
    diagnostics: () => Promise<DiagnosticsDto>
    // Recent in-memory log lines (newest last) for the Logs view.
    getLogs: () => Promise<LogEntryDto[]>
    // Empty the in-memory log ring (the on-disk daily files are untouched).
    clearLogs: () => Promise<void>
    // Forward a renderer-side uncaught error/rejection into the main log buffer + file, so one panel shows both halves.
    logClientError: (message: string) => Promise<void>
    // The on-disk locations the Storage tab lists (paths only; sizes are fetched per-row via folderSize).
    storageLocations: () => Promise<StorageLocationDto[]>
    // The on-disk footprint of one storage location, by an async walk so the tab never blocks first paint.
    folderSize: (kind: StorageLocationKind) => Promise<number>
    // Open a storage location in the OS file manager (the clickable-path action — one path, opened in place).
    revealStorage: (kind: StorageLocationKind) => Promise<void>
    // Clear one storage surface (see StorageSurface). `everything` wipes the whole ~/butin tree and restarts
    // Butin; the others return after the wipe. Result so a failure surfaces instead of silently no-op'ing.
    clearStorage: (surface: StorageSurface) => Promise<Result<void>>
  }
  // Developer-panel cookie inspection: list the active profile's partitions + their cookies, and delete a
  // cookie or clear a whole domain. Dev-mode surface; values are local-only secrets.
  dev: {
    listPartitions: () => Promise<DevPartitionDto[]>
    listCookies: (partition: string) => Promise<DevCookieDto[]>
    deleteCookie: (partition: string, sel: DevCookieSelector) => Promise<Result<void>>
    clearCookieDomain: (partition: string, domain: string) => Promise<Result<number>>
  }
  // Operating a connected service. (Roster membership → `lifecycle`; long artifact runs → `jobs`.)
  services: {
    list: () => Promise<PluginSummary[]>
    // `force` wipes the capability's accumulated data first, so an incremental capability re-pulls ALL history
    // instead of just the recent window (the per-tab "Refetch all history"). Omit for a normal refresh.
    runCapability: (pluginId: string, capabilityId: string, force?: boolean) => Promise<Result<RunReport>>
    // `backendKey` captures a SECONDARY login (a backend with its own `session`); omit for the primary login.
    magicLogin: (pluginId: string, backendKey?: string) => Promise<MagicLoginResult>
    // Open the service's dashboard inside the captured session to navigate it without re-capturing (browse
    // mode). Resolves like magicLogin but the renderer fires it and ignores the result.
    browse: (pluginId: string) => Promise<MagicLoginResult>
    // Open a plugin-less browser on the shared session partition to navigate any signed-in service without
    // capturing — a developer affordance (dev mode only). Fire-and-forget.
    openNavigationBrowser: () => Promise<void>
    // `backendKey` disconnects only that secondary session (its keyed cookie + its host's partition cookies);
    // omit to disconnect the primary session.
    disconnect: (pluginId: string, backendKey?: string) => Promise<void>
    setConfig: (pluginId: string, values: Record<string, string>) => Promise<void>
    // Fetch a `combobox` field's choices through the plugin's authed client (e.g. the orgs you belong to).
    // Requires a live session; a throw/expired session comes back as { ok:false }. The result is PERSISTED to
    // disk; the renderer only calls this when no cache exists (or on an explicit refresh) and when connected.
    listConfigOptions: (pluginId: string, fieldKey: string) => Promise<Result<ConfigOption[]>>
    // The disk-cached options for a combobox field (no network) — what the picker seeds from on startup.
    // null when never fetched.
    getCachedConfigOptions: (pluginId: string, fieldKey: string) => Promise<ConfigOption[] | null>
    // `backendKey` tests a secondary backend's own login (its `probe`); omit to test the primary session.
    testConnection: (pluginId: string, backendKey?: string) => Promise<ConnectionTest>
    // The reshaped Settings tab's info payload (mechanics + data inventory + rollups). Reads cached data +
    // the descriptor only — never runs a collector.
    getServiceDetail: (pluginId: string) => Promise<ServiceDetailDto>
    // On-disk footprint of the service folder, computed by an async walk so it never blocks first paint.
    getFolderStats: (pluginId: string) => Promise<FolderStatsDto>
    // Last-run timestamp per cached capability report (capability id → ISO string).
    reportTimes: (pluginId: string) => Promise<Record<string, string>>
    // Erase a service's cached tab data (reports + manifests); keeps the stored session + downloaded files.
    clearReports: (pluginId: string) => Promise<void>
    // Drop a plugin's in-memory query cache so the next refresh fetches fresh. Called by the renderer at refresh
    // boundaries (Refresh-All / single-tab Refresh) and implicitly on disconnect/uninstall.
    clearQueryCache: (pluginId: string) => Promise<void>
  }
  // Roster membership + onboarding.
  lifecycle: {
    setEnabled: (pluginId: string, enabled: boolean) => Promise<void>
    // Add a plugin to the roster (Available → Installed). Sets installed + enabled; the renderer then navigates
    // to the service page's onboarding flow.
    install: (pluginId: string) => Promise<void>
    // Remove a plugin from the roster: wipes its stored session + config + cached reports, clears installed/enabled/
    // onboardedAt. Downloaded files under ~/butin/<id>/ are kept unless `eraseFolder` is set, which removes the
    // whole service data folder too.
    uninstall: (pluginId: string, eraseFolder?: boolean) => Promise<void>
    // Stamp onboardedAt with the current timestamp — called by the service page when the first onboarding refresh succeeds, flipping
    // the page out of onboarding mode into the normal tabbed view.
    markOnboarded: (pluginId: string) => Promise<void>
  }
  // Long, artifact-producing runs (stream progress on `onJobProgress`) + locating the files they wrote.
  jobs: {
    // id → on-disk path + size for a collect capability's downloadable-table files already fetched. Drives
    // the per-row Open action + the Size cell.
    locateFiles: (pluginId: string, capabilityId: string) => Promise<Record<string, LocatedFile>>
    // Run an artifact-producing capability (documents download or export). Dispatches by capability kind in
    // main; streams ticks on the job:progress channel; resolves with the outcome.
    runJob: (pluginId: string, capabilityId: string, opts?: RunJobOptions) => Promise<Result<JobOutcome>>
    // Run every capability for a plugin into one folder (the "Save everything" action). Streams job:progress.
    runExtractAll: (pluginId: string) => Promise<Result<ExtractOutcome>>
  }
  reports: {
    get: (pluginId: string, capabilityId: string) => Promise<StoredReport>
    // Per-day spend for a capability, derived from its ledger's spend series (oldest → newest). [] when the
    // capability has no spend series (non-monetary). Feeds the service page's spend chart Daily mode.
    dailySpend: (pluginId: string, capabilityId: string) => Promise<DailyPoint[]>
    // Per-row, per-day series for a keyed table's cumulative column (an MTD-per-member counter), derived from
    // the capability's ledger row-version history: row id (the dataset key's value) → that row's daily breakdown,
    // oldest → newest. {} when nothing is recorded. Feeds the table view's per-row trend sparkline.
    rowDailySpend: (
      pluginId: string,
      capabilityId: string,
      datasetId: string,
      columnKey: string
    ) => Promise<Record<string, DailyPoint[]>>
    // The raw on-disk ledger for a capability — the append-only daily-change history (row versions + section
    // series) the derived series/sparklines are computed from. Drives the Settings tab's dev-mode debug panel.
    // null when nothing is recorded yet.
    ledger: (pluginId: string, capabilityId: string) => Promise<Ledger | null>
    overview: () => Promise<OverviewTileDto[]>
    // The cross-service People rollup: every cached members roster merged by email into one renderable
    // result. Reads cached reports only. null when no service has members data yet.
    people: () => Promise<PeopleDto>
  }
  files: {
    // Resolve / pick / reveal one of a service's local folders. `folderPick` only targets the documents folder.
    folderGet: (pluginId: string, kind: FolderKind) => Promise<string>
    folderPick: (pluginId: string) => Promise<string | null>
    // Open a folder in the OS file manager: a plugin-scoped service folder (pass pluginId) or an app-level
    // folder ('logs' / 'data', pluginId omitted). One channel for logs + data dir + every service folder.
    revealFolder: (kind: RevealTarget, pluginId?: string) => Promise<void>
    // Open a downloaded document in its OS default application.
    openDocument: (path: string) => Promise<void>
    saveFile: (suggestedName: string, contents: string) => Promise<Result<{ path?: string; canceled?: boolean }>>
    // Export the active profile's cached data as one portable viewer bundle to a user-reachable path (Downloads
    // by default). Offline — no collector runs. `encrypt` (only on an unlocked encrypted profile) vault-seals the
    // file (suffixing .btnv); `serviceIds` narrows to a subset; `destPath` overrides the default location.
    exportData: (opts: ExportOptionsDto) => Promise<Result<{ path: string }>>
    // Open a native save dialog seeded with the default export path; resolves the chosen path, or null on cancel.
    exportPickPath: () => Promise<string | null>
  }
  // OS-shell integration on non-file targets — hand the OS a path to highlight or a URL to open.
  shell: {
    // Reveal a written file in the OS file manager (highlights it). For the export "Reveal in folder" action.
    revealPath: (path: string) => Promise<void>
    // Open a URL (e.g. a service's dashboard) in the user's default browser, never inside the app window.
    openExternal: (url: string) => Promise<void>
  }
  settings: {
    getTablePrefs: (key: string) => Promise<TablePrefsDto | undefined>
    setTablePrefs: (key: string, prefs: TablePrefsDto) => Promise<void>
    get: () => Promise<AppSettingsDto>
    // Patch any subset of app settings in one channel — manual-capture, format prefs (currency/date/tz), and
    // log retention all flow through here, so a new setting is a new DTO field, never a new channel. Retention
    // changes prune immediately. Renderer invalidates ['settings'] after.
    patch: (patch: Partial<AppSettingsDto>) => Promise<void>
    // The currency settings + FX-rate table that drive the Overview's base-currency rollup. Defaults to a USD
    // base with no rates (single-currency users never touch it).
    getFx: () => Promise<FxConfigDto>
    setFx: (cfg: FxConfigDto) => Promise<void>
  }
  notifications: {
    // The notification list + the configurable alert thresholds/health toggles. The mutators return the new
    // list so the renderer can update without a round-trip; `onNotificationsChanged` fires after a refresh
    // re-evaluates alerts so the bell stays live.
    list: () => Promise<NotificationDto[]>
    markRead: (id: string) => Promise<NotificationDto[]>
    markAllRead: () => Promise<NotificationDto[]>
    dismiss: (id: string) => Promise<NotificationDto[]>
    getAlertConfig: () => Promise<AlertConfigDto>
    setAlertConfig: (cfg: AlertConfigDto) => Promise<void>
  }
  chromeSignin: {
    // Whether a real-Chrome sign-in profile exists for the active Butin profile, plus its on-disk location.
    status: () => Promise<{ hasSession: boolean; path: string }>
    // Open real Chrome at `url` (a Google sign-in by default) for a hand login; on close, gather the cookie jar
    // into the active partition so embedded sign-in can ride it. Resolves after the gather with the synced count.
    start: (url: string) => Promise<{ ok: boolean; error?: string; syncedCount?: number }>
    // Delete the active profile's Chrome sign-in profile (forget the seeded browser session + its cookies).
    remove: () => Promise<void>
  }
  profiles: {
    // List all profiles (active flag resolved). The top-bar switcher seeds from this.
    list: () => Promise<ProfileSummaryDto[]>
    // Create a profile (slugged id from the name); returns the updated list.
    create: (name: string) => Promise<ProfileSummaryDto[]>
    // Rename a profile in place (folder unchanged); returns the updated list.
    rename: (id: string, name: string) => Promise<ProfileSummaryDto[]>
    // Set a profile's color; returns the updated list.
    recolor: (id: string, color: string) => Promise<ProfileSummaryDto[]>
    // Clone a profile (session + config + cached data) into a new inactive one; returns the updated list. Fallible
    // (refuses a locked source — no DEK to read under), so it returns a Result. A clone of an encrypted source is
    // plaintext.
    duplicate: (id: string) => Promise<Result<ProfileSummaryDto[]>>
    // Delete a profile + its data folder; refuses the last one; returns the updated list.
    delete: (id: string) => Promise<ProfileSummaryDto[]>
    // Switch the active profile: repoints roots/partition + reloads the renderer. Returns nothing (reload follows).
    switch: (id: string) => Promise<void>
    // Move a plugin's stored state (stored session + config + cached data) from the ACTIVE profile to another. Fallible
    // (refuses a same/unknown/already-connected target, or an empty source), so it returns a Result.
    movePlugin: (pluginId: string, toProfileId: string) => Promise<Result<void>>
  }
  // Per-profile at-rest encryption.
  vault: {
    // The encryption state of a profile (active or not), for the lock gate + the switcher badge.
    status: (profileId: string) => Promise<VaultStateDto>
    // Enable encryption on a profile: set a master password, then migrate its tree to ciphertext in place.
    // Returns the printable recovery key to show the user ONCE. Fallible (migration can hit a locked file / IO).
    setup: (profileId: string, password: string) => Promise<Result<{ recoveryCode: string }>>
    // Unlock a profile with its password OR recovery key (registers the DEK in memory). false on a wrong secret.
    unlock: (profileId: string, secret: string) => Promise<boolean>
    // Zero + drop a profile's in-memory key (manual lock).
    lock: (profileId: string) => Promise<void>
    // Re-wrap the password slot under a new password, proving the old secret first. false on a wrong old secret.
    changePassword: (profileId: string, oldSecret: string, newPassword: string) => Promise<boolean>
    // Forgotten-password path: prove the recovery key, set a new password, leave the profile unlocked. false on
    // a wrong recovery key.
    resetViaRecovery: (profileId: string, recoveryCode: string, newPassword: string) => Promise<boolean>
    // Disable encryption: decrypt the tree back to plaintext and remove the vault. Requires it be unlocked AND
    // the password (or recovery key) re-entered — turning off encryption is destructive, so it isn't a one-click
    // action just because the machine is currently unlocked. false-equivalent (wrong secret) comes back as a
    // failed Result.
    disable: (profileId: string, secret: string) => Promise<Result<void>>
  }
  window: {
    // Re-tint the native window-controls overlay to match the current theme. The renderer resolves the header's
    // `bg-card` + muted-foreground to rgb and calls this on every light/dark switch (Windows/Linux only; a no-op
    // elsewhere). Colors are CSS color strings.
    setTitleBarOverlay: (colors: { color: string; symbolColor: string }) => Promise<void>
  }

  // Cross-cutting, off any domain. `platform` is read synchronously at first paint (set in preload, not a
  // channel); the two subscriptions wire a main→renderer push channel with an unsubscribe.
  platform: ButinPlatform
  onJobProgress: (cb: (p: JobProgressDto) => void) => () => void
  // Fires (no payload) when a refresh re-evaluates alerts; the renderer invalidates its notifications query.
  onNotificationsChanged: (cb: () => void) => () => void
}
