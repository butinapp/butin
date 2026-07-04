// Magic Login — declarative capture config. The core opens `loginUrl` in a persistent partition,
// you log in by hand (MFA, SSO, magic link — anything), and once the page settles on an
// authenticated marker the core grabs the session and stores it encrypted. The capture is declarative —
// every plugin describes it as data, not per-service code.

// Pull a token out of the site's localStorage into a named credential field. Used when the auth
// credential is NOT a cookie: Auth0 id_token (screenshotapi), Auth0 refresh token (qdrant), the
// platform bearer (openai).
//   key        — exact localStorage key, OR
//   keyIncludes — substrings the key must all contain (for DYNAMIC keys, e.g. Auth0's
//                 `@@auth0spajs@@::<clientId>::…clusters…` where the clientId varies)
//   jsonPath   — optional dotted path into the JSON-parsed value (e.g. 'body.refresh_token')
export type LocalStorageToken = { key?: string; keyIncludes?: string[]; jsonPath?: string; storeAs: string }

// A value the user pastes by hand because it can't be captured from the jar (e.g. ngrok's
// x-csrf-token). Stored encrypted alongside the cookie.
export type ManualField = { label: string; key: string; placeholder?: string; required?: boolean }

export type SessionSource = {
  loginUrl: string
  // Persistent session partition for the capture window + jar. Defaults to `persist:butin:<id>`.
  partition?: string
  // URL substrings that match ONLY the settled (200) authenticated page — never the login page or
  // a redirect hop. The signal to grab the session NOW.
  dashboardMarkers: string[]
  // Substring-matched cookie hosts whose jar to capture (e.g. 'google.com' spans its subdomains).
  cookieDomains: string[]
  // Wait until a cookie with this name exists before grabbing the jar — guards against capturing a
  // half-set jar when a marker matches before the auth cookie lands.
  requiredCookie?: string
  localStorageTokens?: LocalStorageToken[]
  // Cookies to clear before capture — dropped from the jar before sign-in AND skipped when re-seeding the saved
  // session, so a transient token can't be promoted-then-re-seeded to poison the next login (e.g. Unleash's
  // short-lived SSO JWT; an OAuth CSRF cookie). An entry ending in `*` matches by PREFIX, for a cookie with a
  // dynamic suffix (e.g. Ory Hydra's `ory_hydra_login_csrf_<hash>` → `ory_hydra_login_csrf_*`).
  clearCookiesBeforeCapture?: string[]
  // Whether to promote this service's session cookies to persistent on quit (default true — "log in once"
  // survives relaunch). Set FALSE for a service whose session is session-scoped AND whose stale tokens
  // POISON a fresh login (e.g. a bank where re-auth on top of an expired-but-promoted token throws an
  // access-profile error): then the jar is never persisted, and Magic Login wipes this service's cookies
  // before sign-in — so every reconnect starts clean. Trade-off: you re-login each app launch.
  persistCookies?: boolean
  manualFields?: ManualField[]
  // Never auto-capture the moment the criteria are met — always wait for an explicit Capture click. For a
  // finicky SPA whose authed marker/cookie appears before the session is actually usable (so auto-capture
  // would grab a half-ready session and close the window prematurely). The user can still flip auto-capture
  // on per-window from the toolbar.
  manualCaptureOnly?: boolean
  // Capture id(s) embedded in the settled dashboard URL (e.g. cloud.qdrant.io/accounts/<id>/) into
  // credential fields. Each `pattern`'s first capture group is stored under `storeAs`. Auto-extracts
  // account/org ids so the user doesn't type them.
  captureFromUrl?: Array<{ pattern: string; storeAs: string }>
  // Capture id(s) the service's own SPA emits as an HTTP header rather than in the URL — the only source
  // for an id with no listing endpoint and no URL segment (Groq's `Groq-Organization` response header, the
  // `x-team-id` Hookdeck sends on its dashboard requests). During Magic Login, core watches the capture
  // window's traffic and stores the last seen value of `header` (case-insensitive) under `storeAs`. `on`
  // selects which side carries it — `'response'` (default) or `'request'`.
  captureFromHeader?: Array<{ header: string; storeAs: string; on?: 'request' | 'response' }>
}
