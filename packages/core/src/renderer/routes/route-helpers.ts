import type { ConnState, SidebarActive } from '@butinapp/ui/shell'

// A reserved id for the synthetic, UI-only Settings tab — cannot collide with a capability id (those are
// plugin-defined slugs without the `__` prefix). Shared so any route can deep-link to the Settings tab (e.g.
// Management Connect on a sessionless plugin sends the user straight to its inline config form there).
export const SETTINGS_TAB_ID = '__settings'

// The single primary CTA the service header shows, derived from the honest connection state: a live (or
// merely unverified) session refreshes; a dead one reconnects, or — for a sessionless plugin with no login to
// capture — sends the user to the config form. Keyed on `state`, not `connected`, so a session that went red
// without clearing its cookie (a 403 / expired SPA bearer) still surfaces Reconnect instead of a dead button.
export const headerAction = (state: ConnState, sessionless: boolean): 'refresh' | 'reconnect' | 'connect' =>
  state === 'disconnected' ? (sessionless ? 'connect' : 'reconnect') : 'refresh'

// The route's first-tab default, used by the /service/$serviceId redirect guard.
export const firstTabFor = (plugin: { capabilities: { id: string }[] } | undefined): string =>
  plugin?.capabilities[0]?.id ?? ''

// Derive the sidebar's active item from the current pathname (hash-history pathname, e.g. '/service/groq/usage').
export const activeFromPath = (pathname: string): SidebarActive => {
  const parts = pathname.replace(/^\/+/, '').split('/').filter(Boolean)

  if (parts[0] === 'management') {
    return { kind: 'management' }
  }

  if (parts[0] === 'developer') {
    return { kind: 'developer' }
  }

  if (parts[0] === 'service' && parts[1]) {
    return { kind: 'service', serviceId: parts[1] }
  }

  return { kind: 'overview' }
}
