import { describe, expect, it } from 'vitest'
import {
  legacyJapaneseTranslations,
  resolveConfiguredLocale,
  resolveSystemLocale,
  translate,
  translations
} from './i18n'

describe('i18n locale resolution', () => {
  it.each(['zh-CN', 'zh-TW', 'zh-HK', 'zh-Hant-TW'])('%s resolves to simplified Chinese', (tag) => {
    expect(resolveSystemLocale([tag])).toBe('zh-CN')
  })

  it.each(['en-US', 'de-DE', 'ja-JP'])('%s resolves to English', (tag) => {
    expect(resolveSystemLocale([tag])).toBe('en')
  })

  it('uses the primary preferred language and handles an empty list', () => {
    expect(resolveSystemLocale(['en-US', 'zh-CN'])).toBe('en')
    expect(resolveSystemLocale([])).toBe('en')
  })

  it('honors a saved supported locale and retires the legacy Japanese preference', () => {
    expect(resolveConfiguredLocale('en', 'zh-CN')).toBe('en')
    expect(resolveConfiguredLocale('zh-CN', 'en')).toBe('zh-CN')
    expect(resolveConfiguredLocale(undefined, 'zh-CN')).toBe('zh-CN')
    expect(resolveConfiguredLocale('ja', 'zh-CN')).toBe('en')
  })
})

describe('i18n dictionary', () => {
  it('keeps active Chinese and English dictionaries in parity', () => {
    expect(Object.keys(translations['zh-CN']).sort()).toEqual(Object.keys(translations.en).sort())
  })

  it('interpolates values and falls back to the key', () => {
    expect(translate('zh-CN', 'sidebar.days_ago', { n: 3 })).toBe('3天前')
    expect(translate('en', 'missing.key')).toBe('missing.key')
  })

  it('retains Japanese only as an inactive migration skeleton', () => {
    expect(legacyJapaneseTranslations['settings.title']).toBe('設定')
    expect(Object.keys(translations)).toEqual(['zh-CN', 'en'])
  })
})
