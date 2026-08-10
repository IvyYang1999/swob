import { describe, expect, it } from 'vitest'
import { contextLedgerLabels, MERGE1_TRANSLATION_CONTRIBUTIONS, validateMerge1TranslationContributions } from './merge1-translations'

describe('t211I translation aggregation', () => {
  it('has matching, non-empty, non-duplicate locale bundles', () => {
    expect(() => validateMerge1TranslationContributions()).not.toThrow()
    expect(MERGE1_TRANSLATION_CONTRIBUTIONS).toHaveLength(5)
  })

  it('exposes every Context Ledger label in both locales', () => {
    expect(Object.values(contextLedgerLabels('en')).every(Boolean)).toBe(true)
    expect(Object.values(contextLedgerLabels('zh-CN')).every(Boolean)).toBe(true)
  })
})
