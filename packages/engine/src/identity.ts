import { app, type Session } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

// One canonical browser identity for the whole app — the capture window and the headless replay must
// present the SAME browser to a service, or cf_clearance (bound to IP+UA+TLS-identity) breaks and Google's
// client-hints checks reject the session.
//
// Three layers have to agree, or a Chrome-only / "secure browser" check (Google, Slack, or an edge that
// verifies a real browser) distrusts the session and refuses to PERSIST a login — forcing a full re-auth every launch:
//   1. the UA string         (navigator.userAgent + the request header)
//   2. the Sec-Ch-Ua headers (client-hints sent on every request)
//   3. navigator.userAgentData (the client-hints JS API, read in-page) — patched via a preload
//
// CRITICAL: the version must be Electron's REAL Chromium version, not a hardcoded guess. The
// "Electron/x" token is dropped and Chromium relabeled → Google Chrome; the version is never altered. A
// version mismatch between the UA string, Sec-Ch-Ua, userAgentData and the actual JS engine is exactly
// what a browser-verification challenge reads as an inconsistent browser and refuses. A truthful version
// is a real Chromium that calls itself Chrome, which a verification check and Google accept alike.
const CHROME_FULL = process.versions.chrome || '140.0.0.0'
const CHROME_MAJOR = CHROME_FULL.split('.')[0] || '140'

export const BROWSER_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`

// Sent on every request so a client-hints check sees Google Chrome, not Electron's Chromium brand.
export const SEC_CH_UA_HEADERS: Record<string, string> = {
  'Sec-Ch-Ua': `"Chromium";v="${CHROME_MAJOR}", "Not(A:Brand";v="24", "Google Chrome";v="${CHROME_MAJOR}"`,
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"'
}

// Patches navigator.userAgentData in the page's MAIN world before any page JS runs, so Chrome-only
// checks see Google Chrome instead of Electron's brand list. Requires contextIsolation:false on the
// window that loads it. Brands stay in sync with the Sec-Ch-Ua headers.
const CLIENT_HINTS_PRELOAD_SOURCE = `
const VERSION = '${CHROME_MAJOR}'
const FULL_VERSION = '${CHROME_FULL}'
const brands = Object.freeze([
  Object.freeze({ brand: 'Not(A:Brand', version: '24' }),
  Object.freeze({ brand: 'Chromium', version: VERSION }),
  Object.freeze({ brand: 'Google Chrome', version: VERSION })
])
const fullVersionList = Object.freeze([
  Object.freeze({ brand: 'Not(A:Brand', version: '24.0.0.0' }),
  Object.freeze({ brand: 'Chromium', version: FULL_VERSION }),
  Object.freeze({ brand: 'Google Chrome', version: FULL_VERSION })
])
const highEntropy = Object.freeze({
  architecture: 'x86', bitness: '64', brands, fullVersionList, mobile: false, model: '',
  platform: 'Windows', platformVersion: '15.0.0', uaFullVersion: FULL_VERSION, wow64: false
})
const fakeUserAgentData = Object.freeze({
  brands, mobile: false, platform: 'Windows',
  getHighEntropyValues(requested) {
    const out = { brands, mobile: false, platform: 'Windows' }
    if (Array.isArray(requested)) for (const key of requested) if (key in highEntropy) out[key] = highEntropy[key]
    return Promise.resolve(Object.freeze(out))
  },
  toJSON() { return { brands, mobile: false, platform: 'Windows' } }
})
const define = (target) => {
  try {
    Object.defineProperty(target, 'userAgentData', { configurable: true, enumerable: true, get() { return fakeUserAgentData } })
  } catch {}
}
define(Navigator.prototype)
define(navigator)
`

let preloadPath: string | null = null

// Write the client-hints preload to a stable file (userData) once and return its absolute path —
// bundler-agnostic, so it works the same in `electron-vite dev`, a built main, and a packaged app.
export const ensureClientHintsPreload = (): string => {
  if (!preloadPath) {
    const path = join(app.getPath('userData'), 'butin-client-hints.cjs')

    writeFileSync(path, CLIENT_HINTS_PRELOAD_SOURCE)
    preloadPath = path
  }

  return preloadPath
}

const identityApplied = new WeakSet<Session>()

// Make a session present the canonical browser: set the UA string and (unless opted out) inject the
// Sec-Ch-Ua client hints on every request. Electron allows only one onBeforeSendHeaders listener per
// session, so this is idempotent — a second call on the same session is a no-op.
//
// `rewriteHeaders: false` skips the onBeforeSendHeaders rewrite entirely. A `callback({ requestHeaders })`
// makes Electron send ONLY the returned set, dropping the Sec-Fetch-* / Origin / X-Requested-With that
// Chromium adds AFTER the listener — which a Fetch-Metadata CSRF gate (Stripe) requires, so the rewrite trips
// its CSRF check. Such a plugin runs on its own partition (so the shared session keeps the rewrite) and opts
// out here. setUserAgent stays on regardless — it doesn't disturb Fetch-Metadata.
export const applyBrowserIdentity = (ses: Session, opts: { rewriteHeaders?: boolean } = {}): void => {
  if (identityApplied.has(ses)) {
    return
  }

  identityApplied.add(ses)
  ses.setUserAgent(BROWSER_UA)

  if (opts.rewriteHeaders === false) {
    return
  }

  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders, ...SEC_CH_UA_HEADERS }

    // Pass `X-Requested-With` through untouched. The renderer is its only source (Chromium never adds it),
    // so it's present exactly when page JS set it on an XHR (jQuery/ajaxSafePost) — the same request a real
    // Chrome running that page would send. Stripping it desyncs from real Chrome and breaks servers that gate
    // AJAX endpoints on it: Power Pages `/_services/*` + `/_api/cloudflow` 500 without it (routed to a
    // non-AJAX error path), and classic ASP.NET/Rails CSRF checks reject the request.
    headers['Accept-Language'] = headers['Accept-Language'] ?? 'en-US,en;q=0.9'
    callback({ requestHeaders: headers })
  })
}
