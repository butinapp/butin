---
name: update-plugin
description: Use when adding a new Butin plugin or editing an existing one — covers placing the service on the transport/auth/render taxonomy, the session/auth/transport config, capability tabs, the data-view contract (datasets/views/summary + presets), auto-registration, the monogram icon, and fixture tests. Invoke when asked to connect/add/wire a service, scaffold a plugin, or fix a plugin's collect/auth/render.
---

# Update (or add) a Butin plugin

You are adding or editing a Butin **plugin** (a `@butinapp/plugin-*` package). In code it's a
`definePlugin({...})` descriptor; in user-facing copy the thing it connects to is a **service**. Substitute
the **target plugin id** (e.g. `stripe`) for `<id>` throughout. If you weren't given one, ask the user which
service, its login URL, and whether this is a new plugin or an edit to an existing one.

Read first if you haven't this session: `CLAUDE.md` (the plugin contract + conventions). For an EDIT, open the existing `plugins/<id>/main.ts` +
`main.test.ts` first and follow its established shape. Study `plugins/serper/main.ts` as the canonical
reference (billing + usage + apiKeys + a `files`-download invoices table in one file, with fixture-tested
`build*()` transforms, authored via `defineCapability` + a sibling `src/sample.ts` of synthetic raws — §4c). For the **rich rendering patterns** (stat cards with progress/caption/unit/tone,
stacked `stackBy` breakdowns, per-row cumulative Trend columns, status badges + edge currency captions) the
worked example is `plugins/claude/main.ts`. For the **tab information architecture** — the Summary /
Billing / Usage / Members split, one shared fetch, the right altitude per tab (§4a) — the worked example is
`plugins/intercom/main.ts`.

## 1. Place the service on the 3 axes (decide before writing code)

Every service is one point in this space; each axis is **declarative** on the descriptor.

- **Transport** — `transport.engine`. Default `node` (axios; needed when the request sets
  `Origin`/`Sec-Fetch-*`). Use `electron` (real browser identity) for sites whose edge only accepts a real browser — set
  `transport.requiresBrowserEngine: true`. **Do NOT hand-pin `transport.userAgent` / `sec-ch-ua`** — core injects
  the canonical, version-truthful browser identity (`browser/identity.ts`) into **both** capture and replay,
  so the UA always matches the capture window automatically. A hardcoded UA freezes a Chromium version that
  drifts from the real engine → the exact mismatch that breaks `cf_clearance` and any edge that verifies a real browser. Set
  `transport.userAgent` only when a service needs a genuinely _different_ UA than the canonical one.
- **Auth** — `auth.kind`: `cookie` · `bearer-token` (core defaults, no code) · `cookie-csrf` ·
  `minted-jwt` · `rotating-refresh` · `api-key` · `spa-bearer` · `external` (all but the first two need a
  `resolve()` hook, except `spa-bearer`/`external` which core/`collect()` handle). See `packages/sdk/src/auth.ts`
  for exactly what each kind does and which fields it needs.
- **Render shape** — handled imperatively inside each `collect()` (JSON / GraphQL / tRPC+superjson /
  Remix-RSC / HTML scrape / gRPC-web). The contract standardizes the authed client IN and the normalized
  result OUT, not how you parse.

## 2. Scaffold (new plugin) — one command

```bash
pnpm new-plugin <id> [--name "Display Name"] [--vendor "Vendor"]   # no pnpm install — see below
```

`scripts/new-plugin.mjs` stamps `plugins/<id>/` with the 2 files a plugin needs (`main.ts` with a valid
minimal `definePlugin` stub · `main.test.ts`) and prints the next steps. **Don't hand-create these** — the
script is the source of truth for their shape. A plugin is a folder in the single `@butinapp/plugins` package
(no per-plugin `package.json`/`tsconfig`, not a workspace member), so there's **no `pnpm install`** — it's
auto-discovered (see §6) and the stub loads in the app immediately.

Then flesh out `src/main.ts`: real `session`/`auth`/`transport`, replace the stub `custom` capability with
the real ones, and add the exported pure `build*()` transforms. Keep **everything in `src/main.ts`**
(descriptor + `collect()` bodies + pure `build*()`). Split a single capability into its own file ONLY when
it gets genuinely large (e.g. a multi-parser HTML scraper). Tests in `src/main.test.ts` — feed each
`build*()` a redacted/synthetic fixture and assert the normalized shape + money units.

**Canonical `main.ts` layout** — one shape, scaffold-stamped; **`plugins/vercel/main.ts` is the
reference**. Types all up top, then code grouped by domain, so the file reads as a data dictionary followed by
pure logic (interleaving `Raw*` declarations between collectors is what makes a plugin _feel_ messy):

1. imports
2. **constants** — endpoints, origins, magic numbers (one grouped block; never a hand-pinned UA, see §1)
3. **types** — **all of them together**: the `Raw*` wire shapes AND the normalized domain types, in one block
   so a reader sees the whole service surface at once and the code below stays declaration-free
4. **domain logic** — grouped by capability in `capabilities[]` order: a `// --- <feature>: … ---` banner with
   its exported `build*()` (the fixture test target) then its `collect()`; shared helpers (auth/org-resolution) first
5. **descriptor** — `definePlugin({...})`
6. **i18n** (optional) — the `*_EN` map last, fed to `meta.messages`; split to `src/i18n.ts` when large

The enemy is a `Raw*` 200 lines from its only user, a constant declared mid-file far from use, or a helper
re-rolled per plugin — check `@butinapp/sdk/util` first (see §5), and run the `tidy-code` skill once the
collectors are in.

The synthetic demo `sample` raws do NOT live in `main.ts` — they go in a sibling **`src/sample.ts`** (§4c),
typed off the `Raw*` interfaces `main.ts` exports. So `main.ts` keeps logic; `sample.ts` keeps fixtures.

## 3. The descriptor — `definePlugin({...})`

```ts
import { definePlugin } from '@butinapp/sdk'
export const <id>Plugin = definePlugin({
  meta:    { id: '<id>', name, vendor?, category?, color?, icon?, homepage?, dashboardUrl?, version: pkg.version, description? },
  session: { loginUrl, dashboardMarkers[], cookieDomains[], requiredCookie?, localStorageTokens?, manualFields?,
             captureFromUrl?, clearCookiesBeforeCapture? },   // OMIT for auth.kind 'external'
  auth:    { kind, clearOnStatuses?, tokenField?, resolve?, /* spa-bearer: bootUrl, authCaptureUrlPatterns */ },
  transport?: { engine?, requiresBrowserEngine?, baseUrl?, userAgent?, defaultHeaders? },
  config?: { fields: [ /* ConfigField: key,label,kind('text'|'secret'|'select'),required?,options?,showWhen? */ ] },
  capabilities: [ /* see §4 */ ],
  probe?: async (ctx) => { /* cheapest authed GET; a 200 proves the session is live */ }
})
```

- `session` (the capture config) is declarative — see `packages/sdk/src/session.ts`. `dashboardMarkers`
  must match ONLY the settled authed page; `requiredCookie` guards against grabbing a half-set jar;
  `captureFromUrl` auto-extracts account/org ids so the user doesn't type them.
- `config.fields` is what the Settings UI renders for hardcoded ids the collector needs (org slug, region,
  account id). `secret` fields are encrypted at rest; `collect()` reads typed values off `ctx.config`.
- `auth.clearOnStatuses` defaults to `[401]` (wipe session → re-prompt Magic Login). Don't add `403` — it's
  usually a per-request permission denial, not a dead session.

## 4. Capability **tabs** — `capabilities[]`

Each capability becomes one **tab** on the service page, lazy-loaded and rendered by the generic
`<DashboardRenderer>`. There is **ONE shape**: `{ id, label, collect(ctx), sample?, fetchFile? }`. There is
**no `kind`** on capabilities anymore, and no `documents`/`export` capability kinds. Author each via
**`defineCapability`** (§4c) so it carries a demo `sample` — that's the default; a bare `{ id, label, collect }`
is the exception.

### 4a. Decide the tabs first — one job per tab (the altitude recipe)

Before any `collect()`, settle WHAT each tab shows. The recurring failure is mis-judged **altitude** — a
Summary that lists every number, a "tab" built from two stats, the same chart repeated on three tabs. The
fix is a fixed division of labor: **a tab answers exactly one question, and exactly one tab answers it.**
The gold-standard split (intercom + claude, both billing-bearing services) is:

| Tab         | The one question                       | Holds                                                                                                                              | Must NOT hold                                                                 |
| ----------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **Summary** | "How am I doing, at a glance?"         | the monthly-spend **chart** (the Overview spark) + a tight row of **4–6 headline stat cards** + the `section: 'spend'` **summary** | NO tables, NO records — and it's the ONLY tab that emits the rollup `summary` |
| **Billing** | "Show me the money detail + receipts"  | the subscription **record** (keyvalue) + per-line-item **table** + the downloadable **invoice table**                              | NO chart, NO duplicated headline cards (Summary owns those)                   |
| **Usage**   | "What am I consuming vs my allowance?" | per-metric current-vs-limit **table** (+ a daily-trend chart)                                                                      | the money headline (Billing owns dollars)                                     |
| **Members** | "Who's on the account?"                | the roster **table**                                                                                                               | —                                                                             |

`billingSummaryResult` builds the Summary tab (chart + cards + summary, deliberately NO invoice table);
the detail tab builds the records/tables (NO chart, NO summary). **The presets enforce this division — use
them; don't hand-roll a different one.** Summary + Billing share ONE billing fetch (the query cache dedupes
it — see intercom's `loadIntercomBilling`).

**Match the element to the data shape — this IS the "too much / too little / too small" fix:**

- **stat card** = ONE number worth a glance. 4–6 on Summary, each genuinely meaningful; fold a _pair_ into
  one card via `max` (seats used / purchased, usage / limit). Not twelve cards, not one.
- **record (keyvalue)** = the ~5–12 attributes of ONE entity (the account, the subscription).
- **table** = a LIST (invoices, line items, members, keys) — many rows, few high-signal columns.
- **chart** = a trend over time — one per Summary (monthly spend); put a `stackBy` breakdown in its OWN
  chart on the tab that owns its dimension, never alongside the rollup spark.

**Tab count = the number of genuinely distinct domains the service exposes.** A Summary tab earns its place
only when there's a rollup headline + trend to show; a single-domain service (just one key list, just one
usage meter) is **ONE tab** — don't manufacture a Summary with nothing to summarize. When a section has no
rows, drop it (intercom gates the line-items table on `rows.length > 0`) rather than ship an empty panel.

### 4b. The capability shape

- `collect(ctx)` returns a `CapabilityResult` (datasets + views + summary). For a standard port the whole
  body is often a preset builder (`return billingResult({...})`); for domain data, build the result
  directly. `label` is the tab title; `id` must be unique within the plugin.
- **Downloadable files = a `files` view descriptor on a table view** (not a capability kind). With
  `files.urlKey` core GETs the URL; without it, supply the sibling **`fetchFile(ctx, row)`** which returns
  the bytes for one selected row (POST/multi-step downloads — invoice/receipt PDFs).
- **"Save everything" is core-side** (`main/export/extract.ts`) — there is no plugin export hook. It serializes
  every capability to a clean export-envelope JSON + downloads each `files` table + emits `index.md` + `index.html`.

`collect(ctx)` receives `{ client, clientFor, creds, config, browser?, log }`. `client` (a `ButinClient`)
has auth + transport pre-applied: `get`/`post`/`graphql`/`getText`/`request`; `clientFor(key)` reaches a
declared secondary `backend`; `browser?` is a live offscreen session for legacy backends (guard it).
Best-effort secondary calls should `.catch(() => null)` so one failing sub-fetch doesn't blank the whole tab.

### 4c. Author via `defineCapability` — the fetch/build split + a demo `sample`

Prefer **`defineCapability({ id, label, fetch, build, sample })`** over a bare `{ id, label, collect }` — it
makes every plugin demo-able with no real account:

- **`fetch(ctx) → raw`** — the service-specific half (the `ctx.client` calls, org/account resolution,
  multi-page loops, browser/SDK calls); returns the raw wire shape (or a small bundle of them).
- **`build(raw) → CapabilityResult`** — the pure transform (your exported, fixture-tested `build*()`).
- **`sample: raw`** — a SYNTHETIC raw payload. `collect` and `sample` close over the SAME `build`, so the demo
  snapshot can't drift from the live render, and `build(sample)` doubles as a contract test.

`defineCapability` derives the canonical shape (`collect = build(fetch(ctx))`, `sample = () => build(raw)`);
pass `fetchFile` through it unchanged. Where two tabs share a fetch (Summary + Billing), declare one `fetch*`
and reference it from both — the query cache dedupes the HTTP. **Hoist their shared `sample` raw to ONE const**
and pass it to both `defineCapability`s (don't repeat the literal per tab) — else the demo wrapper drifts between
tabs, the one thing the fetch/build split exists to prevent.

> **The `sample` is ADDITIVE, never a replacement for real-shape tests.** A synthetic raw round-trips through
> the same `build`, so `build(sample)` only proves the plumbing + contract-validity — it can NOT exercise
> `build`'s tolerance of messy real shapes (the array-or-dict, null-field, dict-not-list cases that actually
> break collectors). So **keep** the redacted real-capture fixture and the edge-case `build*()` unit tests
> (claude keeps `fixtures/billing-bundle.json`; serper keeps inline `build*()` cases). Adding a `sample` does
> not let you delete either.

**Synthetic raws live in a sibling `src/sample.ts`**, typed off the `Raw*` interfaces `main.ts` **exports** (add
`export` to them). Richness: an INTRINSIC daily/timeseries dataset (rendered from one snapshot — usually
unkeyed) needs ~30 points to look real; a KEYED table (invoices/members/keys) needs only a few rows (the seed
accumulates them across capture days); a `cumulative+monthly` column just needs a plausible newest value per
row (the seed builds the monthly MTD ramp). No real data — `@example.test` emails, `https://example.com/...`
urls, fabricated numbers in the wire's OWN unit (cents/string/major — `build` normalizes).

`pnpm seed-demo` then renders the plugin's REAL shapes in the demo (no generic fallback). **`plugins/serper`**
(simple) and **`plugins/claude`** (bespoke, multi-endpoint, a keyed `cumulative+monthly` members column) are
the worked examples — `main.ts` + `sample.ts` each. A genuinely un-splittable imperative collector may stay
`{ id, label, collect }` (it draws the seed's generic fallback) — the exception, not the default.

## 5. The **data format** — emit data, not React (`CapabilityResult`)

A standard `collect()` returns `{ datasets, views?, summary?, snapshots? }` (validated by
`validateCapabilityResult`). **Prefer the preset builders** — a billing tab's whole body is often
`return billingResult({...})`:

- **Presets** (`@butinapp/sdk/presets`): `billing.result` · `billing.summary` · `usage.result` · `keys.result` · `members.result`.
  They supply default `datasets`/`views`/`summary`; push extra datasets/views onto the result for anything
  custom (see serper's payment-method record + daily-credits timeseries).
- **Datasets** — `table(id, columns, rows)` or `record(id, fields, value)`. Every column carries a
  **semantic role** so the renderer formats it with no per-plugin code: `money · count · percent ·
timestamp · status · label · identifier · url · text`. For `role:'status'` add a `badges` map
  (value → tone: `success|warning|danger|info|neutral|accent|…`) — reach for the ready-made
  `tones.status` / `tones.role` from `@butinapp/sdk/presets` before hand-mapping common statuses. The renderer
  **title-cases** a status value for display (`startCase`; tone still matches the RAW value case-insensitively),
  so a machine enum (`paid`, `team_tier_1`) reads cleanly with no pre-formatting — map a value at the edge only
  for a SEMANTIC rename (`team_tier_1` → `Premium`), using `startCase` (`@butinapp/sdk/util`) for the generic case.
- **Views** — declarative `stat · timeseries · table · keyvalue`, each binding a dataset by id. A
  `timeseries`/spark requires an x of role `timestamp` and a y of role `money|count` (the validator
  enforces this).
- **Summary** — a headline metric with a controlled `section` (`spend · balance · other`) + `role`
  (`money|count|percent`), an optional `basis` display label (`accrued · invoiced · flat · upcoming ·
lastInvoice`), and an optional `headline` override. This is what the cross-service **Overview** bands by —
  only `section: 'spend'` sums across services; `balance` and `other` show per-service, so pick the right one.
- **Rich stat cards** — a `stat` view's `fields` take more than a bare key: a `{ key, max?, unit?, caption?,
tone? }` spec adds `max` → a `value / max` denominator + progress bar (fold a PAIR — seats used/purchased,
  usage/limit — into ONE card via `max`), `unit` → a muted suffix (`/mo`), `caption` → a breakdown/context
  line, `tone` (`positive|negative|muted`) → a value tint (a negative spend delta reads green). All literals
  the plugin computes per fetch. The `billing*Result` presets forward them via `BillingStat`
  (`max/unit/caption/tone`) + `currentMtdCaption`; for a hand-built record, pass the specs to `.stat({ fields })`.
- **Stacked breakdowns** — a `timeseries` view's `stackBy: '<category column>'` pivots a LONG-format table
  (rows of `{ x, category, y }`) into stacked bars + a legend (palette auto-themed). This is the "where did it
  go" view — spend-by-category (seats vs usage), spend-by-model. Keep the single-series monthly chart as the
  rollup spark and put a breakdown in its OWN chart/tab where its dimension data lives, so the Overview still
  compares like-with-like.
- **Per-row trends (free)** — give a `table` a `key` (`key: 'email'`) AND mark a money column
  `accrual: 'cumulative', resetPeriod: 'monthly'` (an MTD-per-row counter). Core then records each row's
  reading history in the ledger and the renderer auto-adds a **Trend** sparkline column (the per-row daily
  breakdown) — no per-plugin code. A cumulative column REQUIRES a keyed table (the validator enforces it).
- **Money** — normalize to **major units at the edge** via `money.ts` (`@butinapp/sdk/util`): `centsToMajor` ·
  `centsStringToMajor` · `millicentsToMajor` · `parseDecimalAmount`. Never ship raw cents/strings. Declare
  the plugin's `reportingCurrency` (ISO-4217); core stamps it onto every money value. **Do NOT restate that
  currency** — a `currency: '<reportingCurrency>'` on a Column/Summary (or threaded through a local report
  field) is redundant: `resolveCurrencies` already fills it, and a `currency-redundancy` guard test fails the
  build on any such literal. Set `currency:` ONLY as a genuine per-value OVERRIDE (a value in a DIFFERENT
  currency than the plugin reports — read off the API, not hardcoded). When a service reports the same kind of
  figure in DIFFERENT currencies across tabs (e.g. CAD invoices vs a USD usage meter), keep each value in its
  TRUE currency and add a `caption` to disambiguate — **never FX-convert at the edge** (currency conversion is
  the Overview's job; the edge does unit normalization only).
- **`percent` role wants a 0..1 fraction** — Intl scales it ×100 for display, so divide a whole-number percent
  (`92.2`) at the edge or it renders `9,220%`. (Same for a `percent` Summary value.)
- **Dates** — normalize to a `'YYYY-MM-DD'` day (or `'YYYY-MM'`) via `date.ts` (`@butinapp/sdk/util`):
  `isoDay` (ISO string → day) · `epochMsDay` / `epochSecDay` (epoch → UTC day) · `monthKey` ·
  `dayMinus` (subtract days from a day) · `utcDaysAgo` / `isoDaysAgo` · `utcMonthStart`; `MS_PER_DAY` for the
  one shared day-in-ms constant. For math those don't cover, use **luxon** (`DateTime`/`Duration` via
  `@butinapp/sdk/libs`), never raw ms arithmetic. **Don't re-roll `x.slice(0,10)`, a `minusDays`, or a local
  `DAY_MS = 86_400_000`** — that's how these accreted across plugins. Only keep a local date helper when the
  semantics genuinely differ (e.g. groq's `isoDay` reformats to fold tz offsets onto the right UTC day, unlike
  the pure-slice SDK one).

> **Before adding ANY small helper, check `@butinapp/sdk/util` first** — money, dates, `startCase` (title-casing
> machine enums), the `table`/`record` dataset builders, the `*Result` presets, `STATUS_TONES`/`ROLE_TONES`,
> and `validateCapabilityResult` / `validateManifest` all live there. Reinventing these is the most common
> avoidable churn.

Keep the real normalization in **exported pure `build*()` functions** (raw API shape → `CapabilityResult`
/ preset input) so they're fixture-testable; `collect()` just fetches and calls them.

## 6. Register it — ZERO edits (auto-discovered)

There is nothing to register. `packages/core/src/main/plugin/plugins.ts` auto-discovers every
`plugins/*/main.ts` via `import.meta.glob` and finds the exported descriptor by shape (a runtime
type-guard keeps the registry typed and throws with the file path if a plugin's `definePlugin` export is
missing/malformed). So adding a plugin is just: create the folder (§2), done — **no `pnpm install`** (a
plugin is a folder in the existing `@butinapp/plugins` package, not a new workspace member) and no edits to
`plugins.ts`, `electron.vite.config.ts`, the `@butinapp/plugins` `package.json`, or its `tsconfig.json`
(a genuinely unique dep is the one exception — add it to `plugins/package.json`). Plugins render in
alphabetical `meta.name` order.

## 7. Icon — nothing to ship

Butin does **not** ship third-party logos. A service renders a brand-colored **letter monogram**
automatically (`<ServiceIcon>` draws `meta.name`'s initial on a solid `meta.color` tile). So just set a
good `meta.color` — no asset, no import. (`meta.icon` remains an optional escape hatch for a plugin's OWN
mark only.)

## 8. Verify — then STOP

Run from the repo root:

- `pnpm fix` (oxfmt + oxlint — REQUIRED after any codegen)
- `pnpm typecheck`
- `pnpm --filter @butinapp/plugin-<id> test` (then `pnpm test` for the full suite). Include a **samples test**
  asserting every capability's `sample` is contract-valid (copy from serper/claude):
  ```ts
  test('every capability declares a sample that is contract-valid', () => {
    for (const cap of <id>Plugin.capabilities) {
      expect(cap.sample, `${cap.id} has a sample`).toBeDefined()
      expect(validateCapabilityResult(resolveCurrencies(cap.sample!(), '<REPORTING_CCY>')), cap.id).toEqual([])
    }
  })
  ```
  The samples test is ADDITIVE — it does NOT replace the redacted real-capture fixture or the edge-case
  `build*()` unit tests (see §4c). All three must be present and green.
- `pnpm seed-demo --home ./.demo-home` — confirm there are **no** `[seed] <id>:… generic fallback` lines (every
  capability now has a sample). Spot-check a `~/<id>/current/<cap>.json` carries the plugin's real dataset ids.
- The full suite includes a `currency-redundancy` guard (core) — if it flags `<id>`, drop the redundant
  `currency: '<reportingCurrency>'` literal (it's stamped automatically); keep only true per-value overrides.

Then run the **`tidy-code`** skill over the new collectors before calling it done (inline single-use
helpers, reuse `@butinapp/sdk/util`, match local idiom — behavior unchanged).

Then open a PR for review. Report what you changed, the test results (verbatim if anything fails), and
anything that still needs a live account to validate (real `collect()` paths, the capture/Magic Login flow).
Privacy is non-negotiable: fixtures stay synthetic, no real cookies/tokens/vendor slugs in the tree,
captured data lives under `~/butin/` only.
