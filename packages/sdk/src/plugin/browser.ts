// A live, authenticated BROWSER session a collector can drive — for services whose session can't be
// replayed with a bare headless request. Some legacy backends keep a short-lived, server-side session that
// a real browser tab holds open but a one-shot `net.request` finds already torn down (it auto-logs-out).
// `BrowserSession.open` navigates an OFFSCREEN window — on the plugin's captured partition — to a URL (a
// real navigation: carries Sec-Fetch-*, runs the page's JS, keeps that session warm), hands the collector a
// `BrowserPage`, then tears the window down. Electron-backed in core; absent in embeds and off-Electron tests
// (so a collector that needs it should guard `if (!ctx.browser) …`).

// One same-origin request issued from INSIDE the live page (so it rides the page's cookies + warm session).
export type BrowserFetchInit = {
  method?: string
  headers?: Record<string, string>
  // A string body (form-urlencoded, JSON, …). The caller stringifies; objects are not accepted.
  body?: string
}

// Read the document + issue same-origin requests from a browsing context — either the top-level page or a
// child frame (see BrowserPage.loadFrame). A collector parses the rendered HTML in normal TS, not script.
export type BrowserContext = {
  // The context document's serialized outer HTML ('' if it's cross-origin and unreadable).
  html: () => Promise<string>
  // A fetch issued from THIS context (so its Origin/Referer are this context's) → decoded text + status.
  fetchText: (url: string, init?: BrowserFetchInit) => Promise<{ status: number; text: string }>
  // A fetch issued from THIS context → raw bytes + status (binary-safe; e.g. a PDF download).
  fetchBytes: (url: string, init?: BrowserFetchInit) => Promise<{ status: number; bytes: Uint8Array }>
}

export type BrowserPage = BrowserContext & {
  // Drive the SAME window to another URL (a real navigation), e.g. an entry/launcher page that primes a
  // server-side context before the page you actually want — the session stays warm across the hop.
  navigate: (url: string) => Promise<void>
  // Load `url` into a hidden CHILD IFRAME of the current page and return a context scoped to it. Use this
  // for pages that must be FRAMED (Sec-Fetch-Dest: iframe) — a legacy modale page that framebusts/logs-off
  // when opened top-level — so its document + same-origin fetches carry the framed context. Same-origin only.
  loadFrame: (url: string) => Promise<BrowserContext>
  // Find an EXISTING child frame the PAGE loaded itself (matched by a substring of its URL) and return a
  // context scoped to it — readable even when it's CROSS-ORIGIN to the top page (where loadFrame/an element
  // read is opaque). For a page (a portal SPA) that embeds another origin's rendered content you must read:
  // let the page boot and load its frame, then read that frame's document + issue its own same-origin fetches.
  // Resolves null while no matching frame has loaded yet (poll until it appears).
  subframe: (urlIncludes: string) => Promise<BrowserContext | null>
  // Download `url` as a REAL navigation (Sec-Fetch-Dest: document) on the live session and return its bytes.
  // For files a server only streams to a navigation — not an XHR (which it answers with an HTML page) —
  // because `fetch` can't set the forbidden `Sec-Fetch-*` headers. Optional `referer` matches the page that
  // minted the (often one-time) download URL.
  download: (url: string, init?: { referer?: string }) => Promise<Uint8Array>
}

export type BrowserSession = {
  open: <T>(url: string, use: (page: BrowserPage) => Promise<T>) => Promise<T>
}
