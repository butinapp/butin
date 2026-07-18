// Identity + classification for a plugin. `id` is the join key everywhere: the credential/config
// key, the session partition (`persist:butin:<id>`), the on-disk data folder, and the link
// between a plugin's main descriptor and its (optional) ui.
//
// Naming convention (surface-always — enforced at load + scaffold; see CLAUDE.md "Plugin naming & id
// convention"): `id` names a SURFACE, never a company. It MUST equal the plugin's folder name and is the
// permanent storage key, so treat it as immutable once shipped. A single-surface vendor keeps the bare brand
// (`stripe`); a vendor with 2+ surfaces qualifies every one (`anthropic-console`, `openai-platform`). `vendor`
// is the exact canonical brand string (identical across that vendor's surfaces, for exact-match grouping);
// `name` is the user-recognizable surface label that disambiguates them (`Anthropic Console` vs `Claude`).
// The sidebar/overview grouping buckets. Not a fixed taxonomy — add a new category freely whenever an existing
// one genuinely doesn't fit AND more than one plugin would live under it (a category of one is noise; use 'other').
// Adding a value is a one-pass change: extend this union, then the exhaustive sites follow it — `CATEGORY_ORDER`
// (core's group-by-category) and the en/fr `category` label maps (ui i18n).
export type PluginCategory = 'finance' | 'cloud' | 'ai' | 'devtools' | 'productivity' | 'rental' | 'utilities' | 'other'

// The recognized failure causes the app's error panel maps onto. The single source for the union: core's
// failure classifier and the UI's error panel both import it, so the set can't drift between layers.
export type TroubleshootingCause =
  | 'session-not-captured'
  | 'session-expired'
  | 'config-missing'
  | 'config-invalid'
  | 'verification-required'
  | 'permission'
  | 'network'
  | 'data-invalid'
  | 'unknown'

// The controlled actions a failure can offer in the error panel. Single source — the classifier picks them
// per cause, the panel renders a button per action, and the IPC layer carries them across unchanged.
export type TroubleshootingAction = 'retry' | 'reconnect' | 'edit-settings' | 'open-dashboard' | 'open-docs'

// Optional per-cause copy overrides for the app's error panel. A plugin declares hints only for its known
// gotchas (e.g. 'config-missing' → "Pick your org in Settings first"); most ship none and get the generic text.
export type Troubleshooting = Partial<Record<TroubleshootingCause, { hint: string; docUrl?: string }>>

export type PluginMeta = {
  // Surface id — kebab-case, equals the folder name, immutable once shipped (see the convention note above).
  id: string
  // User-recognizable surface label (disambiguates surfaces of the same vendor).
  name: string
  // Exact canonical brand string of the company; identical across that vendor's surfaces.
  vendor?: string
  category?: PluginCategory
  description?: string
  // The plugin's own semver, sourced from its package.json. Shown as a chip on the Data status card.
  // Optional so a metadata literal without it still validates.
  version?: string
  // Accent color (hex) for the portal tile + dashboard chrome.
  color?: string
  // Optional custom icon as a renderable image source (data-URI / URL). Butin does NOT ship third-party
  // logos — by default a service renders a brand-colored letter monogram (its `name` initial on a tint of
  // `color`). Only set this if a plugin supplies its OWN mark; the UI renders the monogram when absent.
  icon?: string
  homepage?: string
  // Deep link to where the user manages this service in their browser — the page they'd open to act on
  // what Butin surfaces (the billing console, account dashboard, client portal). Shown as an "Open
  // dashboard" link on the service's Settings tab. Usually the authenticated landing page, not a marketing
  // homepage.
  dashboardUrl?: string
  // Optional per-plugin translations for the DOMAIN-SPECIFIC strings this plugin emits (tab labels, column
  // headers, view/summary titles) that the app's global dictionary doesn't cover — e.g. a health plugin's
  // clinical vocabulary. Keyed by locale tag → (the canonical string the plugin emits → its translation).
  // The app merges these OVER its global dict at render time, so a plugin only needs entries for locales
  // where its emitted (canonical) language differs from the target: an English-canonical plugin ships `fr`;
  // a French-canonical one ships `en`. Pure data — there's no translation runtime in the SDK.
  messages?: Record<string, Record<string, string>>
  // Optional per-failure-cause hint overrides for the app's error panel (see Troubleshooting). Absent on
  // most plugins — they fall back to the generic per-cause copy.
  troubleshooting?: Troubleshooting
}
