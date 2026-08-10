import { useEffect, useState } from 'react'
import { useStore } from './store'
import {
  legacyJapaneseTranslations,
  resolveConfiguredLocale,
  resolveSystemLocale,
  translate,
  translations
} from '../../shared/i18n'
import { installMerge1Translations } from './integration/merge1-translations'

installMerge1Translations()

export type { LegacyLocale, Locale } from '../../shared/i18n'
export {
  legacyJapaneseTranslations,
  resolveConfiguredLocale,
  resolveSystemLocale,
  translate,
  translations
}

/** React hook: returns t() bound to the current locale. */
export function useT(): (key: string, params?: Record<string, string | number>) => string {
  const locale = useStore((state) => state.locale)
  return (key: string, params?: Record<string, string | number>) => translate(locale, key, params)
}

/** Locale for renderer entry points that do not mount the main Zustand store. */
export function useStandaloneLocale(): import('../../shared/i18n').Locale {
  const [locale, setLocale] = useState(() => resolveSystemLocale(
    navigator.languages?.length ? navigator.languages : [navigator.language]
  ))

  useEffect(() => {
    let active = true
    void Promise.all([window.api.getSystemLocale(), window.api.loadConfig()]).then(([systemLocale, config]) => {
      if (!active) return
      const resolved = resolveConfiguredLocale(config?.preferences?.locale, systemLocale)
      document.documentElement.lang = resolved
      setLocale(resolved)
    })
    return () => { active = false }
  }, [])

  return locale
}
