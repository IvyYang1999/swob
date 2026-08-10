import { describe, expect, it } from 'vitest'
import { SESSION_EVIDENCE_TRANSLATIONS, translateSessionEvidence } from '../../../../shared/translation-contributions/session-evidence'

describe('session evidence translation contribution', () => {
  it('has complete and identical zh/en ownership with no unused keys', () => {
    const owned = [...SESSION_EVIDENCE_TRANSLATIONS.ownedKeys].sort()
    expect(Object.keys(SESSION_EVIDENCE_TRANSLATIONS.locales.zh).sort()).toEqual(owned)
    expect(Object.keys(SESSION_EVIDENCE_TRANSLATIONS.locales.en).sort()).toEqual(owned)
    for (const key of SESSION_EVIDENCE_TRANSLATIONS.ownedKeys) {
      expect(translateSessionEvidence('zh', key)).not.toBe('')
      expect(translateSessionEvidence('en', key)).not.toBe('')
    }
  })
})
