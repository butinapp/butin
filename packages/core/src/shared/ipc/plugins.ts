import type { AuthKind } from '@butinapp/sdk'
import type { PluginView } from '@butinapp/shapes'

import type { FailureActionDto, FailureCauseDto } from './common.js'

// An additional, independently-captured login a plugin needs (a backend on a different host that requires its
// own Magic Login on the shared partition). `key` is the backend key passed to magicLogin/disconnect; `label`
// names the connect button + row; `connected` is whether its session is captured. Absent/[] for the common
// single-login plugin.
export type SecondarySessionDto = { key: string; label: string; connected: boolean }

// What the renderer needs about a plugin: the shared PluginView (from @butinapp/shapes — the same shape
// @butinapp/ui draws and an embed feeds from a snapshot) plus the app-only fields that don't belong in a
// portable view-model. Built as `PluginView & { … }` so the DTO and the view-model can't drift — a
// PluginSummary IS a PluginView, which is why the renderer passes one straight into the ui components.
export type PluginSummary = PluginView & {
  // Per-plugin translations for the domain strings this plugin emits (meta.messages), merged over the app's
  // global dict at render time so its tabs/labels follow the app language. Keyed by locale → (string → translation).
  messages?: Record<string, Record<string, string>>
  // Whether the plugin is enabled (shown in sidebar/overview). Defaults true; toggled on Data status.
  enabled: boolean
  // Whether the plugin is in the user's roster (Available vs Installed). The sidebar + Installed tab show
  // installed plugins; Available lists the rest. Defaults via migration (see deriveInstalled).
  installed: boolean
  // Additional logins this plugin needs beyond the primary session (a backend with its own `session`). The
  // Settings tab renders a connect/disconnect row per entry. Absent/[] for the common single-login plugin.
  secondarySessions?: SecondarySessionDto[]
  // Newest report time across the plugin's capabilities (ISO-8601), or absent if nothing is cached. Drives the
  // Management card's last-refreshed label and the "Needs refresh" filter.
  lastRunAt?: string
}

// `canceled` marks the benign case: the login window was closed before any session was captured (the user
// backed out), so the renderer shows a neutral note rather than an error toast.
export type MagicLoginResult = { ok: boolean; error?: string; warning?: string; canceled?: boolean }

// `authFailed` marks the failure as a dead session (an auth-rejection status in the plugin's
// clearOnStatuses) vs. a non-auth miss (404/500/network) where the session was accepted but the probe
// couldn't complete — only the former should drop the user back to Sign in. `status` is the HTTP status the
// probe got, when there was one; `cause`/`actions` are the classified failure (same set the per-capability
// run returns) so the UI can render structured guidance from a failed probe.
export type ConnectionTest = {
  ok: boolean
  error?: string
  checkedAt: string
  status?: number
  authFailed?: boolean
  cause?: FailureCauseDto
  actions?: FailureActionDto[]
}

// A capability run's report payload (the stored data + when it was fetched), wrapped in Result by runCapability.
export type RunReport = { report: unknown; lastRunAt?: string }

// One downloadable-table file already on disk: absolute path + size (for the per-row Open action + size cell).
export type LocatedFile = { path: string; sizeBytes: number }

// One progress tick for any long-running job, streamed on the single `job:progress` channel. Downloads use
// `docId` + `state` (per file); export / extract-all use `phase` (a step label). The renderer filters by
// pluginId (+ capabilityId) and reads whichever fields its panel needs.
export type JobProgressDto = {
  pluginId: string
  capabilityId?: string
  phase?: string
  docId?: string
  state?: 'queued' | 'downloading' | 'done' | 'skipped' | 'error'
  // On a 'done' tick the file's on-disk location, so the renderer can show its Open action + size the instant
  // it lands — without waiting for the end-of-batch locateFiles refetch.
  path?: string
  sizeBytes?: number
  message?: string
  completed?: number
  total?: number
}

// runJob options. `selection` picks which downloadable-table rows to fetch; `force` re-fetches files
// already on disk. Ignored for export capabilities.
export type RunJobOptions = { selection?: string[] | 'all'; force?: boolean }

// runJob outcome — a discriminated union over the two artifact-producing job shapes: a downloadable-table
// file download (`files`) or a bespoke `export` run. The calling panel knows its shape and narrows.
export type DownloadOutcome = {
  kind: 'files'
  total: number
  done: number
  skipped: number
  errors: { docId: string; error: string }[]
}

export type JobOutcome = DownloadOutcome

// runExtractAll outcome (a plugin-level "run everything → folder" meta-job; reuses the job:progress channel).
export type ExtractOutcome = {
  outDir: string
  capabilities: { id: string; ok: boolean; note?: string }[]
  tabCount: number
  fileCount: number
  warnings: string[]
}

// How Butin reads a service, derived from the plugin descriptor for the Settings tab's "Under the hood"
// section: the auth kind + a plain-language sentence, the transport, and the session's surface (cookie
// domains / login URL). All read-only — purely informational.
export type ServiceMechanicsDto = {
  authKind: AuthKind
  // A plain sentence explaining how the session is read (kind → copy), so the section reads to a non-expert.
  authSummary: string
  transportEngine: 'node' | 'electron'
  requiresBrowserEngine: boolean
  cookieDomains: string[]
  loginUrl?: string
  requiredCookie?: string
  category?: string
  homepage?: string
  version?: string
}

// One row of the Settings tab's data inventory: a capability + how much it holds, when it last ran, and its
// capture-history depth (the count of points in its primary ledger series → 0 for a capability with none).
export type ServiceCapabilityDetailDto = {
  id: string
  label: string
  recordCount: number
  lastRunAt?: string
  snapshotCount: number
  // Captured headline values oldest→newest for the inventory trend sparkline; absent when nothing is captured.
  spark?: number[]
}

// Everything the reshaped Settings tab needs that isn't on PluginSummary: the read mechanics, the
// per-capability data inventory, the rolled-up record total + freshness, and the primary headline metric.
// Built from cached reports + the descriptor — runs no collector, so it can't fail on the network.
export type ServiceDetailDto = {
  mechanics: ServiceMechanicsDto
  capabilities: ServiceCapabilityDetailDto[]
  // Σ records across every cached capability (the "Records cached" stat).
  recordCount: number
  // Newest lastRunAt across capabilities (the "Last synced" stat).
  lastRunAt?: string
}

// On-disk footprint of a service's folder — file count + total bytes. Computed by an async walk, so the
// Settings tab paints first and fills these two tiles in after.
// `documentCount` is the subset of files that survive a normal erase/uninstall (the downloaded documents
// under the service's documents folder) — so the UI can tell the user those are kept.
export type FolderStatsDto = { fileCount: number; totalBytes: number; documentCount: number }
