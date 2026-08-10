import type { AssuranceDimension, ExternalEvidenceAttachment, VerificationResult } from '../../../../shared/contracts/truth-kernel'
import { translateSessionEvidence, type SessionEvidenceLocale, type SessionEvidenceTranslationKey } from '../../../../shared/translation-contributions/session-evidence'

const dimensionKey = (dimension: AssuranceDimension['dimension']): SessionEvidenceTranslationKey | null =>
  dimension.startsWith('x-') ? null : `sessionEvidence.dimension.${dimension}` as SessionEvidenceTranslationKey

export function SessionEvidencePanel({ attachment, verification, locale, onConfirm }: { attachment: ExternalEvidenceAttachment; verification?: VerificationResult; locale: SessionEvidenceLocale; onConfirm?: () => void }) {
  const text = (key: SessionEvidenceTranslationKey) => translateSessionEvidence(locale, key)
  const stateLabel = (dimension: AssuranceDimension) => text(`sessionEvidence.assessment.${dimension.assessment}`)
  const title = text('sessionEvidence.title')
  return <section aria-label={title} className="min-w-0 space-y-2 overflow-auto">
    <h3 className="truncate text-sm font-medium" title={title}>{title}</h3>
    <dl className="space-y-1 text-xs" data-privacy={attachment.privacyState}>
      <div className="flex min-w-0 gap-2"><dt className="min-w-0 flex-1">{text('sessionEvidence.provider')}</dt><dd className="shrink-0">{attachment.externalProviderId}</dd></div>
      <div className="flex min-w-0 gap-2"><dt className="min-w-0 flex-1">{text('sessionEvidence.sourceVersion')}</dt><dd className="shrink-0">{attachment.sourceVersion}</dd></div>
      <div className="flex min-w-0 gap-2"><dt className="min-w-0 flex-1">{text('sessionEvidence.privacyState')}</dt><dd className="shrink-0">{attachment.privacyState}</dd></div>
      <div className="flex min-w-0 gap-2"><dt className="min-w-0 flex-1">{text('sessionEvidence.attachmentMethod')}</dt><dd className="shrink-0">{attachment.matchMethod}</dd></div>
    </dl>
    <dl className="space-y-1 text-xs">
      {attachment.assurance.map((dimension) => {
        const key = dimensionKey(dimension.dimension)
        const label = key ? text(key) : dimension.dimension
        return <div key={dimension.dimension} className="flex min-w-0 items-center gap-2"><dt className="min-w-0 flex-1 truncate" title={label}>{label}</dt><dd className="shrink-0">{stateLabel(dimension)}</dd></div>
      })}
    </dl>
    {verification && <p className="text-xs" data-verification={verification.status}>{text(verification.status === 'valid' ? 'sessionEvidence.verification.valid' : 'sessionEvidence.verification.invalid')}</p>}
    {attachment.confirmation === 'unconfirmed' && <button type="button" onClick={onConfirm} className="rounded border px-2 py-1 text-xs hover:bg-hover focus-visible:outline focus-visible:outline-2">{text('sessionEvidence.manualConfirm')}</button>}
  </section>
}
