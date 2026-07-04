import { DEFAULT_FORMAT_PREFS, FormatProvider as UiFormatProvider, type FormatPrefs } from '@butinapp/ui/i18n'
import { useQuery } from '@tanstack/react-query'
import { type ReactNode } from 'react'

// Core owns the prefs source (IPC), @butinapp/ui owns the contract + defaults. Reads the ['settings'] query, so
// invalidating that key re-renders every formatted value with the new prefs.
export const FormatProvider = ({ children }: { children: ReactNode }) => {
  const { data } = useQuery({ queryKey: ['settings'], queryFn: () => window.butin.settings.get() })

  const prefs: FormatPrefs = data
    ? { currencyStyle: data.currencyStyle, dateFormat: data.dateFormat }
    : DEFAULT_FORMAT_PREFS

  return <UiFormatProvider value={prefs}>{children}</UiFormatProvider>
}
