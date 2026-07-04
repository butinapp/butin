# `@butinapp/sdk`

The plugin contract for [Butin](../../README.md). A plugin connects one service: you sign in once so Butin
captures your session, then it fetches from that service headless and brings the data home, normalized. This
package is **pure data + types** — no Electron, no React. Core runs your descriptor; one generic renderer in
`@butinapp/ui` draws whatever a capability returns.

## A plugin in one object

```ts
import { definePlugin } from '@butinapp/sdk'
import { billing } from '@butinapp/sdk/presets'

export const acmePlugin = definePlugin({
  meta: { id: 'acme', name: 'Acme', color: '#3b82f6' },
  session: { loginUrl: 'https://acme.com/login', dashboardMarkers: ['/dashboard'], cookieDomains: ['acme.com'] },
  auth: { kind: 'cookie' }, // replay the stored cookie verbatim
  capabilities: [
    { id: 'billing', label: 'Billing', collect: async (ctx) => billing.result(await fetchAcmeBilling(ctx)) }
  ]
})
```

`collect(ctx)` gets an authed `ctx.client` (auth + transport pre-applied) and returns a **`CapabilityResult`**
(`{ datasets, views?, summary? }`). Prefer the **presets** on `@butinapp/sdk/presets` (`billing.result` ·
`billing.summary` · `usage.result` · `keys.result` · `members.result`) over hand-building datasets/views —
they map normalized input onto the renderer for you.

## Every service is three declarative axes

| Axis             | Where              | Options                                                                                                                         |
| ---------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| **Transport**    | `transport.engine` | `node` (axios) · `electron` (real browser identity, for sites that need the browser engine — set `requiresBrowserEngine: true`) |
| **Auth**         | `auth.kind`        | `cookie` · `bearer-token` · `external` · `api-key` · `cookie-csrf` · `minted-jwt` · `rotating-refresh` · `spa-bearer`           |
| **Render shape** | inside `collect()` | JSON · GraphQL · tRPC · Remix/RSC · HTML scrape · gRPC-web — parse however the service needs                                    |

The source files are the reference, each documented inline: `meta.ts` · `session.ts` · `auth.ts` ·
`transport.ts` · `config.ts` · `capability.ts` · the data-view contract (`dataset.ts` · `view.ts` ·
`summary.ts` · `result.ts` · `presets/*`).

## Typed settings

Declare a plugin's settings once with `defineConfigSchema`; `definePlugin` infers `ctx.config`'s type from it — no
explicit generic, no annotation:

```ts
const acmeConfig = defineConfigSchema([{ key: 'orgId', label: 'Organization', kind: 'text', required: true }])
type AcmeConfig = ConfigOf<typeof acmeConfig> // { orgId: string }

export const acmePlugin = definePlugin({ config: acmeConfig /* ctx.config is AcmeConfig in every collect() */ })
```

## Authoring a plugin

1. Scaffold: `pnpm new-plugin <id>` (no `pnpm install` — a plugin is a folder in the existing
   `@butinapp/plugins` package, auto-discovered, no registration).
2. Put everything in `src/main.ts`: the `definePlugin`, the `collect()` bodies, and the pure `build*()`
   transforms (raw payload → `CapabilityResult`).
3. Test the **pure `build*()`** against a redacted fixture and assert with `validateCapabilityResult` — that's
   where coverage lives. See `plugins/serper/` for the canonical example.

The repo root `CONTRIBUTING.md` and `packages/website` (user docs) have the full guide. `@butinapp/*` packages are
bundled into the app, not published to npm.
