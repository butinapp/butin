// View-model props for the presentational components. The plugin view-model (PluginView · CapabilityView ·
// ConfigFieldView) is defined ONCE in @butinapp/shapes — the neutral package below both core and ui — and
// re-exported here so @butinapp/ui consumers keep one import site. core's IPC DTO (`PluginSummary`) is built
// as `PluginView & { …extras }`, so the app passes its DTOs straight through and an embed feeds the same
// components from a published snapshot. The two outcome shapes below stay here — they're ui-local.

export type { CapabilityView, ConfigFieldView, PluginView } from '@butinapp/shapes'

// The result of a capability load (live or from snapshot).
export type ReportResult = { ok: boolean; data?: unknown; error?: string; lastRunAt?: string }

// The outcome of a connection probe / config test: did it work, and if not, why. Shared by the settings
// form, the service panel's health, and core's per-plugin connection state.
export type VerifyResult = { ok: boolean; error?: string }
