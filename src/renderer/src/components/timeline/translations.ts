import type { TranslationContributionDescriptor } from '../../../../shared/contracts/truth-kernel'
import localeBundleText from './timeline.locale.json?raw'

export const T211B_TRANSLATION_KEYS = [
  'timeline.actor.user', 'timeline.message', 'timeline.thinking', 'timeline.redactedThinking',
  'timeline.redactedThinking.withheld', 'timeline.reasoning', 'timeline.tool.call',
  'timeline.tool.progress', 'timeline.tool.result', 'timeline.tool.error', 'timeline.tool.cancelled',
  'timeline.question', 'timeline.response', 'timeline.permission.requested', 'timeline.permission.named',
  'timeline.permission.response', 'timeline.permission.decision', 'timeline.compacted',
  'timeline.compacted.detail', 'timeline.compactSummary', 'timeline.modelChanged', 'timeline.modeChanged',
  'timeline.sessionMetadata', 'timeline.sessionLifecycle', 'timeline.subagentStarted',
  'timeline.subagent.progress', 'timeline.subagent.result',
  'timeline.artifactReference', 'timeline.rollback', 'timeline.usage', 'timeline.unknown',
  'timeline.unknownType', 'timeline.sequence', 'timeline.label', 'timeline.jump', 'timeline.collapse',
  'timeline.expand', 'timeline.persistedOutput', 'timeline.copy', 'timeline.export',
  'timeline.outputKind.image', 'timeline.outputKind.pdf', 'timeline.outputKind.document',
  'timeline.outputKind.structuredMedia', 'timeline.outputKind.toolOutput', 'timeline.outputKind.unknown',
  'timeline.contentState.available', 'timeline.contentState.missing',
  'timeline.contentState.outsideAllowedRoot', 'timeline.contentState.hashMismatch',
  'timeline.contentState.unavailable', 'timeline.bytes',
  'timeline.question.options', 'timeline.question.freeForm', 'timeline.question.submit',
  'timeline.question.historical', 'timeline.response.answers', 'timeline.permission.allow',
  'timeline.permission.deny', 'timeline.subagent.agent', 'timeline.subagent.parent',
  'doctor.label', 'doctor.description', 'doctor.discovery', 'doctor.discovery.found',
  'doctor.discovery.notFound', 'doctor.discovery.skipped', 'doctor.discovery.error',
  'doctor.domain.native', 'doctor.domain.wsl', 'doctor.domain.unknown', 'doctor.parser',
  'doctor.lastParsed', 'doctor.unknown', 'doctor.partial', 'doctor.resume', 'doctor.unavailable',
  'doctor.capability.exact', 'doctor.capability.derived', 'doctor.capability.estimated',
  'doctor.fixtures', 'doctor.format', 'doctor.adapter'
] as const

export type T211BLocale = 'en' | 'zh'
export type T211BTranslationKey = typeof T211B_TRANSLATION_KEYS[number]
export type T211BTranslator = (key: T211BTranslationKey, params?: Record<string, string | number>) => string

type T211BLocaleBundle = Record<T211BLocale, Record<T211BTranslationKey, string>>
export const T211B_LOCALE_BUNDLE = JSON.parse(localeBundleText) as T211BLocaleBundle

export const T211B_TRANSLATIONS: TranslationContributionDescriptor = {
  schemaVersion: 1,
  featureId: 't211B-agent-timeline',
  namespace: 'timeline',
  locales: T211B_LOCALE_BUNDLE,
  fallbackLocale: 'en',
  ownedKeys: [...T211B_TRANSLATION_KEYS]
}

export function createT211BTranslator(locale: T211BLocale = 'en'): T211BTranslator {
  return (key, params = {}) => {
    const template = T211B_LOCALE_BUNDLE[locale][key] ?? T211B_LOCALE_BUNDLE.en[key]
    return Object.entries(params).reduce(
      (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
      template
    )
  }
}
