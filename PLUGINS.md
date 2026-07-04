# Butin — plugin model & governance

How plugins work, where they live, what's an "official" contract, and how the surface grows. The full
engine taxonomy (transport × auth × render) and the data-view contract live in
**[`CLAUDE.md`](CLAUDE.md)**.

## What a plugin is

A plugin is a pure descriptor (`definePlugin({...})`):

- **`session?`** — how to capture the login (the Magic Login window; SSO/password/MFA). Omitted by
  `external`-auth plugins, which hold no capturable browser session.
- **`auth`** — how the stored session becomes request auth. A discriminated union on `kind` over **8
  strategies**: `cookie · bearer-token · external · api-key · cookie-csrf · minted-jwt · rotating-refresh ·
spa-bearer` (some carry an optional/required `resolve()` hook).
- **`transport?`** / **`backends?`** — the engine (`node` axios / `electron` net.request for sites that need the browser engine),
  plus any secondary hosts under the same session, reached via `ctx.clientFor(key)`.
- **`capabilities`** — the feature set; there is ONE shape, `{ id, label, collect, fetchFile? }`, and each
  `collect()` returns a normalized `CapabilityResult`.
- **`probe?`** — a cheap authed request for the providers page's connection test (falls back to the first
  capability).

No Electron, no UI, no IO beyond `collect()`/`resolve()` calling the provided client. The harness gives it
an authed client + the credential store + its config.

## Where plugins live — the trust tiers

**A plugin runs inside your authenticated session, with your real cookies and tokens.** A hostile plugin
could exfiltrate your Google / bank / Claude sessions. That fact dictates the distribution model:

- **Now — curated monorepo.** Official, first-party plugins live in `plugins/*`, are bundled into the app,
  and are reviewed by the maintainer. Full trust, type-safe, one release. **Adding a plugin here is the
  intended path.**
- **Later — external plugins, deliberately.** `@butinapp/sdk` is the public contract, so third-party plugins
  are _possible_. But **runtime third-party loading is its own phase** with a real trust boundary —
  signed/reviewed plugins, explicit per-plugin permission, sandboxing. It stays deferred until that story
  exists. Do not load untrusted plugins into a session-capturing app casually.

## Where official contracts are determined

**`@butinapp/sdk` is the single source of truth.** There is no contract outside it:

- **The data-view contract** = `result.ts` (`CapabilityResult`) + `dataset.ts` · `view.ts` · `summary.ts`
  - the preset builders in `presets/*`. A capability emits data, not a per-kind report spine.
- **Auth strategies** = `auth.ts`; **capture/session** = `session.ts`; **plugin shape** = `plugin.ts`;
  **capability shape** = `capability.ts`.

When the SDK is published, **semver governs**: changing the result contract or an auth shape is a breaking
change = major bump. Everything is `0.0.0`/internal today, so the contract is still free to move — that
freezes the day the SDK ships externally.

## How the surface grows — interfaces & views

The standard "ports" every SaaS exposes — `billing · usage · apiKeys · members` — each have a **preset
builder** in `presets/*` that maps the port's data onto a `CapabilityResult` with the right semantic roles.
Promotion is **demand-driven and disciplined**:

1. A new capability builds its `CapabilityResult` directly (or returns a plain object → raw-JSON fallback)
   until the **same data shape appears across ≥ 2 services.** One service's quirk is never a shared preset.
2. When a pattern repeats, **promote it to a preset**: add a `build*()`/preset builder in `presets/*` that
   emits the canonical datasets + views + summary `section`, with a fixture test. (That's how `usage`
   graduated.) The renderer is generic — **no view registration, no dispatch edit.**
3. Resisting premature promotion is what keeps dashboards uniform. Cross-service rollup keys off
   `summary.section`, so a new port that wants to roll up just emits the right section.

`audit` (an event log over time) is intentionally **not** a port — it's a separate future subsystem, a
stream not a snapshot.

## Adding a plugin (the short version)

1. Skim [`CLAUDE.md`](CLAUDE.md) (engine taxonomy + data-view contract) and an existing plugin with the
   closest shape.
2. `pnpm new-plugin <id> [--name "..."] [--vendor "..."]` scaffolds `plugins/<id>/` (a minimal valid
   `main.ts` + `main.test.ts`). Plugins are folders in the single `@butinapp/plugins` package — no per-plugin
   `package.json`/`tsconfig` and no `pnpm install`. Flesh out `main.ts`; keep each pure `build*()` transform
   exported with a fixture test (the real coverage target).
3. **No registration step** — `packages/core/src/main/plugin/plugins.ts` auto-discovers every
   `plugins/*/main.ts` via `import.meta.glob` (found by shape + a runtime type-guard). Nothing to add
   anywhere — not `plugins.ts`, `bundledWorkspace`, or any `package.json`/`tsconfig` (a unique dep goes in
   `plugins/package.json`). Just `pnpm check`, `pnpm test`.
4. Add a `probe` (a cheap authed call). No icon to ship — set a good `meta.color` and `<ServiceIcon>`
   renders a brand-colored letter monogram from `meta.name`.

## Current set

~40 plugins · 8 auth strategies (`cookie · bearer-token · external · api-key · cookie-csrf · minted-jwt ·
rotating-refresh · spa-bearer`) · the standard ports `billing · usage · apiKeys · members` (each a preset),
domain-specific data-view capabilities, downloadable `files` tables, and the core-side "Save everything"
extract. The auto-discovered `plugins/*` folder is the live roster.
