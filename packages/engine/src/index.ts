export { clearServiceCookies, copyCookies, promoteSessionCookies, toSetDetails } from './cookies.js'
export { BROWSER_UA, SEC_CH_UA_HEADERS, ensureClientHintsPreload, applyBrowserIdentity } from './identity.js'
export { popupWebPreferences } from './popups.js'
export {
  cdpCookieToElectron,
  chromeCandidates,
  chromeUserDataDir,
  detectSigninBlock,
  findChromeExe,
  hasChromeSession,
  isSigninBlockUrl,
  launchChromeSignin,
  mapSameSite,
  removeChromeSession,
  type CdpCookie,
  type ChromeSigninResult
} from './chrome-login.js'
export {
  createMagicToolbar,
  TOOLBAR_EXPANDED_HEIGHT,
  TOOLBAR_HEIGHT,
  type MagicToolbar,
  type MagicToolbarOpts,
  type NavEntry,
  type ToolbarStatus
} from './magic-toolbar.js'
export { createStatusBar, wireStatusBar, STATUS_BAR_HEIGHT, type StatusBar } from './magic-statusbar.js'
