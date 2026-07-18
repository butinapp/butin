# Reading this recording

This folder is a **faithful capture of a real browser session** — every network
request/response, the cookies and storage that were live, WebSocket frames, and
navigation screenshots. There is **no application source code here**; your job is to
reconstruct how the site's API works _purely from the observed traffic_ and replay or
extract from it.

You are most likely here to answer: **"How do I reproduce request X programmatically?"**
or **"Where does this piece of data come from?"** This guide tells you how.

## File map

```
summary.md        START HERE — pages visited, top API hosts/endpoints, resource-type counts
manifest.json     run metadata: label, startUrl, counts, hostCounts (API surface at a glance), schemaVersion
network.jsonl     ONE LINE PER REQUEST — your index. {index, ts, method, url, status, type, bytes, durationMs, context, pageTitle, graphqlOperation}. Also has {marker:"pause"|"resume"} lines.
navigation.jsonl  the page-by-page journey: {index, ts, url, title, screenshot, context} — links screenshots to moments
log.jsonl         diagnostic trace: {ts, level, event, message, data} — navigations, Electron load failures, pause/resume, capture errors. Check here (level "error"/"warn") if a flow seems incomplete.
requests/         one JSON per request: NNNN_METHOD_host_path[_operation].json  (NNNN = capture order)
websockets/       one JSON per WebSocket connection, with every frame inline
screenshots/      PNG per navigation (NNNN_<host-path>.png) — visual context only
downloads.json    detected downloadable documents (PDF invoices/statements) + the mechanism each maps to — present ONLY when the run produced downloads. See summary.md "Detected downloads".
cookies.json      cookies present at stop, filtered to hosts visited in this run
cookie-journal.json  every Set-Cookie a response issued DURING the run, in order — present ONLY when a cookie was set. Shows where a session cookie is MINTED (which cookies.json can't, for a cookie that already existed). See summary.md "Set-Cookie journal". If a session cookie you need isn't here, it predated the recording — re-record with it cleared.
storage.json      localStorage + sessionStorage per origin (often where auth tokens live)
session.har       the same requests as standard HAR 1.2 — import into Postman/Insomnia/Chrome
```

**Start with `summary.md`** for orientation (which pages, which hosts/endpoints), then use
**`network.jsonl`** as your line-by-line index: find the call you care about (by URL, method,
status, or `graphqlOperation`), note the `index`, and open the matching file in `requests/`
(its name starts with that zero-padded index).

A `{"marker":"resume"}` line in `network.jsonl` marks where the user resumed capture after
pausing to click around — **the requests after a `resume` are usually the deliberate action**,
the ones before are exploratory noise.

## Filenames are slugified — never read endpoint names or params from them

`requests/NNNN_METHOD_host_path[_operation].json` filenames are a lossy slug for
human scanning, NOT the real request. The slugifier collapses characters, so the
filename can misrepresent the actual URL:

- `_` and `=`/`&`/`?` in the path or query all become `-`. So a file named
  `..._net-usage-group-0-period-3-product-actions-sku-query.json` is really
  `GET .../net_usage?group=0&period=3&product=actions&sku=&query=` — note the
  endpoint is `net_usage` (underscore, not `net-usage`) and the trailing
  `sku-query` is two EMPTY params `sku=&query=`, not `sku=query`.

**Always open the JSON and copy `request.url` verbatim** for the path + query
string. Treat the filename only as an index to find the file. The `summary.md`
endpoint list is also authoritative (it prints the real path); the filename is not.

## Finding the right request

- Grep `network.jsonl` for a path fragment, or grep `requests/*.json` for a value you saw in
  the UI (an id, an email, a label). The response that contains that value is the source.
- Many calls hit the **same URL** (especially GraphQL — usually one endpoint for everything).
  The operation name is extracted for you into `request.graphqlOperation` (and the filename and
  `network.jsonl`); otherwise look for `operationName` / the query inside `request.body`.
- **Next.js Server Actions** look like a `POST` to the page URL — the action id is pulled into
  `request.nextAction` (and the filename / `network.jsonl`). The args are in `request.body`
  (often multipart form-data); the response is an RSC/flight stream (`text/x-component`).
  Initial list data is often server-rendered into the HTML/flight rather than a separate API
  call — interact (paginate/filter/navigate) to surface the client `fetch` or `?_rsc=` request.
- Ignore noise: `type` of `Document`/`Script`/`Stylesheet`/`Image`/`Font` is usually the page
  shell and assets. The API is almost always `type: "XHR"` or `"Fetch"`.
- **Group by page.** Each request carries `context.pageTitle` / `context.pageUrl` — the page
  that was open when it fired. To see what a screen loads behind the scenes, filter by its
  title. `navigation.jsonl` is the ordered journey (url + title + screenshot per step), so you
  can line up a screenshot with the requests that followed it.

## The request record (what matters for replay)

```jsonc
{
  "request": {
    "method": "POST",
    "url": "https://api.example.com/graphql",
    "headers":     { ... },   // headers the app set (what you'd write in code)
    "wireHeaders": { ... },   // EXACT headers on the wire — includes cookie, sec-*, etc.
    "cookies":     [ ... ],   // cookies actually sent
    "body": "{\"query\": ...}"
  },
  "response": {
    "status": 200,
    "headers": { ... },
    "body": "...",            // text, OR base64 when base64Encoded is true
    "base64Encoded": false,
    "mimeType": "application/json",
    "bodyNote": "..."         // ONLY present when body is empty/partial — read it
  },
  "timing": { "durationMs": 42, ... }
}
```

**To mimic a request, prefer `request.wireHeaders`** — it's what the browser actually sent,
including the `cookie` header and `sec-*`/`accept-*` headers some servers require. Use
`request.headers` only if `wireHeaders` is absent. When rebuilding the call:

- **Keep**: `authorization`, `cookie`, `content-type`, and any custom `x-*` headers.
- **Drop / let your client set**: `host`, `content-length`, `connection`, and other
  hop-by-hop headers — they're computed per request.
- Send `request.body` verbatim for the matching `content-type`.

## Where the credentials are

If a request has no obvious `authorization` header, the auth is somewhere else — check, in order:

1. **`request.wireHeaders.cookie`** / `cookies.json` — cookie-based sessions.
2. **`storage.json`** — SPAs frequently keep bearer/JWT/OIDC tokens in `localStorage` or
   `sessionStorage` (look for keys like `access_token`, `id_token`, `oidc.user:*`, `*token*`).
   The app reads them from there and attaches them as `Authorization: Bearer …` per request —
   so the token in `storage.json` is what you replay with.
3. **`response.setCookieHeaders`** on an earlier request — the login/refresh call that minted
   the session.

Tokens and cookies in a recording are **point-in-time and will expire**. Treat them as proof
of the auth _mechanism_, not as durable credentials.

### Is it cookie auth or token auth? (and is the session even logged in?)

This matters because a **cookie-only** session can be reproduced by carrying cookies alone, while
**non-cookie auth cannot**. Pick any authenticated `XHR`/`Fetch` and check what carries the identity:

- **Cookie session** — `request.wireHeaders.cookie` holds a session id (`sid`, `_session`,
  `__Secure-*session*`, …) and there is **no `authorization` header**. The cookie alone reproduces
  the call.
- **Token / non-cookie auth** — requests carry `authorization: Bearer <jwt>` or a custom `x-*-token`
  header, and that value is **absent from every cookie**. It lives in `storage.json`
  (`localStorage`/`sessionStorage`). Cookies alone will NOT reproduce these — you must replay the
  storage token, and watch for a `/refresh`/`/token` call that re-mints it.
- **Mixed** — a cookie gates an HTML or `/refresh` call that hands the SPA a short-lived bearer. Find
  that call in `network.jsonl`; its `response` (body or `setCookieHeaders`) seeds the bearer used
  everywhere else.

**Quick heuristic:** `storage.json` has `*token*` / `id_token` / `oidc.user:*` keys → assume token
auth. Only a session cookie and no such keys → cookie auth.

**Is the captured session actually authenticated?** A recording can capture a _logged-out_ or expired
session — don't mistake it for an auth example. Tell-tale signs:

- `401`/`403` on API calls, or `3xx` redirects to `/login`, `/signin`, or `accounts.google.com`.
- The first `Document` response / navigation screenshot is a sign-in page, not the app.
- `storage.json` empty **and** no session cookie present.

If the auth is token-based or rides on **session-only cookies** (no expiry — they vanish when the
browser closes), a cookie-only session copy is insufficient; that's your signal the login must carry
the storage token or be re-done live.

## Special cases

- **Downloadable documents (PDF invoices/statements)** → check `summary.md`'s **Detected downloads** section
  and `downloads.json` first. Each entry names the `mechanism` a plugin's `files`/`fetchFile` must reproduce:
  `direct-url-get` (GET a URL → PDF), `authed-post` (POST → PDF, often needs `Accept: application/pdf`),
  `base64-in-json` (a `%PDF` base64-embedded in a JSON body), `url-in-json` (a JSON field carrying a signed PDF
  URL), or `native-navigation` (a browser navigation that became a download — **not replayable headless; use
  `ctx.browser`**). `looksSigned` flags a one-time URL that must be minted at download time, and `sourceFile`
  points at the full request record. If a download you performed isn't listed, it was likely captured with a
  `blob:` URL (filtered as noise) — repeat it and check `network.jsonl` for the underlying request.
- **`context.kind` is not `"page"`** → the request came from a popup, iframe, or
  `service_worker`/`worker`. If you couldn't find a call on the main page, it likely ran in a
  worker — search across all `requests/` regardless of context. When the data-bearing HTML
  comes from an **iframe on a different origin than the top page** (and its body carries a
  framebust `<script>`), see **"SPA wrapping a legacy portal"** below — it needs a same-origin
  read, not a top-level navigation.
- **WebSockets** → realtime data is in `websockets/`, not `requests/`. Each file has the
  handshake headers and an ordered `frames[]` (text inline, binary base64).
- **Server-Sent Events / streams** → `response.streamed: true`; the body is the concatenated
  stream. If `bodyNote` says it's partial, the recording stopped mid-stream.
- **Redirects** → a 3xx hop and its destination are separate records (same URL, consecutive
  indices). Follow the `location` response header.
- **Empty `response.body`** → read `bodyNote`. Common reasons: `204/304`, served from cache
  (`fromDiskCache`), binary that wasn't retrievable, or the request was still in flight at
  stop. A `base64Encoded: true` body is binary — decode before reading.

## SPA wrapping a legacy portal (framebust + same-origin reads)

A recurring, easy-to-misread shape: the top window is a modern SPA on origin **A**
(`session.host.com`), but the pages that actually hold the data (invoice lists,
statements) are served from a **different** origin **B** (`services-cl.host.com`) and
embedded as a **cross-origin iframe**. Spot it in the recording when a data-bearing
`Document`/HTML response has `context.kind: "iframe"` (or `sec-fetch-dest: iframe`) and
its `response.body` opens with a **framebust `<script>`** like
`if (top === self) { window.location = 'https://session.host.com' + ... }`.

**Why the obvious replay fails — and what works:**

- **Do NOT navigate your headless window straight to the origin-B page.** Rendered
  top-level, its framebust script fires (`top === self`) and redirects you to the SPA
  shell on origin A — you capture the Angular HTML, not the invoice list. Driving the
  **SPA's own route** instead often triggers an OAuth `/authorize` redirect that
  **aborts** headless (`ERR_ABORTED`).
- **Anchor on origin B, then read same-origin.** Open the offscreen window
  (`ctx.browser`) on a **static asset of origin B** — a JS/CSS file like
  `.../hq/libs/jquery.min.js`, which has no auth and no framebust — then issue every
  call with `fetchText`/`fetchBytes` from that page. Same-origin ⇒ no CORS, the session
  cookies ride along, and the framebust `<script>` is **inert** (a `fetch` body is just
  text, never a rendered page). This one move sidesteps framebust, CORS, and the OAuth
  dance at once.

**Prime the stateful session in the right order.** These portals gate on server-side
session cookies (e.g. `JSESSIONID`, `SESSION`) that specific XHRs **mint** — not the
durable login cookie. Read `cookie-journal.json` to see which response first Set each
one and in what order, then reproduce that sequence before the read (typically: an
analytics/telemetry call mints one, a session/select call mints the other and sets the
"acting context"). A call that **403s despite a valid bearer** almost always means a
prerequisite priming cookie wasn't minted yet — not that the token is wrong.

**CORS allow-headers differ per endpoint — check each `OPTIONS`.** For a cross-origin
XHR the browser sends an `OPTIONS` preflight; its response's
`access-control-allow-headers` lists **exactly** which request headers that endpoint
accepts, and **different endpoints on the same host allow different sets**. Attaching a
header an endpoint doesn't list makes the real `fetch` **throw / get blocked** (a network
error, not a 4xx you can read) — a silent failure. Open the matching `OPTIONS` record per
endpoint and send only its allowed headers. (Anchoring same-origin per above avoids
preflight entirely — another reason to prefer it.)

**Stateful selection.** Such portals hold a "current account/context" server-side. Set it
with a select/activate call **before** the read, and mirror the UI's order (load the list
page, then select the item, then read its detail) — skipping the list-load step can leave
the detail page empty.

## A reproduce recipe

1. Locate the call in `network.jsonl`; open its `requests/NNNN_*.json`.
2. Copy `method`, `url`, `request.wireHeaders`, `request.body`.
3. Resolve auth (see above) — make sure the token/cookie is included in your headers.
4. Drop hop-by-hop headers; let your HTTP client set `host`/`content-length`.
5. Compare your response to the recorded `response.body` to confirm a faithful replay.

`session.har` is a ready-made version of step 1–2 for any HAR-aware tool.
