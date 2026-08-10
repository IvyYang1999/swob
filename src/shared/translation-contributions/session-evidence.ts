import type { TranslationContributionDescriptor } from '../contracts/truth-kernel'

export type SessionEvidenceLocale = 'zh' | 'en'

export const SESSION_EVIDENCE_TRANSLATIONS = {
  schemaVersion: 1,
  featureId: 't211G-session-evidence',
  namespace: 'sessionEvidence',
  locales: {
    zh: {
      'sessionEvidence.title': '会话证据',
      'sessionEvidence.assessment.observed': '已观察',
      'sessionEvidence.assessment.verified': '已验证',
      'sessionEvidence.assessment.claimed': '来源声明',
      'sessionEvidence.assessment.unknown': '未知',
      'sessionEvidence.assessment.unsupported': '不支持',
      'sessionEvidence.verification.valid': '证据包验证通过',
      'sessionEvidence.verification.invalid': '证据包验证失败',
      'sessionEvidence.manualConfirm': '确认附着到此会话',
      'sessionEvidence.provider': '证据来源',
      'sessionEvidence.sourceVersion': '来源版本',
      'sessionEvidence.privacyState': '隐私状态',
      'sessionEvidence.attachmentMethod': '附着方式',
      'sessionEvidence.dimension.attachment-identity': '附着身份',
      'sessionEvidence.dimension.runtime-platform': '运行平台',
      'sessionEvidence.dimension.profile-policy': '配置策略',
      'sessionEvidence.dimension.network': '网络',
      'sessionEvidence.dimension.event-source-integrity': '事件源完整性',
      'sessionEvidence.dimension.attestation-external-commitment': '外部证明承诺',
      'sessionEvidence.dimension.filesystem-outcome': '文件系统结果',
      'sessionEvidence.dimension.rollback': '回滚',
      'sessionEvidence.dimension.completeness': '完整性'
    },
    en: {
      'sessionEvidence.title': 'Session evidence',
      'sessionEvidence.assessment.observed': 'Observed',
      'sessionEvidence.assessment.verified': 'Verified',
      'sessionEvidence.assessment.claimed': 'Claimed by source',
      'sessionEvidence.assessment.unknown': 'Unknown',
      'sessionEvidence.assessment.unsupported': 'Unsupported',
      'sessionEvidence.verification.valid': 'Evidence bundle verified',
      'sessionEvidence.verification.invalid': 'Evidence bundle verification failed',
      'sessionEvidence.manualConfirm': 'Confirm attachment to this session',
      'sessionEvidence.provider': 'Evidence provider',
      'sessionEvidence.sourceVersion': 'Source version',
      'sessionEvidence.privacyState': 'Privacy state',
      'sessionEvidence.attachmentMethod': 'Attachment method',
      'sessionEvidence.dimension.attachment-identity': 'Attachment identity',
      'sessionEvidence.dimension.runtime-platform': 'Runtime platform',
      'sessionEvidence.dimension.profile-policy': 'Profile policy',
      'sessionEvidence.dimension.network': 'Network',
      'sessionEvidence.dimension.event-source-integrity': 'Event-source integrity',
      'sessionEvidence.dimension.attestation-external-commitment': 'External attestation commitment',
      'sessionEvidence.dimension.filesystem-outcome': 'Filesystem outcome',
      'sessionEvidence.dimension.rollback': 'Rollback',
      'sessionEvidence.dimension.completeness': 'Completeness'
    }
  },
  fallbackLocale: 'en',
  ownedKeys: [
    'sessionEvidence.title', 'sessionEvidence.assessment.observed', 'sessionEvidence.assessment.verified',
    'sessionEvidence.assessment.claimed', 'sessionEvidence.assessment.unknown', 'sessionEvidence.assessment.unsupported',
    'sessionEvidence.verification.valid', 'sessionEvidence.verification.invalid', 'sessionEvidence.manualConfirm',
    'sessionEvidence.provider', 'sessionEvidence.sourceVersion', 'sessionEvidence.privacyState', 'sessionEvidence.attachmentMethod',
    'sessionEvidence.dimension.attachment-identity', 'sessionEvidence.dimension.runtime-platform',
    'sessionEvidence.dimension.profile-policy', 'sessionEvidence.dimension.network',
    'sessionEvidence.dimension.event-source-integrity', 'sessionEvidence.dimension.attestation-external-commitment',
    'sessionEvidence.dimension.filesystem-outcome', 'sessionEvidence.dimension.rollback', 'sessionEvidence.dimension.completeness'
  ]
} as const satisfies TranslationContributionDescriptor

export type SessionEvidenceTranslationKey = keyof typeof SESSION_EVIDENCE_TRANSLATIONS.locales.en

export function translateSessionEvidence(locale: SessionEvidenceLocale, key: SessionEvidenceTranslationKey): string {
  return SESSION_EVIDENCE_TRANSLATIONS.locales[locale][key]
}
