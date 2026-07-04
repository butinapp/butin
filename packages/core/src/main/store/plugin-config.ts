import { configValuesSchema, type PluginConfigSchema } from '@butinapp/sdk'

import { log } from '../log.js'

import { decryptValue, encryptValue, readConfig, updatePluginEntry, writeConfig } from './config-file.js'

// Config lives nested under plugins.<id>.config (sibling to the flat credential fields), with secret
// fields stored alongside a `<key>_enc` flag.
const entryConfig = (pluginId: string): Record<string, unknown> => {
  const cfg = readConfig().plugins[pluginId]?.config

  return cfg && typeof cfg === 'object' ? (cfg as Record<string, unknown>) : {}
}

// Full config for the collector path — decrypts secret-kind fields. Main-process only.
export const getPluginConfig = (pluginId: string, schema: PluginConfigSchema): Record<string, unknown> => {
  const raw = entryConfig(pluginId)
  const out: Record<string, unknown> = {}

  for (const field of schema.fields) {
    const value = raw[field.key]

    if (typeof value !== 'string') {
      if (value !== undefined) {
        out[field.key] = value
      }

      continue
    }

    if (field.kind === 'secret') {
      const decrypted = decryptValue(value, raw[`${field.key}_enc`] === true)

      // An undecryptable secret reads as absent (decryptValue → undefined) — skip it rather than store undefined.
      if (decrypted !== undefined) {
        out[field.key] = decrypted
      }
    } else {
      out[field.key] = value
    }
  }

  // Validate the decrypted values against the schema derived from the same field list — a defence at the
  // disk boundary (stale config across versions, a select value no longer offered, a hand-edited file).
  // Lenient: a mismatch is logged, not thrown — a bad stored value must not break the collector outright.
  const parsed = configValuesSchema(schema.fields).safeParse(out)

  if (!parsed.success) {
    log.warn(`config:${pluginId}`, 'stored config values failed validation', parsed.error.issues)
  }

  return out
}

// Non-secret values only — safe to send to the renderer to prefill the settings form.
export const getPublicConfig = (pluginId: string, schema: PluginConfigSchema): Record<string, string> => {
  const raw = entryConfig(pluginId)

  return Object.fromEntries(
    schema.fields
      .filter((field) => field.kind !== 'secret' && typeof raw[field.key] === 'string')
      .map((field) => [field.key, raw[field.key] as string])
  )
}

// True when the plugin has at least one stored config value (text non-empty, or a secret present). For
// `external` plugins the config IS the credential, so this is what "connected" means for them. `select`
// fields are skipped — a defaulted dropdown (e.g. an auth-mode toggle) is a choice, not evidence the
// plugin was actually configured.
export const hasPluginConfig = (pluginId: string, schema: PluginConfigSchema): boolean => {
  const raw = entryConfig(pluginId)

  return schema.fields.some((field) => {
    if (field.kind === 'select') {
      return false
    }

    const value = raw[field.key]

    return typeof value === 'string' ? value.length > 0 : value !== undefined
  })
}

// Wipe a plugin's whole stored config. For `external` plugins, Disconnect clears the config (the
// credential) rather than preserving it the way clearCredentials does for session plugins.
export const clearPluginConfig = (pluginId: string): void => {
  const config = readConfig()
  const entry = config.plugins[pluginId]

  if (entry?.config === undefined) {
    return
  }

  delete entry.config
  writeConfig(config)
}

// Merge submitted values into stored config, encrypting secret-kind fields. A blank secret value is
// ignored (the form sends '' to mean "leave as-is"), so saving the form never wipes a stored secret.
export const setPluginConfig = (pluginId: string, schema: PluginConfigSchema, values: Record<string, string>): void => {
  updatePluginEntry(pluginId, (entry) => {
    const cfg = (entry.config && typeof entry.config === 'object' ? entry.config : {}) as Record<string, unknown>

    for (const field of schema.fields) {
      const value = values[field.key]

      if (value === undefined) {
        continue
      }

      if (field.kind === 'secret') {
        if (value === '') {
          continue
        }

        const { stored, enc } = encryptValue(value)

        cfg[field.key] = stored
        cfg[`${field.key}_enc`] = enc
      } else {
        cfg[field.key] = value
      }
    }

    entry.config = cfg
  })
}
