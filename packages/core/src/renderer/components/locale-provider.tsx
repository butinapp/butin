import { I18nProvider, type Locale } from '@butinapp/ui/i18n'
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

// Core owns locale state (an app-chrome concern); @butinapp/ui only defines the label contract + English
// default. This persists the choice and feeds the active locale to I18nProvider.
const STORAGE_KEY = 'butin-locale'

const initialLocale = (): Locale => {
  const saved = localStorage.getItem(STORAGE_KEY)

  if (saved === 'en' || saved === 'fr') {
    return saved
  }

  return navigator.language.toLowerCase().startsWith('fr') ? 'fr' : 'en'
}

interface LocaleSetting {
  locale: Locale
  setLocale: (locale: Locale) => void
}

const LocaleContext = createContext<LocaleSetting>({ locale: 'en', setLocale: () => undefined })

export const useLocaleSetting = (): LocaleSetting => useContext(LocaleContext)

export const LocaleProvider = ({ children }: { children: ReactNode }) => {
  const [locale, setLocaleState] = useState<Locale>(initialLocale)

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  const setLocale = (next: Locale): void => {
    localStorage.setItem(STORAGE_KEY, next)
    setLocaleState(next)
  }

  return (
    <LocaleContext.Provider value={{ locale, setLocale }}>
      <I18nProvider locale={locale}>{children}</I18nProvider>
    </LocaleContext.Provider>
  )
}
