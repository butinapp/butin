import { z } from 'zod'

import type { CollectContext } from './capability.js'

// Declarative settings a plugin needs at collect time (hardcoded ids: org slug, account id, region).
// This is runtime metadata the settings UI renders; the `TConfig` generic on the plugin types what
// `collect()` actually reads. `secret` fields are encrypted at rest and never sent to the renderer;
// `select` is a fixed choice (rendered as a dropdown) and is stored plain like `text`; `combobox` is a
// searchable picker whose choices the plugin fetches through the authed client (see `loadOptions`).
export type ConfigFieldKind = 'text' | 'secret' | 'select' | 'combobox'

// One fetched choice for a `combobox` field (e.g. an org you belong to). `value` is what gets stored
// (and read back via `ctx.config`); `label` is shown; `recommended` marks the plugin's best-guess default.
export type ConfigOption = {
  value: string
  label: string
  description?: string
  recommended?: boolean
}

// Show a field only when another field currently equals a value — lets a plugin branch its settings on a
// `select` (e.g. AWS: show the profile name when authMode='profile', the access keys when 'iam').
export type ConfigFieldCondition = {
  field: string
  equals: string
}

export type ConfigField = {
  key: string
  label: string
  kind: ConfigFieldKind
  required?: boolean
  placeholder?: string
  help?: string
  // Required for kind:'select' — the static choices.
  options?: Array<{ value: string; label: string }>
  // When set, the settings UI renders this field only while the condition holds.
  showWhen?: ConfigFieldCondition
  // For kind:'combobox' — fetch the choices through the authed client (same context a collector gets), so
  // the picker lists the user's real orgs/projects/accounts. Runtime-only, like `auth.resolve()`: it is a
  // function, so core strips it from the schema sent to the renderer and exposes it via listConfigOptions.
  loadOptions?: (ctx: CollectContext) => Promise<ConfigOption[]>
}

export type PluginConfigSchema<TValues = Record<string, unknown>> = {
  fields: ConfigField[]
  // Phantom carrier — never present at runtime. Lets `definePlugin` INFER its `TConfig` from a `config` built
  // with `defineConfig`, so `ctx.config` is typed with NO explicit generic on `definePlugin` and NO per-collect
  // annotation. A plain `{ fields }` literal omits it and falls back to the untyped `Record<string, unknown>`.
  readonly __values?: TValues
}

// --- Typed + validated config VALUES, derived from the field list (one source of truth) ---
//
// The `fields` above are the UI schema (how to render the settings form — kinds, showWhen, loadOptions);
// zod can't express that, so it stays plain data. But the typed VALUES `collect()` reads (`ctx.config`) and
// their on-read validation can both be DERIVED from the same `fields`, with no parallel hand-written schema.
//
// Author pattern: declare `fields` with `as const`, then `ConfigValues<typeof fields>` types `ctx.config`
// and core validates stored values against `configValuesSchema(fields)` on read.

// The structural subset of a ConfigField the derivation reads (so `fields as const` satisfies it). When a
// field declares literal `options`, the value narrows to that union; otherwise it's a string (text/secret/
// combobox all store a string).
type FieldShape = {
  readonly key: string
  readonly required?: boolean
  readonly options?: readonly { readonly value: string }[]
}

type FieldValue<F extends FieldShape> = F extends { readonly options: readonly { readonly value: infer V }[] }
  ? V
  : string

type RequiredKey<F extends readonly FieldShape[]> = Extract<F[number], { readonly required: true }>['key']

// Map a readonly tuple of fields to the typed value record: required fields are present, the rest optional,
// each typed by its options union (selects) or string.
export type ConfigValues<F extends readonly FieldShape[]> = {
  [K in F[number] as K['key'] extends RequiredKey<F> ? K['key'] : never]: FieldValue<K>
} & {
  [K in F[number] as K['key'] extends RequiredKey<F> ? never : K['key']]?: FieldValue<K>
}

// Build a zod validator for stored config values from the field list. Used by core to validate (best-effort)
// what it reads off disk: a `select` value must be one of its options, every value must be a string. Kept
// LENIENT on presence (all-optional) — enforcing `required` is the form's job at save time, not the
// collector's at read time, so an unconfigured plugin doesn't spam validation errors.
export const configValuesSchema = (fields: readonly ConfigField[]): z.ZodType<Record<string, unknown>> => {
  const shape: Record<string, z.ZodTypeAny> = {}

  for (const field of fields) {
    const values = field.options?.map((o) => o.value)
    const base = values && values.length > 0 ? z.enum(values as [string, ...string[]]) : z.string()

    shape[field.key] = base.optional()
  }

  return z.object(shape).passthrough()
}

// Readonly-friendly field input, so a fields literal passed straight to `defineConfig` (no `as const`) still
// narrows its `key`/`required`/`options` for the value-type derivation while keeping the rest of ConfigField.
type ConfigFieldInput = Omit<ConfigField, 'options'> & {
  readonly options?: readonly { readonly value: string; readonly label: string }[]
}

// THE recommended way to declare typed settings: pass the fields once and get back a config schema that carries
// the derived value type. `definePlugin` infers its `TConfig` from it (so `ctx.config` is typed with no generic
// and no per-collect annotation), and the runtime `fields` it produces is what the settings form renders.
// Name the value type with `ConfigOf`:
//   const myConfig = defineConfigSchema([{ key: 'region', label: 'Region', kind: 'text', required: true }])
//   type MyConfig = ConfigOf<typeof myConfig>          // { region: string }
//   export const myPlugin = definePlugin({ config: myConfig, capabilities: [...] })  // ctx.config: MyConfig
export const defineConfigSchema = <const F extends readonly ConfigFieldInput[]>(
  fields: F
): PluginConfigSchema<ConfigValues<F>> => ({ fields: fields as unknown as ConfigField[] })

// Extract the typed config-values record from a `defineConfig(...)` result.
export type ConfigOf<S> = S extends PluginConfigSchema<infer V> ? V : never
