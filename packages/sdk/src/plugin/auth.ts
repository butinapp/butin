import type { ButinClient } from './transport.js'

// Read/write the plugin's stored credentials. `get()` defaults to the 'cookie' field; pass a name
// for captured tokens (e.g. 'accessToken', 'refreshToken', 'csrfToken'). `set()` persists a
// rotated value encrypted — used by write-back strategies (Auth0 refresh, Supabase, Infisical jid).
export type CredentialStore = {
  get: (field?: string) => string | undefined
  set: (field: string, value: string) => void
}

// What a `resolve()` hook receives: a client with the base session already attached (so it can mint
// a JWT, scrape a nonce, or exchange a refresh token), the credential store, and the plugin's config
// (hardcoded ids the hook needs — enterprise slug, org id, account id).
export type AuthContext = { client: ButinClient; creds: CredentialStore; config: Record<string, unknown> }

// What auth resolution returns: headers to merge and/or a Cookie string to send.
export type AuthAttachment = { headers?: Record<string, string>; cookie?: string }

// Per-request auth resolution: mint/scrape/exchange against the base session and return what to attach.
// Results may be memoized per client lifetime by core for stable tokens; rotating-refresh opts out.
export type AuthResolveHook = (ctx: AuthContext) => Promise<AuthAttachment>

// Shared by every strategy. `clearOnStatuses` (default [401]) wipes the stored session → prompts
// re-capture. A 403 is usually a single-request permission rejection, not a dead session, so it's
// excluded by default.
type AuthBase = { clearOnStatuses?: number[] }

// The auth strategies, as a discriminated union on `kind` so each variant carries EXACTLY the fields it
// needs and illegal combinations don't typecheck. Core provides the resolution for the variants that omit
// a `resolve` hook (cookie / bearer-token / external / spa-bearer); the rest supply their own.
export type AuthStrategy =
  // cookie — replay the stored cookie verbatim. Core default; no resolve.
  | (AuthBase & { kind: 'cookie' })
  // bearer-token — Authorization: Bearer <creds.get(tokenField ?? 'accessToken')>. Core default.
  | (AuthBase & { kind: 'bearer-token'; tokenField?: string })
  // external — Butin manages NO session: the plugin authenticates itself inside collect() with its own
  // client/SDK from values it reads off ctx.config (AWS SigV4, a service-account token/JSON, a durable
  // API key). Core attaches nothing, runs no Magic Login, and stores only the config (secrets encrypted).
  // Onboarding is the settings form, not a browser capture; `session` is omitted.
  | (AuthBase & { kind: 'external' })
  // api-key — a durable credential with no browser session. Optionally resolve() it into a header (or just
  // attach it inside the client).
  | (AuthBase & { kind: 'api-key'; resolve?: AuthResolveHook })
  // cookie-csrf — cookie + a CSRF header. `resolve` is OPTIONAL: some services scrape the nonce inside
  // collect() (GitHub fetch-nonce) rather than in a resolve hook; others parse it from a cookie value
  // (HubSpot) or a pasted manual field (ngrok) in resolve(). GOTCHA: a resolve() hook REPLACES core's default
  // cookie attachment — so it MUST return the stored session cookie itself (`cookie: creds.get('cookie')`)
  // alongside the CSRF header, or the requests go out with no session and 401/redirect to login. (Only the
  // BARE base client resolve() scrapes against still carries the cookie, so a nonce/token fetch inside
  // resolve() misleadingly succeeds.) See HubSpot's resolveHubspotAuth.
  | (AuthBase & { kind: 'cookie-csrf'; resolve?: AuthResolveHook })
  // minted-jwt — exchange a durable session cookie for a short-lived JWT per fetch (Clerk/Stytch: Novu,
  // Groq, Upstash). resolve REQUIRED.
  | (AuthBase & { kind: 'minted-jwt'; resolve: AuthResolveHook })
  // rotating-refresh — exchange a refresh token, attach the access token, and creds.set() the rotated
  // refresh token back (Auth0/Qdrant, Supabase/Firecrawl, Infisical jid). resolve REQUIRED; never memoized.
  | (AuthBase & { kind: 'rotating-refresh'; resolve: AuthResolveHook })
  // spa-bearer — the Bearer is a short-lived JWT minted IN-MEMORY by the service's own SPA (OIDC silent-
  // renew), not replayable headless. Core boots `bootUrl` offscreen on the shared partition, captures the
  // Authorization header off `authCaptureUrlPatterns` (webRequest), caches it, and re-mints on 401 (Carnet
  // Santé, Desjardins, Videotron, Supabase). `sessionStorageKeyPrefix` is a fast-path read of the minted
  // token; `bootTimeoutMs` (default 30_000) bounds the boot — no token by then ⇒ the SSO expired.
  // Core-resolved (needs Electron) — no plugin resolve().
  | (AuthBase & {
      kind: 'spa-bearer'
      bootUrl: string
      authCaptureUrlPatterns: string[]
      sessionStorageKeyPrefix?: string
      bootTimeoutMs?: number
    })

export type AuthKind = AuthStrategy['kind']

// The spa-bearer variant, exported for core's offscreen-mint path (spa-session.ts) which needs the
// bootUrl + capture patterns after narrowing.
export type SpaBearerAuth = Extract<AuthStrategy, { kind: 'spa-bearer' }>
