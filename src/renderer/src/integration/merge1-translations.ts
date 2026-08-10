import type { TranslationContributionDescriptor } from '../../../shared/contracts/truth-kernel'
import { translations, type Locale } from '../../../shared/i18n'
import { contextLedgerTranslationContribution } from '../../../main/context-ledger/translation-contribution'
import { catalogTranslationContribution } from '../../../shared/i18n-contributions/t211e-device-catalog'
import { SESSION_EVIDENCE_TRANSLATIONS } from '../../../shared/translation-contributions/session-evidence'
import { interactionLedgerTranslationContribution } from '../components/interaction-ledger/translations'
import { T211B_TRANSLATIONS } from '../components/timeline/translations'
import type { ContextLedgerLabels } from '../components/context-inspector/ContextLedgerPanel'

export const MERGE1_TRANSLATION_CONTRIBUTIONS: readonly TranslationContributionDescriptor[] = [
  T211B_TRANSLATIONS,
  contextLedgerTranslationContribution,
  interactionLedgerTranslationContribution,
  catalogTranslationContribution,
  SESSION_EVIDENCE_TRANSLATIONS
]

const globalKey = (descriptor: TranslationContributionDescriptor, key: string): string =>
  key.startsWith(`${descriptor.namespace}.`) ? key : `${descriptor.namespace}.${key}`

export function validateMerge1TranslationContributions(
  contributions: readonly TranslationContributionDescriptor[] = MERGE1_TRANSLATION_CONTRIBUTIONS
): void {
  const claimed = new Set<string>()
  for (const descriptor of contributions) {
    const owned = [...descriptor.ownedKeys].sort()
    const en = Object.keys(descriptor.locales.en).sort()
    const zh = Object.keys(descriptor.locales.zh).sort()
    if (JSON.stringify(owned) !== JSON.stringify(en) || JSON.stringify(owned) !== JSON.stringify(zh)) {
      throw new Error(`translation-locale-key-mismatch:${descriptor.featureId}`)
    }
    for (const key of owned) {
      const installedKey = globalKey(descriptor, key)
      if (claimed.has(installedKey)) throw new Error(`translation-key-duplicate:${installedKey}`)
      if (!descriptor.locales.en[key]?.trim() || !descriptor.locales.zh[key]?.trim()) {
        throw new Error(`translation-value-empty:${installedKey}`)
      }
      claimed.add(installedKey)
    }
  }
}

let installed = false

export function installMerge1Translations(): void {
  if (installed) return
  validateMerge1TranslationContributions()
  for (const descriptor of MERGE1_TRANSLATION_CONTRIBUTIONS) {
    for (const key of descriptor.ownedKeys) {
      const installedKey = globalKey(descriptor, key)
      const existingEn = translations.en[installedKey]
      const existingZh = translations['zh-CN'][installedKey]
      if ((existingEn && existingEn !== descriptor.locales.en[key]) ||
        (existingZh && existingZh !== descriptor.locales.zh[key])) {
        throw new Error(`translation-key-already-registered:${installedKey}`)
      }
      translations.en[installedKey] = descriptor.locales.en[key]
      translations['zh-CN'][installedKey] = descriptor.locales.zh[key]
    }
  }
  installed = true
}

const contextLabelNames: Array<keyof ContextLedgerLabels> = [
  'title', 'unknown', 'currentSnapshot', 'reportedInput', 'estimatedTokens',
  'introduced', 'preserved', 'summarized', 'dropped', 'mcpExposure',
  'configured', 'instructions', 'toolName', 'schema', 'called', 'result',
  'source', 'time', 'transition', 'trigger', 'operation', 'visibleToModel', 'evidence'
]

export function contextLedgerLabels(locale: Locale): ContextLedgerLabels {
  const bundle = contextLedgerTranslationContribution.locales[locale === 'zh-CN' ? 'zh' : 'en']
  return Object.fromEntries(contextLabelNames.map((name) => [name, bundle[name]])) as unknown as ContextLedgerLabels
}
