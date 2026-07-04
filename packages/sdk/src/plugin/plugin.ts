import type { CurrencyCode } from '../data/currency.js'

import type { AuthStrategy } from './auth.js'
import type { Capability, CollectContext } from './capability.js'
import type { PluginConfigSchema } from './config.js'
import type { PluginMeta } from './meta.js'
import type { SessionSource } from './session.js'
import type { ButinClient, TransportConfig } from './transport.js'

// A Butin plugin — a complete service descriptor. This is the whole contract a service
// extracts into: who it is, how to capture its session, how stored creds become request auth, which
// transport to use, and what it can do (capabilities). Pure data + collectors; no Electron, no UI.
export type ButinPlugin<TConfig = Record<string, unknown>> = {
  meta: PluginMeta
  // ISO-4217 currency every money value this plugin emits is denominated in (the default for any
  // Column/Summary that does not declare its own `currency`). Core resolves + stamps it onto each report
  // before persisting, so stored data is always self-describing.
  reportingCurrency: CurrencyCode
  // How to capture the service's session via Magic Login. Omitted by `auth.kind: 'external'` plugins —
  // they hold no capturable browser session (they self-authenticate from config), so there's nothing
  // to capture and no login window to open.
  session?: SessionSource
  auth: AuthStrategy
  // Defaults to { engine: 'node' } when omitted.
  transport?: TransportConfig
  // Secondary backends this plugin spans — each a different host + token under the SAME captured session.
  // Some services split one account across platforms (e.g. one product line on a modern API, another on a
  // legacy one), each with its own base URL and its own minted Bearer. Declare each as a named
  // { transport, auth }; a collector reaches it via `ctx.clientFor(key)`. The primary `transport`/`auth`
  // above remain the default `ctx.client`. Omit for the common single-backend case. Bearers are cached per
  // (plugin, backend), so each backend boots/mints independently.
  backends?: Record<string, PluginBackend>
  // Declarative settings schema for the settings UI (the hardcoded ids in `TConfig`). Optional —
  // plugins with no settings omit it. Build it with `defineConfigSchema([...])` and `TConfig` is inferred from it
  // (so `ctx.config` is typed without an explicit `definePlugin<…>` generic); a plain `{ fields }` literal
  // leaves `ctx.config` as the untyped default.
  config?: PluginConfigSchema<TConfig>
  // The feature set. Each capability produces one normalized report.
  capabilities: Capability<TConfig>[]
  // Lightweight connection test for the providers page: ONE cheap authed request that throws on failure
  // (e.g. list orgs). Required — a connection test must be a single probe, never a full capability fetch,
  // so "Test all" stays light and a dead session is the only thing that fails it.
  probe: (ctx: CollectContext<TConfig>) => Promise<void>
}

// One secondary backend: a host + token pair resolved independently of the primary, addressed by a key.
export type PluginBackend = {
  transport?: TransportConfig
  auth: AuthStrategy
  // A backend that authenticates on a DIFFERENT login than the primary declares its own capture here — a
  // SECOND Magic Login, opened on the SAME shared partition so its cookies coexist with the primary's and
  // this backend's transport replays them (run it with `sendCookie: false` so only the partition jar's
  // cookies for this host are sent). `label` names the connect button + the connection row. Omit when the
  // backend rides the primary session.
  session?: SessionSource
  label?: string
  // Cheap authed check for THIS backend's session (the Connection card's Test on a secondary login). Gets a
  // client bound to this backend; throw (or a non-200 it inspects) on a dead session. Only meaningful with
  // `session`; omit when the backend has no separate login to test.
  probe?: (client: ButinClient) => Promise<void>
}

export const definePlugin = <TConfig = Record<string, unknown>>(plugin: ButinPlugin<TConfig>): ButinPlugin<TConfig> =>
  plugin
