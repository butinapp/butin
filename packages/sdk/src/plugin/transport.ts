// The transports. `node` = axios over Node TLS (most services; can set Origin/Sec-Fetch headers).
// `electron` = Electron net.request presenting the real browser's TLS identity, needed by edges that
// only accept a real browser and reject a plain Node client. `requiresBrowserEngine: true` forces `electron`.
export type TransportEngine = 'node' | 'electron'

// Download-path transport for `files`-tagged tables: the Referer some services require to GET a document, and
// the max parallel downloads (1 for a stateful backend that can't handle concurrency).
export type DownloadTransport = { referer?: string; concurrency?: number }

export type TransportConfig = {
  engine?: TransportEngine
  requiresBrowserEngine?: boolean
  baseUrl?: string
  // Must match the Electron window UA for `electron` transport (server actions key off it).
  userAgent?: string
  defaultHeaders?: Record<string, string>
  // Whether to replay the captured session cookie on each request (default true). Set false for APIs
  // authed purely by a header (bearer-token / spa-bearer) that send NO cookie in the browser: the jar is
  // captured as one flat `name=value; …` string spanning every cookieDomain, so on a multi-
  // subdomain SSO it can exceed the server's 8 KB header limit and 400 ("request header too large") even
  // though the Bearer alone authenticates. Cookie-auth plugins leave this true.
  sendCookie?: boolean
  // Skip the central request-header rewrite (the Sec-Ch-Ua client-hints injection + X-Requested-With strip)
  // for this plugin's capture window. The rewrite's `callback({ requestHeaders })` makes Electron send ONLY
  // the returned set, dropping the native Sec-Fetch-* / Origin / X-Requested-With that Chromium adds after —
  // which a Fetch-Metadata CSRF gate (Stripe) requires, so the header rewrite trips its CSRF check. The plugin runs on
  // its own session partition so the shared session keeps the rewrite; the UA is still set (it doesn't disturb
  // Fetch-Metadata). Leave unset for everything that doesn't have such a CSRF gate.
  nativeBrowserHeaders?: boolean
  download?: DownloadTransport
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export type RequestOptions = {
  url: string
  method?: HttpMethod
  headers?: Record<string, string>
  // Object → JSON-encoded; string → sent raw (GraphQL strings, RSC payloads, form bodies).
  body?: unknown
  responseType?: 'json' | 'text' | 'arraybuffer'
  // Per-call Referer. Some dashboards (Next.js server actions, multi-tenant apps) derive the active
  // org/tenant from the Referer PATH, not the URL or cookie — set it to the real page URL per call.
  referer?: string
  // Per-call auth opt-out (default true). When false, the resolved auth headers (e.g. the Bearer) are NOT
  // attached — the request rides on the cookie jar alone. For a multi-host plugin whose hosts authenticate
  // differently: a cookie-only host (a legacy same-site backend) often 403s a Bearer minted for the API
  // host's audience, so those calls set `sendAuth: false`. The cookie still goes (gate it with the
  // transport-level `sendCookie`). This is the per-request complement to that transport-level flag.
  sendAuth?: boolean
  // Per-call cookie opt-out (default true). The per-request complement to the transport-level `sendCookie`:
  // drop the captured session cookie on a single cross-origin call (a portal/CDN handoff to another domain
  // that must not carry this service's cookie) while the rest of the plugin keeps replaying it.
  sendCookie?: boolean
  // Per-call redirect cap (node transport; the default follows redirects). Set 0 to read a redirect's
  // `Location` header instead of chasing it — e.g. a portal handoff that 302s cross-origin to a one-time
  // session URL the collector must capture and walk itself. A 3xx is then returned as the response, not an error.
  maxRedirects?: number
  // Per-call cache opt-out (default true for GET/POST reads). Set false for a rare non-idempotent call a
  // collector must make so it is never served from / written to the built-in query cache.
  cache?: boolean
  // Per-call pacing opt-out (default true — outbound calls are jitter-spaced per host). Set false when the
  // collector runs its OWN bounded-concurrency fan-out (e.g. fetching N paginated pages at once) and the
  // per-host serial pacer would otherwise force them back into single file.
  pace?: boolean
  // Per-call timeout in milliseconds (default: the transport's shared ceiling). Raise it for one known-heavy
  // query — a wide usage aggregation the service itself paginates — so it isn't aborted mid-flight while every
  // other request keeps the tighter default that turns a hung socket into a prompt error.
  timeout?: number
}

export type ButinResponse<T = unknown> = {
  status: number
  headers: Record<string, string>
  data: T
}

// The authed client handed to every collector. Auth (per the plugin's AuthStrategy) and transport
// (per TransportConfig) are already applied — collectors just describe the request and parse the
// result. `getText`/`graphql` are conveniences for the non-JSON render shapes (cheerio scrape, RSC
// flight data, GraphQL POST). Drop to `request` for full control.
export type ButinClient = {
  request: <T = unknown>(opts: RequestOptions) => Promise<ButinResponse<T>>
  get: <T = unknown>(url: string, headers?: Record<string, string>) => Promise<T>
  post: <T = unknown>(url: string, body?: unknown, headers?: Record<string, string>) => Promise<T>
  graphql: <T = unknown>(url: string, query: string, variables?: Record<string, unknown>) => Promise<T>
  getText: (url: string, headers?: Record<string, string>) => Promise<string>
}
