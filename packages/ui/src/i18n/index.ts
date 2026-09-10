// @butinapp/ui/i18n — the label + number/date formatting contract: the shape, an English default (context
// falls back to it, so embeds need no provider), the French dict, and the host providers/hooks. Cross-cutting
// (both /dashboard and /shell read it), so it stands as its own layer.
export { I18nProvider, LabelsProvider, useLabels } from './context.js'
export type { ButinI18n } from './context.js'
export { FormatProvider, useFormat } from './format-context.js'
export {
  DEFAULT_FORMAT_PREFS,
  resolveNumberLocale,
  resolveMoneyLocale,
  moneyLocale,
  formatBytes,
  formatDateTime,
  formatTimestamp,
  formatRelative
} from './format.js'
export type { FormatPrefs, CurrencyStyle, DateFormatPreset } from './format.js'
export { en, fr, butinLabels } from './labels.js'
export type { ButinLabels, Locale } from './labels.js'
export { makePluginText, globalPluginText } from './plugin-text.js'
export type { PluginMessages } from './plugin-text.js'
