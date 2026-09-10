# CLAUDE.md — Butin

Guidance for Claude Code (and humans) working in this repo.

> **Butin** — _all your accounts, in one place._ A local-first Electron app where each **plugin connects one service**: you sign in once so it
> captures your **session**, then it **fetches** from that service **headless** into a single local dashboard you can read without logging in. Nothing ever
> leaves your machine. The account it reads is always _your own_.

## Naming & vocabulary

**Butin** is a personal dashboard for all your own accounts — billing, usage, and documents from every service you use, gathered into **one local place**,
readable offline, on your own machine. The name is French for the gathered set you bring back; here it's all your own accounts, gathered from the services that
keep them apart into one place that's yours. It runs inside _your own_ authenticated session, locally, and the account it reads is always your own — Butin is a
**personal data-portability tool**, not a way into anyone else's data.

Keep user-facing copy plain and neutral: a **plugin** connects a **service**, captures your **session**, and brings back your **data** into a local store. Avoid
heist/"loot" framing in shipped copy, docs, and the public README — the trust story is ownership and locality, and the wording should match it.

**Code identifiers are neutral** (`plugin`, `capability`, `session`, `cookie`, `report`) — so the SDK contract reads plainly to plugin authors.

Butin standardizes one model — capture a service's session once, then fetch from it headless — behind a single plugin interface, so each service extracts into a
portable plugin.

---

## Design principles

**The SDK is pre-1.0 and still shaping toward the cleanest author surface.** `@butinapp/*` isn't published on a semver contract yet — every consumer lives in this
monorepo and moves atomically with the contract. So while it's pre-1.0 the SDK stays free to change: when a name, shape, or layout is wrong, fix it everywhere in one
pass rather than preserving it behind a compatibility shim, deprecation alias, or "internal but exported" escape hatch. A plugin author tracks the contract at head and
should expect it to move until it's versioned.

**The only goal is the cleanest, most intuitive public API for plugin authors.** The `@butinapp/sdk` surface — what a plugin author imports and writes — is the
product's real interface; optimize it as if a stranger had to author a plugin from autocomplete alone, with no tour. Group the surface so the import site reads as
layers (contract · presets · builders · edge utils), keep author-facing and core-internal symbols in different namespaces (a symbol a plugin must never call does
not belong on the author entry point), and prefer one obvious way to do a thing over two. When the current structure fights this, the structure is what's wrong —
redesign from the feature set, not from what exists.

---

## The model: capture once → replay headless

1. **Magic Login (capture).** A persistent-partition Electron window (toolbar + page) opens the service's login page. You sign in by hand (password, MFA, SSO,
   magic link — anything). When the page settles on an authenticated marker — or you hit the toolbar's **force-capture** button — core reads the cookie jar /
   localStorage tokens and stores them **encrypted** (`safeStorage`) under the active profile's `config.json`. The architecture lives in
   `main/session/magic-login.ts` + `main/browser/`. The **OAuth-state cookie trap** every social-login plugin must avoid: list the service's transient session/CSRF
   cookie (e.g. GitHub's `_gh_sess`) in `session.clearCookiesBeforeCapture`, so it isn't promoted to persistent and poison the social-login OAuth `state` on the
   next sign-in.
2. **Replay (the read IS the capture).** Data fetches run **headless from Node** with the stored session — no browser per refresh. Reading a capability on its
   schedule is what fetches the data.
3. **Session Recorder (`pnpm record`).** A CDP recorder in `packages/recorder` for reverse-engineering a service's endpoints when adding or fixing a plugin. It is
   **not** the runtime path — it's how you discover what to replay. Build-excluded from the shipped app by construction (its own electron-vite entry; not a core
   dependency).

This is why it "just works": once the cookie is captured, you don't need the browser open.

---

## The engine taxonomy (what the contract must express)

Every service is a point in a 3-axis space. Butin's job is to make each axis declarative.

**Transport** — `plugin.transport.engine`

- `node` — axios over Node TLS. Most services. Use when the request needs `Origin`/`Sec-Fetch-*` headers (forbidden on Electron `net.request`).
- `electron` — Electron `net.request` presenting the real browser's TLS identity. **Required** for sites whose edge only accepts a real browser (claude.ai, anthropic, xAI, ably,
  cerebras) and rejects a plain Node client. Set `transport.requiresBrowserEngine: true` (readable alias that forces `electron`). The request UA **must match** the sign-in window UA
  — `cf_clearance` is bound to (IP, UA, TLS identity).

> **Both transports inject the canonical browser identity centrally** — the UA + `Sec-Ch-Ua*` client hints (from `browser/identity.ts`, versioned off the real
> Chromium engine). **Plugins must NOT hand-declare `User-Agent` or `sec-ch-ua` in `transport.defaultHeaders`** — that re-pins a stale version that drifts from the
> capture-window UA. Only declare genuinely per-service headers in `defaultHeaders` (`Origin`, `Referer`, `Sec-Fetch-*`, `Accept`). Override the UA only via
> `transport.userAgent` when a service needs a specific one.

**Auth strategy** — `plugin.auth.kind` (+ optional `resolve()` hook)

The kinds (a discriminated union on `kind` in `auth.ts`):

- `cookie` — replay the stored cookie verbatim. _(core default, no code)_
- `bearer-token` — `Authorization: Bearer <creds.get(tokenField)>`. _(core default, no code)_
- `external` — Butin manages NO session: the plugin self-authenticates inside `collect()` with its own SDK/client from values read off `ctx.config` (AWS SigV4).
  `session` is omitted; onboarding is the settings form, and "connected" means the config is filled in. _(no code in auth-resolve)_
- `cookie-csrf` — cookie + a header parsed from a cookie value (HubSpot) or scraped from page HTML (GitHub fetch-nonce) or a pasted manual field (ngrok).
  _(supply `resolve()`)_
- `minted-jwt` — exchange a durable session cookie for a short-lived JWT per fetch (Clerk/Stytch: Novu, Groq, OpenAI, ChatGPT, Upstash). _(supply `resolve()`)_
- `rotating-refresh` — exchange a refresh token, attach the access token, `creds.set()` the rotated refresh token back (Auth0/Qdrant, Infisical `jid`). **Never
  memoized.** _(supply `resolve()`)_
- `api-key` — durable credential with no browser session. _(supply `resolve()` or just hardcode in the client; no live plugin uses it today — durable-key services
  use `external`)_
- `spa-bearer` — the Bearer is a short-lived JWT minted **in-memory by the service's own SPA** (OIDC silent-renew), never replayable headless. Core boots the SPA in
  an offscreen `BrowserWindow` on the shared partition, captures the token off the wire, caches it per-plugin, and re-mints on 401 (Carnet Santé, ClickHouse,
  Desjardins, Supabase, Videotron). _(declare `bootUrl` + capture patterns on `auth`)_

`auth.clearOnStatuses` (default `[401]`) wipes the stored cookie on those statuses so the UI re-prompts Magic Login. A `403` is usually a single-request permission
rejection, **not** a dead session — excluded by default.

**Render shape** — handled imperatively inside `capability.collect()`
JSON · GraphQL POST · tRPC+superjson · Remix/RSC flight-data (`parseRemixData`) · HTML scrape (cheerio) · gRPC-web protobuf. The contract standardizes the **authed
client in** and the **normalized report out**, not how you parse — `collect()` can scrape a nonce, walk a Stripe portal, decode protobuf, whatever the service
needs.

---

## The interface — `@butinapp/sdk`

The author surface is layered across subpaths so an import line reads as tiers: the **plugin-declaration contract** on the root `@butinapp/sdk` (`definePlugin` ·
`defineCapability` · the descriptor types — meta · session · auth · transport · config · capability); the **data-view contract a capability returns** on
`@butinapp/sdk/data` (`table`/`record`/`capabilityResult`/`validateCapabilityResult` · `CapabilityResult`/`Column`/`Dataset`/`View`/`Summary`/…) — declaration on
root, data-shaping on `/data`; the **high-altitude presets** (namespaced) on `@butinapp/sdk/presets` (`billing.summary` · `usage.result` · `keys.result` ·
`members.result` · `blocks.*`); shared **third-party integration** mechanics on `@butinapp/sdk/integrations` (the Stripe hosted-portal + hosted-invoice walk, used
only by services that proxy billing to Stripe); Butin's **edge normalizers** (flat) on `@butinapp/sdk/util` (`round2` · `isoDay` · `startCase` · `convert` · …); the
**synthetic sample toolkit + the contract checks a plugin's tests assert with** on `@butinapp/sdk/testing` (`createSampleGen` · `SampleGen`/`SampleConfig` — what a
plugin's `sample.ts` imports — plus `validateSamples` · `resultValidator`); and the vendored
**base toolkit** on `@butinapp/sdk/libs` (lodash-es + luxon, so a plugin never installs/pins them itself). The author barrels are an **explicit allowlist** (no
`export *`); the internal zod `*Schema` objects are NOT on them — they sit on a host-only `@butinapp/sdk/schema` subpath that `@butinapp/shapes` composes into the
export-bundle wire schema, never imported by a plugin.
The SDK has **no UI half** — plugins emit data (a `CapabilityResult`), never React; one generic renderer in `@butinapp/ui` draws every capability. (The rollup
shapes core + ui share live in the separate **`@butinapp/shapes`** package — host derivation on its root, the portable versioned **export wire format** on
`@butinapp/shapes/bundle` — so they're out of the author SDK entirely.)

```ts
import { definePlugin } from '@butinapp/sdk'
import { billing, usage } from '@butinapp/sdk/presets'
import { round2, isoDay } from '@butinapp/sdk/util'

export const myPlugin = definePlugin({
  meta:    { id, name, vendor?, category?, color?, icon?, homepage?, dashboardUrl? },
  session: { loginUrl, dashboardMarkers[], cookieDomains[], requiredCookie?,
             localStorageTokens?, clearCookiesBeforeCapture?, manualFields? },
  auth:    { kind, clearOnStatuses?, ...per-kind fields },   // discriminated union on `kind`
  transport?: { engine?, requiresBrowserEngine?, baseUrl?, userAgent?, defaultHeaders? },
  capabilities: [ { id, label, collect } ]   // each collect() → a normalized report
})
```

- **Every capability is just `{ id, label, collect }`** — there is ONE capability shape, and there are NO export hooks. `collect()` returns a **`CapabilityResult`**
  (below) that the generic renderer draws. Downloadable files are a `files` descriptor on a table view (not a kind), and cross-service rollup keys off
  `summary.section`. **"Save everything"** (`runExtractAll`) is entirely core-side: it serializes every capability to `data/*.json` (a clean, documented export
  envelope — provenance + typed rows + a compact column schema, not the raw internal result) (+ `.csv`), downloads each `files`-table into `files/`, and emits both
  a generic `index.md` and a self-contained, browsable **`index.html`** (the browser entry point) rendered from the same `CapabilityResult`s — so every plugin gets
  a curated record with zero per-plugin export code. **Plugins ship no UI** — one generic renderer draws every capability (the SDK has no renderer half).
- **`collect(ctx)`** receives `{ client, clientFor, creds, config, browser?, log }`. `client` (a `ButinClient`) has auth + transport pre-applied:
  `get`/`post`/`graphql`/`getText`/`request` — `graphql(url, { query, operationName?, variables?, headers?, … })` POSTs one operation and returns its `data`
  UNWRAPPED, raising when the response carries `errors` (a GraphQL endpoint answers 200 on a failed query, so reading `data` blindly renders an empty tab
  instead of reporting the failure); send `operationName` whenever the service's own client does, since an endpoint that routes or SAFELISTS on it rejects a
  document posted without the name it was registered under. `clientFor(key)` returns a client bound to a declared secondary **`backend`** (a different host +
  token under the same session — for accounts split across platforms; Videotron). `creds` reads/writes credentials (write-back for rotating tokens). `config`
  is the plugin's own typed settings (hardcoded ids: org slug, account id, region). `browser?` is a live authenticated offscreen `BrowserSession` for legacy backends that can't be replayed
  headless (absent off-Electron — guard `if (!ctx.browser)`). `since?` (incremental capabilities only) is the cutoff ISO day below which history is already stored,
  so a `fetch` can paginate newest-first and stop once it crosses it — `undefined` means fetch everything (first run / forced full refetch / non-incremental). The
  optional sibling **`fetchFile(ctx, row)`** is the per-row byte source for a `files` table without
  a `urlKey`. Money is normalized to **major units of the plugin's `reportingCurrency`** at the edge via `money.ts`
  (`centsToMajor`/`centsStringToMajor`/`millicentsToMajor`/`parseDecimalAmount`) — unit conversion, not currency conversion; a currency code is
  cased once via `normalizeCurrency`. Every plugin declares a required
  `reportingCurrency` (ISO-4217); core resolves + stamps it onto each money value before persisting, and a Column/Summary may override it per-value.

### The data-view contract — plugins emit data, not React

A standard `collect()` returns a **`CapabilityResult = { datasets, views?, summary? }`** (`result.ts`, validated by `validateCapabilityResult`). One generic
**`<DashboardRenderer>`** in `@butinapp/ui` renders it — there is no per-capability React.

- **Datasets** (`dataset.ts`) are `table` or `record` with **semantic-role**-typed columns (`money · count · percent · timestamp · status · category · label ·
identifier · url · text`), so the renderer formats every value correctly with no per-plugin code. Badge coloring is the renderer's: a `status` value auto-tones by
  sentiment (a column's optional `badges` map overrides a value the built-in lexicon can't infer); a `category` value (a role, a seat tier — no sentiment) gets a
  stable distinct hue. A free-text column may set `truncate` to cap itself to one ellipsized line (so it stops squashing its neighbours) while keeping the full value
  reachable — a native-title hover peek plus a click-to-open copyable popover.
- **Views** (`view.ts`) are declarative descriptors (`stat · timeseries · table · keyvalue`) that bind a dataset by id.
- **Summary** (`summary.ts`) is a headline metric + a controlled `section` (`spend · balance · other`) that feeds the cross-service Overview rollup — only `spend`
  sums across services; `balance` and `other` show per-service.
- **Preset builders** (`presets/`) map a standard port's data onto a result: `billing.result · usage.result · keys.result · members.result`. A billing plugin's
  whole `collect()` is `return billing.result({...})`. The fixture-tested pure `build*()` normalizers are where the real coverage still lives. To bolt an extra
  panel onto a preset-built result, `addSections(result, ...specs)` (`@butinapp/sdk/data`) — it drops falsy sections and de-dupes datasets by id the way
  `capabilityResult` does, so never hand-push onto `result.datasets`/`result.views`.

### Adding a plugin (the short version)

1. Reverse-engineer the service with **`pnpm record`** (the Session Recorder in `packages/recorder`) — capture the real requests/responses + cookies.
2. Scaffold it with **`pnpm new-plugin <id> [--name "..."] [--vendor "..."]`** — `scripts/new-plugin.mjs` stamps `plugins/<id>/` with a minimal valid `main.ts` stub
   - `main.test.ts`. **No `pnpm install`**: plugins are folders in the single `@butinapp/plugins` package, not workspace members, so there's nothing to register.
     Don't hand-create these.
3. **One file per plugin, one test file.** Put everything — `definePlugin`, the `collect()` bodies, and the pure `build*()` transforms — in `src/main.ts`, with all
   fixture tests in `src/main.test.ts`. The pure `build*()` fns stay **exported and fixture-tested** (this is where the real coverage lives — see
   `plugins/serper/main.ts` + `main.test.ts`, billing+usage+apiKeys in one file). **Escape hatch:** split a single capability into its own file only when it gets
   genuinely large (e.g. an HTML-scrape collector with many parsers). Default to one file — most plugins are a few small collectors.
   3b. **Sample data is first-class.** Author a capability with `defineCapability({ id, label, fetch, build, sample })` — `fetch` is the service-specific
   network/parse half, `build` is the pure raw→`CapabilityResult` transform (the fixture-tested one), `sample` is a synthetic raw payload. `collect` and `sample`
   close over the SAME `build`, so the demo snapshot can't drift from the live render; `build(sample)` doubles as a contract test (`validateCapabilityResult`). The
   synthetic raw consts live in a sibling **`src/sample.ts`** (typed off the raw interfaces `main.ts` exports), keeping the fixtures out of the logic file. The bare
   `{ id, label, collect }` form still works for imperative collectors (they just get the seed's generic fallback — see `pnpm seed-demo`). `plugins/serper` is the
   worked example (`main.ts` + `sample.ts`).
   3c. **Incremental fetch (opt-in).** A capability whose `fetch` returns a row LIST may add `incremental: { id, timestamp, window? }` to `defineCapability` — `id`
   names the row's identity field, `timestamp` its ISO-date field. Core then keeps a keyed **union** of fetched rows on disk (merging each fetch by `id`, retaining
   rows the service no longer returns) and runs `build` over the FULL union, so a partial fetch still renders the whole history with correct totals. The `fetch` must
   honour `ctx.since` (paginate newest-first, stop once past it); `build` is unchanged. `window` is the trailing horizon always re-fetched to catch updates to recent
   rows.
4. **No registration step** — `packages/core/src/main/plugin/plugins.ts` auto-discovers every `plugins/*/main.ts` via `import.meta.glob` and finds the
   `definePlugin` export by shape (a runtime type-guard keeps the registry typed + throws with the file path if the export is missing/malformed). So adding a plugin
   touches NO other file (`plugins.ts`, `electron.vite.config.ts`, the core/plugins `package.json` + `tsconfig.json` are all untouched). Just create
   `plugins/<id>/main.ts` — no `pnpm install` (it's a folder in the existing `@butinapp/plugins` package, not a new workspace member), then typecheck, test. A plugin
   with a genuinely unique dep adds it to `plugins/package.json`. Plugins render in alphabetical `meta.name` order.
5. **Icon — nothing to do.** Butin does **not** ship third-party logos. A service renders a brand-colored **letter monogram** automatically: `<ServiceIcon>` draws
   `meta.name`'s initial on a solid tile of `meta.color` (auto-contrast glyph), in the sidebar / Overview / Management / service header. So all a plugin needs is a
   good `meta.color` — no asset, no import. (`meta.icon` still exists as an optional escape hatch for a plugin shipping its OWN mark, but the default path ships no
   logo, which keeps the public repo clear of other companies' trademarks.)

> **Repo topology (current):** every plugin is a folder inside the single **`@butinapp/plugins`** workspace package (`plugins/package.json` +
> `plugins/tsconfig.json` cover all of them — one typecheck task, one test task), bundled into core at build time via `import.meta.glob`. No per-plugin
> `package.json`/`tsconfig`, and nothing imports a plugin by name. A separate `butin-plugins` repo is premature while the `@butinapp/sdk` contract is still moving
> and there's no runtime plugin loading — the monorepo keeps contract + plugin changes atomic, and `plugins/` is already one self-contained package to extract when
> that day comes. Revisit a split once the SDK is versioned/stable AND runtime loading lands.

### Plugin naming & id convention (surface-always)

The conceptual unit of Butin is **one captured session = one surface = one plugin**, so `meta.id` always names a **surface**, never a company. The id is the
permanent key for the session partition (`persist:butin:<id>`), the data folder (`~/butin/profiles/<id>/<plugin>/`), the credential/config store, and the directory
— treat it as **immutable once shipped**.

1. **`id` names a surface, not a company.** Lowercase kebab-case (`^[a-z0-9]+(-[a-z0-9]+)*$`).
2. **`id` MUST equal the plugin's folder name** (`plugins/<id>/`). Enforced at load — a mismatch is rejected and surfaced in the banner (`loadPlugins` in
   `plugins.ts`), never crashes the app.
3. **Single-surface vendor → bare brand id** (`stripe`, `linear`, `vercel` — no `stripe-stripe`). **Multi-surface vendor → every surface is qualified**,
   conventionally `<vendor>-<surface>` (`anthropic-console`, `openai-platform`, `google-workspace`). No bare-vendor id exists for a multi-surface vendor.
   `pnpm new-plugin` refuses a bare id that would land-grab an existing multi-surface namespace.
4. **`vendor` is the exact canonical brand string** of the company (e.g. `Sentry`, not the legal entity `Functional Software`; `Grafana Labs`, `Amazon Web Services`
   are fine). Two surfaces of the same vendor carry the identical `vendor` string so future group-by-vendor is exact-match.
5. **`name` is the user-recognizable surface label** (`Anthropic Console`, `Claude`, `OpenAI Platform`, `ChatGPT`) — it disambiguates surfaces of the same vendor.

> **No data migration on rename.** Renaming an id orphans the old `~/butin/<id>/` data (the user re-captures). Acceptable pre-launch with a single local user; there
> is no old-id shim.

---

## Workspace layout

A standalone pnpm workspace (`Butin/`). All packages ship **raw TS** — no build step. Top level is
`packages/{sdk, shapes, ui, core, website, engine, recorder}` + `plugins/`. `@butinapp/sdk · @butinapp/ui ·
@butinapp/core` + the plugins are **MIT**.

### `packages/sdk` → `@butinapp/sdk` — THE CONTRACT

Pure types + `define*` helpers + money utils. No Electron. `src/` is grouped by role (each subpath = one `index.ts` barrel; root = `index.ts`):

- **`plugin/`** — the descriptor a plugin declares: meta · session · transport · auth · browser (`BrowserSession`) · config · capability (the ONE shape
  `{ id, label, collect, fetchFile? }`) · documents (file-bytes type) · plugin
- **`data/`** (→ `/data`) — the data-view contract `collect()` returns: dataset · view · summary · result · series · roles · builders · currency
- **`presets/`** (→ `/presets`) — billing · usage · apikeys · members · blocks
- **`integrations/`** (→ `/integrations`) — shared third-party mechanics (stripe)
- **`util/`** (→ `/util`) — money · date · text · bytes · fx · object
- **`testing/`** (→ `/testing`) — synthetic sample toolkit + `validateSamples`/`resultValidator`, the contract checks a plugin's tests assert with
- **`schema.ts`** (→ `/schema`) — the runtime zod `*Schema` objects. HOST-ONLY, not author-facing.

### `packages/shapes` → `@butinapp/shapes` — THE HOST/WIRE SHAPES

Built on `@butinapp/sdk/data`; NOT author-facing. Consumed by core · ui.

- **`src/`** (root, → `.`) — overview · ledger · manifest · daily · plugin-view (`PluginView`, the shared view-model core's DTO + ui both build on)
- **`export-bundle`** (→ `/bundle`) — the portable, versioned export wire format

### `packages/ui` → `@butinapp/ui` — THE DESIGN SYSTEM + the data-view renderer

Pure, prop-driven, theme-portable, EMBEDDABLE. No Electron/IPC/data-fetching. Ships no compiled CSS, but DOES ship `theme.css` (the shared brand tokens + `@theme`,
host-imported). Layered subpaths so an import line says its tier — app-SPECIFIC chrome lives in core:

- **`primitives`** (→ `/primitives`) — `components/{button,card,input,badge,sheet,…}` + `cn`
- **`dashboard`** (→ `/dashboard`) — DashboardRenderer · Overview · overview-model · view-models · rollup · charts · format-role
- **`shell`** (→ `/shell`) — embeddable app scaffolding (for external embeds): AppShell · Sidebar · ServiceTabs · ThemeToggle · conn-state
- **`i18n`** (→ `/i18n`) — en/fr label contract + format
- **root** (→ `.`) — re-exports the shared view-model types (`PluginView · …`, defined in `@butinapp/shapes`) + the ui-local `ReportResult`/`VerifyResult`

### `packages/core` → `@butinapp/core` — The Electron app

`main/` = headless replay + browser/session subsystem; `renderer/` = thin IPC container that wires `window.butin` → `@butinapp/ui` props.

**`src/main/`** grouped by subsystem (`index.ts` = IPC host, `window.ts`, `log.ts` at root):

- **`browser/`** — identity (real-Chromium UA) · session-cookies (promote-on-quit) · shared-session (one `persist:butin` partition) · navigation-browser. (The magic
  toolbar + status bar + chrome-login fallback live in `@butinapp/engine`, shared with the recorder.)
- **`transport/`** — node · electron · client · request-cache · log
- **`session/`** — magic-login (capture) · spa-session (offscreen bearer mint)
- **`plugin/`** — plugins (registry) · plugin-host (`runCapability` + `testConnection`) · plugin-context · validate-plugin · auth-resolve · connection ·
  failure-classifier
- **`ipc/`** — per-domain handler fragments (app · plugins · reports · files · shell · settings · notifications · profiles · vault · window), composed in `index.ts`
  into the one handler table the registration loop walks
- **`store/`** — credentials · config-file · plugin-config (encrypted store) · profiles (switchable isolated account contexts) · store (paths) · report-store ·
  snapshots · overview (home assembler)
- **`export/`** — documents{,-config,-plan} · export{,-bundle} · extract (`runExtractAll`) · extract-serialize
- **`archive/`** — the portable profile archive (moving a profile to another computer): container (the sealed
  format) · export-profile · import-profile

**`src/dev/`** — dev-only tooling, NOT reachable from the main entry (excluded from the shipped bundle): `seed/` (prng · evolver · fallback · synthesize) — the
`pnpm seed-demo` generator. Lives outside `main/` precisely so it reads as dev tooling, not a subsystem.

**`src/preload/index.ts`** — contextBridge `window.butin` (bridge methods GENERATED from the IPC map — no per-method boilerplate).

**`src/shared/ipc.ts`** — the IPC contract: the `IPC` map grouped by domain (domain → method → channel) + a matching nested `ButinApi`, so the renderer calls
`window.butin.<domain>.<method>` (e.g. `window.butin.vault.unlock`). The DTOs live in per-domain files under `src/shared/ipc/` (`ipc.ts` re-exports them, so
consumers import any DTO from `shared/ipc.js` unchanged). Adding a channel = one line in `IPC` + one method on the matching `ButinApi` domain + one handler in the
owning `main/ipc/` fragment; preload + main wiring follow for free. Events live in a separate `IPC_EVENT` const. Fallible channels return one `Result<T>`; long jobs
stream one `job:progress` (a profile archive's pack/restore streams `archive:progress` instead, since it names a profile rather than a plugin).

**`src/renderer/`** — TanStack Router over hash history (`router.tsx` + `routes/*.lazy`): `routes/root` (AppShell + Sidebar chrome, brand/settings top bar,
ProfileMenu, swaps `<Outlet/>`) · overview · service (tabbed, lazy per tab) · management · logs · diagnostics · settings · `index.css` (theme + `@source`) ·
`main.tsx` · `chrome/` (app-SPECIFIC chrome — profiles · vault/lock-gate · settings/notifications/export panels — uses IPC + next-themes, not embeddable) ·
`components/*`.

### `packages/website` → `butin-website`

The public user-facing docs site (Next.js + fumadocs); docs in `content/docs/*.mdx`. The engineering reference is this CLAUDE.md.

**Live on `butin.app`** as an assets-only Cloudflare Worker. A push to `master` touching `packages/website/**` builds the static export and deploys it
(`.github/workflows/website.yml`); a PR uploads a preview version and comments the URL. It is a **static export** — there is no server, so docs search is a
build-time index rather than a route, and every metadata route needs `export const dynamic = 'force-static'`. Full detail, and the two traps worth knowing
before editing it, in `packages/website/README.md` § Deploy.

### `packages/engine` → `@butinapp/engine`

Shared main-process browser glue, consumed by BOTH core and recorder (extracted so the recorder doesn't depend on core): browser identity (real-Chromium UA +
`Sec-Ch-Ua*` client hints) · cookie promote/copy/clear · popup `webPreferences` · the magic toolbar (a `WebContentsView` chrome strip — back/forward/reload +
editable URL + a Debug panel; variants `capture` / `navigate` / `record`) · the status bar (load progress · title · hovered-link URL) · the chrome-login fallback
(open real Chrome for a blocked sign-in, gather its cookies into a partition; the Chrome user-data-dir is keyed by Butin profile id, so the app's Magic Login and
the recorder's capture window share one signed-in Chrome per profile).

**Writing a cookie back goes through `toSetDetails` — never a hand-built `cookies.set`.** Electron normalizes a `domain` with a preceding dot to make it valid for
subdomains, so passing one for a HOST-ONLY cookie does not re-set that cookie: it writes a SECOND, subdomain-scoped cookie of the same name. The server, sending no
Domain attribute, then only ever updates the host-only original while the twin rides along with a frozen value — two values under one name, which a Rails/Express
session reads stale and an OAuth `state` check then rejects. The same helper pins the cookie-prefix rules Chromium enforces on set (`__Host-` must be Secure,
path `/` and carry NO domain; `__Secure-` must be Secure), so a prefixed cookie isn't rejected outright and silently lost.

### `packages/recorder` → `@butinapp/recorder`

Dev-only CDP capture tool: run `pnpm record` to open the session recorder. Profile-first shell: a top-of-sidebar profile switcher scopes the domain list +
recordings to that profile's partition; recording a profile the app holds open is blocked (the `~/butin/app.lock` heartbeat core writes). The capture window uses
the shared engine magic toolbar (`record` variant) + status bar. Domains list per-subdomain; each has Record-again / Merge / Delete, and rows delete individually.
A taxonomy detection layer classifies a recording onto Butin's transport/auth/render axes. Build-excluded from the shipped app — its own electron-vite entry, not
imported by core.

**Recovering a wedged sign-in, from the capture window's Debug panel.** A service that refuses the embedded browser (Google's "may not be secure") reveals **Sign
in with Chrome** — the hand-off signs you in in real Chrome, brings the cookies into the recording's partition and reloads. **Clear domain cookies & reload** wipes
the current page's registrable domain (so every host of the service goes together) without ending the run, which is how a stale cookie the service keeps rejecting
gets cleared. An **isolated** run records into a throwaway in-memory partition, and its Debug panel adds **Keep this session when I stop** — off by default, so a
diagnostic run leaves the profile's jar untouched unless the sign-in that finally worked is worth carrying home.

**Session readiness is a hard rule.** A `Network.*` body command — `getResponseBody` · `getRequestPostData` · `streamResourceContent` — issued on a CDP child
session that has not answered `Network.enable` aborts the browser process from native code: a `CHECK` inside Chromium's network agent, with no rejection to catch,
so the entire run dies with it. A target can accept `Target.attachedToTarget`, answer `Target.setAutoAttach`, and still never answer the enable — the attach is not
proof, the reply is. So every body read goes through `Recorder.send`, which refuses one on a session it has not seen enabled (`canReadBody`) and counts it as
`unreadableBodies`. Add a body-reading command to `BODY_COMMANDS`, never a bare `sendCommand`.

A run survives an abrupt end. The manifest is checkpointed on the same interval that promotes session cookies, so a run dir stays listable — and its captured
requests usable — even when `stop` never runs; `manifest.complete` is false until it does, and `loadRunProfile` declines to cache a summary for a run still being
written. `crashReporter` is started (local only, nothing uploaded), so a native crash leaves a minidump under `app.getPath('crashDumps')` rather than a bare exit
code, and the next launch reports that one is waiting.

Two env flags, both off by default. `BUTIN_RECORDER_TRACE=1` writes `trace.log`: one SYNCHRONOUS line per attached-only action, opened `>` and closed `<`. It
exists because `log.jsonl` is appended asynchronously, so a hard abort discards precisely the tail that explains it — in a trace, an unmatched `>` names the call
the process died inside. `BUTIN_RECORDER_NO_PAGE_TOUCH=1` keeps the debugger attached and every network record intact but stops the recorder reaching into the
page: no `capturePage`, no storage snapshot, no rendered-DOM snapshot.

### `plugins/` → `@butinapp/plugins`

Plugin folders in ONE package (no per-plugin `package.json`/`tsconfig`), one per service, auto-discovered + bundled into core at build (full auth-taxonomy coverage;
see `plugins/` for the current roster).

## UI & embedding — `@butinapp/ui`

> The **visual/UX language** (color, type, monograms, data-density, states) lives in [`DESIGN.md`](DESIGN.md); this section is the wiring that makes it portable.

The UI is built so **pieces ship standalone and embed anywhere, dark or light**. The rules that make this work:

1. **Components are pure + prop-driven.** Everything in `@butinapp/ui` takes data + callbacks as props — no `window.butin`, no TanStack Query, no IPC. `core`'s
   renderer is the only place that touches IPC: it owns the queries/mutations and feeds the presentational components. An embed feeds the _same_ components from a
   published snapshot (the "offline" data source). The view-model types (`PluginView`/`CapabilityView`/`ReportResult`) are decoupled from core's IPC DTOs but
   structurally compatible, so the app passes its DTOs straight through.
2. **Theme-portable, no forced palette.** Components use only shadcn semantic tokens (`bg-card`, `text-muted-foreground`, …). They inherit whatever `.dark`/light the
   host applies on an ancestor — drop a piece into a light host and it's light, a dark host and it's dark. The canonical Butin token values + the `@theme inline`
   mapping + the dark variant live in **`@butinapp/ui/theme.css`** — the single source of truth every Butin host imports, so a palette change (e.g. a contrast fix)
   lands once. Only the theme _picker_ (`next-themes`, which toggles `.dark`) stays in `core`. An external embedder that wants its OWN palette skips that import and
   defines the same semantic tokens itself.
   2b. **Tokens are SCOPED to `.butin`, never `:root` — the containment guarantee.** `theme.css` defines its concrete token VALUES on the `.butin` scope class (dark on
   `.butin.dark` / `.dark .butin`), so importing it into a host's Tailwind build never overwrites the host's own `:root` or its shadcn `--background`/`--chart-*`
   tokens — Butin's values apply only inside a `.butin` subtree. **Every Butin root must carry the class:** the app's `<html>` (`index.html`), and each embed wrapper
   (`@butinapp/viewer`'s `ButinViewer`/`ButinView` render it). A host embedding bare `@butinapp/ui` primitives for its OWN chrome puts `.butin` on an ancestor too. The
   token VALUES are scoped, but `theme.css`'s `@theme inline` mapping is GLOBAL — Tailwind's `@theme` always merges into the build's theme namespace, so a host that
   co-builds `theme.css` has its own `--color-*` rewritten to `var(--token)` (see path (a) below for when that's safe). The echarts `getComputedStyle` probe reads
   tokens off the nearest `.butin`.
3. **Two embed paths — pick by whether the host has its own Tailwind theme:**
   - **(a) Co-build (`theme.css` + `@source`)** — the host's single Tailwind build imports the shared tokens and scans the package source for utilities:
     `@import 'tailwindcss'; @import '@butinapp/ui/theme.css'; @source '…/@butinapp/ui/src/**/*.{ts,tsx}'` (what `core/src/renderer/index.css` does). No compiled CSS
     ships, so there's no duplicate-preflight collision — but because `@theme` is global (2b), this path **overwrites a host's own Tailwind theme** and is only safe for
     a host with NO conflicting theme (the app; a greenfield host).
   - **(b) Drop-in precompiled bundle (`@butinapp/ui/butin.css`)** — the DEFAULT for any external host. A build step (`scripts/build-css.mjs`) compiles Tailwind over the
     component source + `theme.css`, then a PostCSS pass (`scripts/scope-css.mjs`) confines EVERY rule to `.butin`: preflight `:root`/`html`/`body` → `.butin`, the
     universal reset → `.butin, .butin *`, utilities + `dark:` variants → descendant-scoped, and the already-`.butin` token blocks pass through. The host imports this
     one stylesheet, runs no build, shares no tokens, and its `:root`/`*`/`@theme` are never touched — so it works in a Tailwind host (with its own theme), a non-Tailwind
     host, or plain HTML. `dist/butin.css` is build output (gitignored); a compile-based test (`scripts/build-css.test.mjs`) guards that nothing leaks to the document and
     `.butin` keeps the chart tokens.

   Charts (echarts canvas) can't ride the CSS cascade — they read token values via `getComputedStyle` off the nearest `.butin`, which both paths populate.

**Adding a UI primitive/feature:** put it in `@butinapp/ui` if it's presentational and could be embedded; keep it in `core/src/renderer` only if it's app chrome
(uses IPC, `next-themes`, Electron). Import `cn` and primitives from `@butinapp/ui`, not a local copy.

The pure, prop-driven boundary above is what lets a snapshot-fed dashboard embed in other sites — fed from a published snapshot instead of live IPC — without
pulling in the Electron app.

Workspace packages ship **raw TS** (no build step). `electron.vite.config.ts` excludes `@butinapp/*` from `externalizeDepsPlugin` so they're bundled into the main
output; `tsconfig` `paths` map the subpaths to source for typechecking; vitest/vite resolve them via the workspace symlinks.

---

## Commands

From the repo root (pnpm):

```bash
pnpm install            # install everything (downloads Electron)
pnpm dev                # electron-vite dev on @butinapp/core
pnpm dev:debug          # dev WITH the CDP DevTools endpoint open (BUTIN_REMOTE_DEBUG) — see "Driving the app"
pnpm build              # electron-vite build (@butinapp/core main bundle)
pnpm package            # build + electron-builder (NSIS/dmg/AppImage)
pnpm typecheck          # tsc --noEmit across all packages (pnpm -r typecheck)
pnpm test               # vitest run across all packages (pnpm -r test)
pnpm test:coverage      # tests with v8 coverage per package
pnpm check              # format-check + lint + typecheck (CI gate)
pnpm fix                # oxfmt --write + oxlint --fix (run after codegen)
pnpm new-plugin <id> [--name "..."] [--vendor "..."]   # scaffold plugins/<id>/ (main.ts + main.test.ts); auto-registered, no install
pnpm record              # launch the dev session recorder (packages/recorder; never shipped)
pnpm drive [#/hash ...] # launch the BUILT app under Playwright, screenshot routes (autonomous; see below)
pnpm seed-demo [--home ./.demo-home] [--days 30] [--window 180]   # deterministic demo data for every plugin → an isolated BUTIN_HOME
pnpm bump-libs <version|patch|minor|major>   # bump the published graph (sdk + shapes + ui) in lockstep; commit + push to master to release
```

Per package: `pnpm --filter @butinapp/core test`, `pnpm --filter @butinapp/sdk typecheck`, etc.

### Driving the app (visual verification)

The Electron renderer can't be unit-tested, so there are two ways to actually SEE a change in the running app (each renderer is just Chromium, driven over the
DevTools protocol):

- **Interactive, against a live logged-in session** — run **`pnpm dev:debug`** (sets `BUTIN_REMOTE_DEBUG`, which opens a `remote-debugging-port` — env-gated in
  `main/index.ts`, off for shipped builds). Then a CDP client attaches to the running app: the **`butin-app`** MCP server in `.mcp.json` is `@playwright/mcp
--cdp-endpoint http://127.0.0.1:9222` (a new server in `.mcp.json` needs a Claude Code restart / `/mcp` reconnect to register). This drives the REAL app with your
  real captured sessions — snapshot · click · type · screenshot · evaluate. (Caveat: Playwright emulates `prefers-color-scheme: light` on the pages it drives, so a
  `system`-themed app flips to light while connected — purely the debugging connection, the OS default is untouched. Undo it for the session by resetting the
  override: run `page.emulateMedia({ colorScheme: null })` to follow the real OS again.)
- **Autonomous, clean room** — **`pnpm build && pnpm drive`** (`scripts/drive.mjs`) launches the built app via Playwright's `_electron`, walks hash routes, and
  writes a PNG per route to a temp dir (uses the project's own Electron — no browser download). Isolated by default: it sets **`BUTIN_HOME`** to a temp dir, so the
  run never reads or mutates the real `~/butin` (every bundled plugin shows under Available). `BUTIN_HOME` relocates the whole store (config + data + profiles
  registry); `env.ts` is the one place the main process reads env. Requires no other Butin instance running (single-instance lock).

### Demo data (no real accounts)

`pnpm seed-demo` writes deterministic synthetic ledgers + current caches for every plugin into an isolated `BUTIN_HOME` (default `./.demo-home`, gitignored), and
prints the `BUTIN_HOME="<abs>" pnpm dev` line to open the app on it (quit the real instance first — single-instance lock). **Pass the path absolute** — `pnpm dev`
runs Electron from `packages/core`, so a relative `BUTIN_HOME` resolves against a different, empty dir than the seed (run from the repo root) wrote to. Each
capability is drawn from its `sample` if declared (see `defineCapability`), else a preset-by-capability-id fallback; a generic role-based evolver (`dev/seed/`)
fabricates the time-series so Overview trends, "what changed" movers, and per-day detail all populate. Re-running is byte-identical (seeded PRNG — no
`Math.random`/`Date.now`).

---

## Conventions

- **TypeScript, ESM.** Relative imports use **`.js` specifiers** even for `.ts` files (`import { x } from './y.js'`) — bundler resolution; vitest resolves
  `.js`→`.ts`. The cross-package `@butinapp/sdk` (+ `/data` · `/presets` · `/integrations` · `/util` · `/testing` · `/libs`), `@butinapp/ui` (+ `/primitives` ·
  `/dashboard` · `/i18n`), and `@butinapp/shapes` (+ `/bundle`) subpath imports resolve via each package's `exports` map (+ core's tsconfig `paths`).
- **Arrow functions** over `function` declarations. **Named exports only** (no default exports). **`type` over `interface`** for object shapes — one
  declaration form, and it composes (unions, intersections, mapped types) where `interface` doesn't. The one exception is declaration merging, which is
  the whole mechanism of augmenting an ambient type (`declare global { interface Window }`, a library's `declare module` block) — a `type` there collides
  with the existing declaration instead of extending it, so those stay `interface` and say why.
- **Comments only when the WHY is non-obvious.** Wrap code/comments at **150 cols**, never hard-wrap at 70/80.
- **Integrate, don't accrete.** Before adding code, read the enclosing function and its neighbors — an addition reads as if the file had always been this way (match
  naming, idiom, comment density). Reach for an existing helper (check the SDK subpaths: `@butinapp/sdk` for `table`/`record`/`define*`, `@butinapp/sdk/util` for
  money · date · `startCase`, `@butinapp/sdk/presets` for presets) before writing one. A helper/const/type with a single caller is usually inlined; abstract only at
  three+ genuine repetitions. When a change is done, re-read the surrounding scope and tighten — drop throwaway one-use locals and one-call wrappers. The
  `tidy-code` skill is the cleanup pass; this keeps the bloat from accruing in the first place.
- **Never re-roll date or money logic — and never re-define a shared literal.** Date/time math goes through `@butinapp/sdk/util` (`isoDay` to trim an ISO datetime
  to a `'YYYY-MM-DD'` day; `epochMsDay`/`epochSecDay` for epoch→day; `dayMinus(day, n)`/`utcDaysAgo`/`isoDaysAgo` for day arithmetic; `byDayDesc`/`byDayAsc` to
  order rows by their `date` (newest-first is the invoice/document ordering contract, so don't restate the comparator); `monthKey`/`currentMonthKey`/
  `utcMonthStart`) or, for anything those don't cover, **luxon** (`DateTime`/`Duration` via `@butinapp/sdk/libs`). The classic re-rolls — **STOP and reach for the
  helper**: `x.slice(0, 10)` to grab a day (→ `isoDay`), a hand-written `minusDays`/`addDays`/`new Date(Date.parse(d) - n * 86_400_000)` (→ `dayMinus` or luxon), an
  inline `new Date(x).toISOString().slice(0, 10)` (→ `epochMsDay`). Money goes through `@butinapp/sdk/util` money helpers (`centsToMajor` · `millicentsToMajor` ·
  `parseDecimalAmount`), never an ad-hoc `/ 100`, and a currency code is cased once via `normalizeCurrency`.
  Scraped text goes through `squish` (never a hand-rolled `replace(/\s+/g, ' ').trim()`), a person's name through `fullName`, the
  current month's invoiced total through `billing.invoicedMtd`, and a downloaded document is checked with `isPdfBytes` before it is
  saved. And a load-bearing literal is **defined once and imported** — `MS_PER_DAY` (= `86_400_000`) lives in `sdk/util/date.ts`;
  a local `const DAY_MS = 86_400_000` is a duplication, not a convenience. If a genuinely reusable date/money primitive is missing, **add it to `@butinapp/sdk/util`**
  (next to its siblings) so the next caller reuses it too — don't inline a private copy.
- **Linter `oxlint`, formatter `oxfmt`** — no ESLint/Prettier. 120-col, no semicolons, single quotes, no trailing commas, LF, import-sort. `pnpm fix` after any
  codegen. `typescript/no-floating-promises` is an error — `void` deliberate fire-and-forget.
- **strict TS.** `verbatimModuleSyntax` is on — use `import type` for type-only imports.
- **Shared versions live in the pnpm catalog.** Deps used by more than one package (React, the `@types`, the `@butinapp/ui` test stack) are pinned once in
  `pnpm-workspace.yaml` under `catalog:` and referenced as `"react": "catalog:"` in each `package.json` (and in the root `pnpm.overrides`). Bump the version in the
  catalog only — never edit it in multiple `package.json` files.

---

## Comment style

Comments describe the present state of the code, as if it had always been this way.

**SACROSANCT: every comment must be useful to the next person who opens the file. A comment is never addressed to the person who asked for the
change.** Do not justify the code, argue for it, or explain the reasoning that led to it — that belongs in the chat or in a document that gets
thrown away. The reader has no idea a change was ever discussed, so a comment that answers "why did you do it this way?" answers a question
nobody in the file is asking. Two tests before a comment stays: does it still make sense to someone who has never seen the request or any earlier
version, and does it tell them something the code does not already say? If either fails, delete it.

The tells, all of which mean cut it: selling the design ("which is also what keeps X tidy", "so the page answers Y at a glance"), naming the
problem it solved, contrasting with what the code could have been, or restating a requirement. What survives is the contract, the invariant, and
the trap — never the argument.

- Present tense. Describe what the code does and the contract it upholds — not its history.
- NO historical or comparative references: "first", "now", "still", "originally", "previously", "used to", "Mirrors X", "like Y", "based on Z", "ported from". A
  reader has never seen any earlier version and cannot see the file you'd point at.
- NO counts or ordinals that go stale: "the two transports", "the first plugin". Describe each thing on its own terms.
- NO editorializing: "proven", "clever", "simple", "fast path", "the right way".
- Keep load-bearing rationale ONLY when it's non-obvious and still true: ordering constraints, invariants, timing requirements, gotchas, why-not-the-obvious-thing.
  Cut narration that merely retells the reasoning journey.
- A comment must stay correct if I add a sibling, rename another module, or delete the thing it references. If it wouldn't, it's coupled to mutable context —
  rewrite it.

---

## Privacy / local-first — non-negotiable

- All captured data lives under **`~/butin/`** (the user's home), never in the repo, never under Documents/OneDrive. `config.json` holds **encrypted**
  cookies/tokens (`safeStorage`); reports live in `~/butin/<plugin>/reports/`.
- `.gitignore` blocks `.auth/`, `.sessions/`, `.data/`, `out/`, `release/`. **Never commit captured data or live session cookies.** The repo ships only code +
  synthetic/redacted fixtures (e.g. `plugins/claude/fixtures/billing-bundle.json`).
- The trust story is the architecture: it runs in **your** authenticated session, **locally**, with **no credential custody** by any server. That's the whole point
  — keep it that way.

---

## Testing

- **vitest.** Most packages run the **node** environment (no DOM). The **`@butinapp/ui` package is the exception** — it has its own `vitest.config.ts` with the
  **jsdom** environment + a `src/test/setup.ts` (registers `@testing-library/jest-dom` matchers + `afterEach(cleanup)`), so React components can be rendered and
  asserted with `@testing-library/react`. core's renderer route shells and Electron-bound code (`electron-client.ts`, Magic Login) stay typecheck-only + manual
  smoke test.
- **A plugin's sample check is one line:** `expect(validateSamples(<plugin>)).toEqual([])` (`@butinapp/sdk/testing`) draws every capability's `sample` through its
  own `build` and validates the result, reading the currency off the plugin's `reportingCurrency` so a test can't disagree with what core stamps. For a result the
  test built itself, `const validate = resultValidator('CAD')`. Neither replaces the real-shape fixture tests below.
- The **primary coverage target is still the pure functions**: each plugin's `build*()` normalizers (fed a redacted bundle fixture → assert normalized shape + money
  units), the SDK presets + `validateCapabilityResult`, the UI view-models (`formatByRole`, `rollup`, `plan-views`), and core's `pickPrimarySummary`. **`@butinapp/ui`
  component tests** live alongside the component as `*.test.tsx` (see `components/button.test.tsx`, `components/badge.test.tsx`) — render the prop-driven component,
  assert role/text/variant classes/ref forwarding. Keep them focused on presentational behaviour, not IPC.
- `setConfigRoot()` / `setDataRoot()` are test seams pointing the credential/report stores at a temp dir. Off-Electron, `safeStorage` is unavailable so credentials
  fall back to plaintext (tests exercise that path).

---

## Status

User-facing docs live in `packages/website` (`content/docs/*.mdx`); this CLAUDE.md is the engineering reference.

Working local-first portal with a **left-sidebar shell**: `Overview` + a searchable service list (connection dot) + `Management` · `Logs` · `Diagnostics` ·
`Settings`, navigated with TanStack Router over hash history. **Overview** is a rich cross-service dashboard (rollup stat cards · combined monthly-spend chart ·
"what changed" movers · by-service table) from cache, no network on open. A **service page** shows its capabilities as **tabs**, lazy-loaded per tab, each rendered
by the generic `<DashboardRenderer>`, plus a trailing **Settings tab**; **Refresh** re-runs. **Profiles** give switchable, fully-isolated account contexts. The
plugins cover the full auth taxonomy; session reuse survives relaunch.

**Built & working:**

- `@butinapp/sdk` — the full contract + the data-view contract (dataset · view · summary · result · presets incl. blocks) + `defineCapability` (the fetch/build
  split with a drift-proof `sample`), typechecks.
- `@butinapp/ui` — embeddable, theme-portable design system + the generic data-view renderer + rich Overview + the app shell (`AppShell · Sidebar · ServiceTabs ·
ServicePageShell · ServiceSettingsPanel · ProfileSwitcher · Dialog · Switch`) + en/fr i18n contract.
- `@butinapp/core` — encrypted credential/config store · auth resolution (the full auth taxonomy + memoized `resolve()` hook + offscreen spa-bearer mint) ·
  dual-transport `ButinClient` (axios + Electron `net.request`) + a built-in per-plugin query cache · browser session subsystem (real-Chromium identity,
  promote-on-quit cookies, shared `persist:butin` partition) · Magic Login + Disconnect · profiles · cached report store · Overview assembler · plugin host.
- **Profile transfer** — a profile packs into one passphrase-sealed `.butin` archive (sessions re-keyed off
  `safeStorage` so they work on the receiving machine, cached data, every downloaded file including folders
  redirected outside the profile) and imports on another computer as a new profile.
- **Plugins** spanning cookie / bearer-token / external / cookie-CSRF / minted-JWT / rotating-refresh / spa-bearer.
- **Demo seed** — `pnpm seed-demo` writes deterministic synthetic ledgers + current caches for every plugin into an isolated `BUTIN_HOME` (a generic role-based
  evolver in `dev/seed/`, monthly-reset MTD model for cumulative columns). Every plugin is authored via `defineCapability` + `sample.ts`, so the seed draws each
  capability's real shape through its own `build`; the lone exception is the browser-backed `desjardins:releves-compte` collector, which stays bare and draws the
  preset-by-id fallback.

**Manual-only — non-goals (for now), do NOT propose or build:** OS-boot / auto-start, any background process, auto-refresh on launch, a scheduled/cron/interval
refresh, or scheduled push. **Every fetch is user-initiated** via the per-tab Refresh + page-level Refresh-All (both already built). Keep it pull-only.

Roadmap and open work are tracked in [`ROADMAP.md`](ROADMAP.md) and the issue tracker.
