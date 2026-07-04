// @butinapp/shapes/bundle — the portable export bundle: Butin's normalized data lifted into ONE
// self-contained, versioned JSON blob. The system's most boundary-crossing object — produced by core
// (buildExportBundle), optionally merged by a gateway, consumed by a separately-deployed viewer — so it
// carries its own EXPORT_BUNDLE_FORMAT_VERSION and a parseExportBundle that gates an untrusted blob on that
// version. Kept on its own subpath (not on the host-layer root) because it's the stable wire contract a
// consumer depends on exactly — nothing else.
export * from './export-bundle.js'
// The bundle's `overview` field is OverviewPlugin[], so a consumer deserializing a bundle needs this shape too.
export type { OverviewPlugin } from './overview.js'
