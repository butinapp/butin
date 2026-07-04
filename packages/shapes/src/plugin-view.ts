// The plugin view-model the renderer draws — the ONE definition core's IPC DTO and @butinapp/ui both build
// on, so they can't drift. Lives here (the neutral host-shapes package, below both core and ui) rather than
// in either consumer: core's `PluginSummary` is `PluginView & { …transport-only extras }` and @butinapp/ui
// re-exports these for embedders, so an embed feeds the same components from a published snapshot and the
// Electron app from live IPC. No Electron, no React, no IPC — types only. The config-field shapes reuse the
// SDK's `ConfigFieldCondition` so the settings form and the SDK agree by construction.

import type { ConfigFieldCondition } from '@butinapp/sdk'

// One capability in the renderer's tab list. Every capability is one data-view shape — "Save everything"
// serializes them all core-side, with no per-capability variant. `incremental` is true when the capability
// fetches incrementally (keeps a kept history), so the tab offers a "Refetch all history" action.
export type CapabilityView = { id: string; label: string; incremental?: boolean }

// A config field as it crosses to the renderer: the SDK's `ConfigField` minus the runtime-only `loadOptions`
// resolver (a function can't cross IPC). The settings form renders exactly these fields.
export type ConfigFieldView = {
  key: string
  label: string
  kind: 'text' | 'secret' | 'select' | 'combobox'
  required?: boolean
  placeholder?: string
  help?: string
  options?: Array<{ value: string; label: string }>
  showWhen?: ConfigFieldCondition
}

export type PluginView = {
  id: string
  name: string
  vendor?: string
  version?: string
  description?: string
  category?: string
  color?: string
  icon?: string
  // Deep link to the service's own dashboard, shown as "Open dashboard" on the Settings tab.
  dashboardUrl?: string
  hasCookie: boolean
  // Whether a fresh fetch can run (a cookie, or filled config for sessionless plugins).
  connected: boolean
  // True for `external` plugins (no Magic Login) — the host opens the config form to connect.
  sessionless: boolean
  // Roster membership + onboarding completion. Optional so embeds/snapshots can omit.
  installed?: boolean
  onboardedAt?: number
  // Optional per-failure-cause hint overrides — the error panel prefers these over the generic per-cause copy.
  troubleshooting?: Partial<Record<string, { hint: string; docUrl?: string }>>
  configFields: ConfigFieldView[]
  config: Record<string, string>
  capabilities: CapabilityView[]
}
