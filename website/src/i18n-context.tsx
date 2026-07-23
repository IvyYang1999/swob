import { createContext, useContext, useState, useCallback } from 'react'
import { type Locale, type Strings, setLocale, t, detectLocale } from './i18n'

interface I18nContextValue {
  locale: Locale
  strings: Strings
  switchLocale: (l: Locale) => void
}

const I18nContext = createContext<I18nContextValue>(null!)

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detectLocale)

  const switchLocale = useCallback((l: Locale) => {
    setLocale(l)
    setLocaleState(l)
    document.documentElement.lang = l === 'zh' ? 'zh-CN' : 'en'
  }, [])

  setLocale(locale)

  return (
    <I18nContext.Provider value={{ locale, strings: t(), switchLocale }}>
      {children}
    </I18nContext.Provider>
  )
}

export function useI18n() {
  return useContext(I18nContext)
}
