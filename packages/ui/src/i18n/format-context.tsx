import { createContext, useContext, type ReactNode } from 'react'

import { DEFAULT_FORMAT_PREFS, type FormatPrefs } from './format.js'

const FormatContext = createContext<FormatPrefs>(DEFAULT_FORMAT_PREFS)

export const FormatProvider = ({ value, children }: { value: FormatPrefs; children: ReactNode }) => (
  <FormatContext.Provider value={value}>{children}</FormatContext.Provider>
)

export const useFormat = (): FormatPrefs => useContext(FormatContext)
