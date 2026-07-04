// @butinapp/ui — the embeddable, theme-portable design system + the generic data-view renderer. The surface
// is layered across subpaths so an import line says which tier it's in:
//   @butinapp/ui/primitives — pure visual components (Button, Card, Table, …) + cn
//   @butinapp/ui/dashboard  — the descriptor-driven renderer + Overview + chart helpers (the embeddable layer)
//   @butinapp/ui/shell      — the embeddable shell scaffolding (AppShell · Sidebar · ServiceTabs · ThemeToggle)
//   @butinapp/ui/i18n       — the label + format contract
// The app's OWN chrome (profiles, vault, settings, notifications, export) is NOT here — it's
// app-specific, so it lives in core's renderer (core/src/renderer/chrome), leaving this package embeddable.
// This root barrel carries only the cross-cutting view-model types every layer shares, then re-aggregates the
// subpaths so existing root imports keep resolving. (The aggregate stays until the out-of-repo viewer — which
// still imports from the root — is migrated to subpaths alongside publishing; in-repo code imports the tiers.)

// View-model types — the props the presentational components take, decoupled from core's IPC DTOs but
// structurally compatible, so the app passes its DTOs straight through and an embed feeds a snapshot.
export type { PluginView, CapabilityView, ReportResult, VerifyResult, ConfigFieldView } from './types.js'
export type { ConfigOption } from '@butinapp/sdk'

export * from './primitives.js'
export * from './dashboard.js'
export * from './shell.js'
export * from './i18n/index.js'
