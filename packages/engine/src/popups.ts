import type { WebPreferences } from 'electron'

import { ensureClientHintsPreload } from './identity.js'

// webPreferences for a popup / child window so it stays on the SAME session partition as its opener. A
// social-login round-trip often runs in a window.open popup; without this the child opens in Electron's
// DEFAULT session (a separate cookie jar), so the provider's state/CSRF cookie set in our partition is
// invisible on the callback and validation fails. contextIsolation:false is required so the client-hints
// preload can override navigator.userAgentData in the page main world; sandbox stays on (the preload
// still runs). Use as `overrideBrowserWindowOptions.webPreferences` in a setWindowOpenHandler.
export const popupWebPreferences = (partition: string): WebPreferences => ({
  partition,
  contextIsolation: false,
  sandbox: true,
  preload: ensureClientHintsPreload()
})
