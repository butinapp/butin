// @butinapp/ui/shell — the embeddable shell scaffolding: the structural, prop-driven pieces an embed composes
// into a dashboard (the app frame, the service sidebar, a service's capability tabs, the connection dot, the
// theme switch). NOT the Butin app's own chrome — profiles, vault, settings, notifications, and export
// are app-specific and live in core (core/src/renderer/chrome). The out-of-repo viewer builds its
// read-only dashboard from exactly this + /dashboard + /primitives.
export { connDotClass, connLabel, ConnDot } from './features/shell/conn-state.js'
export type { ConnState } from './features/shell/conn-state.js'
export { AppShell } from './features/shell/app-shell.js'
export { ThemeToggle } from './features/shell/theme-toggle.js'
export { Sidebar } from './features/shell/sidebar.js'
export type { SidebarService, SidebarTarget, SidebarActive } from './features/shell/sidebar.js'
export { ServiceTabs } from './features/shell/service-tabs.js'
export type { ServiceTab } from './features/shell/service-tabs.js'
