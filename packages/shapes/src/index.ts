// @butinapp/shapes — the host-layer data shapes the app + viewer share, built ON TOP of the SDK's data-view
// contract (@butinapp/sdk/data): the cross-service Overview input, the persisted ledger, the presentation
// manifest, and per-day spend derivation. NOT the plugin-authoring contract (that's @butinapp/sdk) and NOT
// the portable export wire format (that's @butinapp/shapes/bundle, which the out-of-repo viewer consumes).
// Producer = core; consumers = core, @butinapp/ui, and the embed viewer.
export * from './overview.js'
export * from './ledger.js'
export * from './manifest.js'
export * from './daily.js'
export type * from './plugin-view.js'
