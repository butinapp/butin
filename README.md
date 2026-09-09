# Butin

> **All your accounts. One place.**

**Butin** is a **local-first** desktop app that puts all your accounts in one place. It pulls the
billing, usage, members, and documents from every service you use into a single local dashboard —
readable without logging in, with every document downloaded and the history the services don't keep.

You sign in to each service once, in a real browser window; Butin stores that session **encrypted on
your device** and fetches _your own_ data on demand from then on — no browser left open per
refresh, nothing sent to any server. It accesses only the accounts you own, with your own credentials,
and everything it retrieves stays under `~/butin/` on your computer. No backend, no custody of your
credentials by anyone but you.

What you get:

- **One place** — billing, usage, and documents across every service, on one screen.
- **No login to open it** — it's already there from local cache; no passwords, no MFA, no timed-out dashboards.
- **More than the native tool** — per-day usage when they only show month-to-date, history they truncate, rollups they never offered.
- **Everything downloaded** — invoices, statements, and records, kept on your disk.

> **Your data, brought home.** It runs in your own session, locally, with no server custody of your
> credentials.

> **About the name** — _butin_ is French for the gathered set you bring back. Here it's all your own
> accounts, gathered from the services that keep them apart into one place that's yours.

## How it works

Each **plugin** connects one service:

1. **Connect once.** A real browser window opens the service's login page. You sign in by hand
   (password, MFA, SSO, magic link — whatever the service uses). Butin captures the resulting session
   (cookies / tokens) and stores it **encrypted** (`safeStorage`).
2. **Sync headless.** From then on, Butin fetches your data directly from Node using that stored
   session — reproducing whatever each service needs (a genuine browser fingerprint for services that
   require one, CSRF tokens, short-lived JWTs, rotating refresh tokens, GraphQL / HTML parsing).
3. **Everything stays local.** Normalized data lands under `~/butin/` (per profile, per service).
   Nothing leaves your machine.

## Quick start

```bash
pnpm install
pnpm test          # unit tests across the workspace
pnpm dev           # run the Electron app
```

## Layout

- `packages/sdk` — `@butinapp/sdk`, the plugin contract.
- `packages/ui` — `@butinapp/ui`, the embeddable design system + the data-view renderer.
- `packages/core` — the Electron app: encrypted credential store + dual-transport replay engine +
  plugin host.
- `packages/website` — the public docs site.
- `packages/{shapes,engine,recorder}` — host/wire shapes, shared browser glue, and the dev session
  recorder (`pnpm record`).
- `plugins/*` — one package per service.

See [`CLAUDE.md`](./CLAUDE.md) for the full architecture, the engine taxonomy, conventions, and how to
author a plugin.

## Status

The headless-replay core, the data-view contract + generic dashboard, sign-in capture, switchable
profiles, and the overview-first UI are built and tested across the auth taxonomy. Every fetch is
user-initiated — Butin is **pull-only** by design: you open it and refresh when you want, with nothing
running in the background. Local-only. See [`ROADMAP.md`](./ROADMAP.md).

## Disclaimer & responsible use

Butin is a tool for accessing **your own accounts and your own data**, on your own device. **You are
responsible** for ensuring your use complies with the terms of service of any service you connect to.
Some services restrict automated access — review their terms and use Butin only with accounts you own
and are authorized to access.

Butin is provided **"as is", without warranty of any kind** (see [`LICENSE`](./LICENSE)), including any
warranty that its use complies with any third party's terms. It takes no custody of your credentials
and sends your data to no one.

All product names, logos, and trademarks are the property of their respective owners. Use of a
service's name or icon is for identification only and does not imply any affiliation with, or
endorsement by, that service.

**The Butin name and logo.** The open-source licenses cover the _code_ (Apache-2.0 / MIT; see
[`LICENSING.md`](./LICENSING.md)); they grant no trademark rights. The name **Butin** and the Butin logos
are trademarks of the project. Nominative use is fine — you may refer to Butin by name (e.g. "built on Butin",
"a fork of Butin"). What you may not do is carry the Butin name or logos as the branding of your own modified
or commercialized fork without written permission; strip the branding when you redistribute a derivative.
