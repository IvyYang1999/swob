import type { TranslationContributionDescriptor } from '../../../../shared/contracts/truth-kernel'
import en from './locales/en'
import zh from './locales/zh'

export type InteractionLedgerTranslationKey = keyof typeof en
export type InteractionLedgerLocale = 'en' | 'zh'

export const INTERACTION_LEDGER_TRANSLATIONS = { en, zh } as const

export const interactionLedgerTranslationContribution: TranslationContributionDescriptor = {
  schemaVersion: 1,
  featureId: 't211D-interaction-ledger',
  namespace: 'interactionLedger',
  locales: { en, zh },
  fallbackLocale: 'en',
  ownedKeys: Object.keys(en)
}

export function interactionLedgerTranslate(locale: InteractionLedgerLocale, key: InteractionLedgerTranslationKey): string {
  return INTERACTION_LEDGER_TRANSLATIONS[locale][key]
}
