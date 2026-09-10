// @butinapp/sdk — the plugin-authoring contract: everything needed to DECLARE a plugin — the descriptor
// (meta · session · auth · transport · browser · config · capability · documents · plugin) and the define*
// helpers. The separate "what a capability returns" tier — the data-view contract (datasets · views ·
// summary · result) + the typed builders (table · record · capabilityResult) — is '@butinapp/sdk/data'. The
// high-altitude preset builders live on '@butinapp/sdk/presets'; shared third-party mechanics on
// '@butinapp/sdk/integrations'; edge normalizers on '@butinapp/sdk/util'; the synthetic sample toolkit on
// '@butinapp/sdk/testing'; lodash + luxon on '@butinapp/sdk/libs'. The host-layer rollup/wire shapes core +
// the viewer consume are NOT here — they live in '@butinapp/shapes' (and the wire format on
// '@butinapp/shapes/bundle'), so the author SDK stays purely the plugin-authoring contract.
//
// This barrel is an explicit allowlist, not a wildcard: a symbol is public only when it's named here.

// ── The plugin contract: who the service is, how to capture its session, how creds become auth, transport. ──
export type {
  PluginCategory,
  TroubleshootingCause,
  TroubleshootingAction,
  Troubleshooting,
  PluginMeta
} from './plugin/meta.js'
export type { LocalStorageToken, ManualField, SessionSource } from './plugin/session.js'
export type {
  CredentialStore,
  AuthContext,
  AuthAttachment,
  AuthResolveHook,
  AuthStrategy,
  AuthKind,
  SpaBearerAuth
} from './plugin/auth.js'
export type {
  TransportEngine,
  DownloadTransport,
  TransportConfig,
  HttpMethod,
  RequestOptions,
  GraphqlRequest,
  ButinResponse,
  ButinClient
} from './plugin/transport.js'
export type { BrowserFetchInit, BrowserContext, BrowserPage, BrowserSession } from './plugin/browser.js'
export { configValuesSchema, defineConfigSchema } from './plugin/config.js'
export type {
  ConfigFieldKind,
  ConfigOption,
  ConfigFieldCondition,
  ConfigField,
  PluginConfigSchema,
  ConfigValues,
  ConfigOf
} from './plugin/config.js'
export { defineCapability } from './plugin/capability.js'
export type { CollectContext, Capability, IncrementalSpec, IncrementalCapability } from './plugin/capability.js'
export type { DocumentBytes } from './plugin/documents.js'
export { definePlugin } from './plugin/plugin.js'
export type { ButinPlugin, PluginBackend } from './plugin/plugin.js'
