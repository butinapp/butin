import { createContext, useContext, useMemo, type ReactNode } from 'react'

import { butinLabels, en, type ButinLabels, type Locale } from './labels.js'
import { makePluginText, type PluginMessages } from './plugin-text.js'

// One hook for everything user-facing. `useLabels()` returns the typed chrome contract (compile-checked
// keys + typed interpolation, e.g. `t.dataSaved(x)`) PLUS `s()` — the open, dynamic translator for the
// strings PLUGINS emit (tab labels, column headers, view titles). `t.s('Summary')` → the active locale;
// `t.s(someClusterName)` → unchanged, because unknown strings pass through (so a service's DATA renders
// verbatim). See plugin-text.ts for why plugin strings translate at render time.
export type ButinI18n = ButinLabels & { s: (text: string) => string }

// Defaults to English with an identity `s`, so a component (or an embed) rendered without a provider still
// works. The host wraps the app with the active locale; a service page re-wraps with that plugin's
// `meta.messages` merged in.
const LabelsContext = createContext<ButinI18n>({ ...en, s: (text) => text })

export const useLabels = (): ButinI18n => useContext(LabelsContext)

// The unified provider: the active locale's chrome dict + a plugin-string translator built from that locale
// (and optional per-plugin `messages` merged over the global dict). Nest it on a service page to layer in a
// plugin's domain vocabulary; the inner provider replaces `s` while keeping the same chrome dict.
export const I18nProvider = ({
  locale,
  messages,
  children
}: {
  locale: Locale
  messages?: PluginMessages
  children: ReactNode
}) => {
  const value = useMemo<ButinI18n>(
    () => ({ ...butinLabels[locale], s: makePluginText(locale, messages) }),
    [locale, messages]
  )

  return <LabelsContext.Provider value={value}>{children}</LabelsContext.Provider>
}

// Entry point for tests/embeds that supply a raw chrome dict directly (no locale). Plugin strings pass
// through unchanged (identity `s`) — use I18nProvider when plugin-string translation is needed.
export const LabelsProvider = ({ value, children }: { value: ButinLabels; children: ReactNode }) => (
  <LabelsContext.Provider value={{ ...value, s: (text) => text }}>{children}</LabelsContext.Provider>
)
