import type { Availability, EvidenceRef, InteractionTrajectoryReadModel } from '../../../../shared/contracts/truth-kernel'
import type { ReactElement } from 'react'
import { interactionLedgerTranslate, type InteractionLedgerLocale, type InteractionLedgerTranslationKey } from './translations'

export interface InteractionLedgerProps {
  interactions: readonly InteractionTrajectoryReadModel[]
  onEvidence?: (interactionId: string, evidenceIds: readonly string[]) => void
  locale?: InteractionLedgerLocale
}

function duration(value: InteractionTrajectoryReadModel['timing']['wall']['milliseconds'], t: (key: InteractionLedgerTranslationKey) => string): string {
  return value.status === 'available' ? `${(value.value / 1000).toFixed(1)}s` : t(`interactionLedger.state.${value.status}`)
}

function factValue(status: 'available' | 'unavailable' | 'unknown', value: number | undefined, t: (key: InteractionLedgerTranslationKey) => string): string {
  return status === 'available' && value !== undefined ? String(value) : t(`interactionLedger.state.${status}`)
}

function grade(evidence: readonly EvidenceRef[], t: (key: InteractionLedgerTranslationKey) => string): string {
  return evidence.length > 0 ? `${t('interactionLedger.grade')} ${evidence.map((row) => row.grade).sort()[0]}` : `${t('interactionLedger.grade')} ${t('interactionLedger.state.unavailable')}`
}

function revision(value: Availability<{ contentDigest: Availability<string> }>, t: (key: InteractionLedgerTranslationKey) => string): string {
  if (value.status !== 'available' || value.value.contentDigest.status !== 'available') return t(`interactionLedger.state.${value.status}`)
  return value.value.contentDigest.value.slice(0, 12)
}

function valuationAmount(value: Availability<{ amount: number; currency: string }>, t: (key: InteractionLedgerTranslationKey) => string): string {
  return value.status === 'available' ? `${value.value.amount.toFixed(6)} ${value.value.currency}` : t(`interactionLedger.state.${value.status}`)
}

export function InteractionLedger({ interactions, onEvidence, locale = 'en' }: InteractionLedgerProps): ReactElement {
  const t = (key: InteractionLedgerTranslationKey) => interactionLedgerTranslate(locale, key)
  return <section aria-label={t('interactionLedger.title')} className="interaction-ledger">
    <h2>{t('interactionLedger.title')}</h2>
    {interactions.length === 0 ? <p>{t('interactionLedger.empty')}</p> : <ol>
      {interactions.map((interaction) => {
        const evidence = [
          ...interaction.modelCalls.flatMap((entry) => entry.evidence),
          ...Object.values(interaction.timing).flatMap((entry) => entry.evidence),
          ...interaction.usageAttributions.flatMap((entry) => entry.evidence),
          ...interaction.branchUsageRollups.flatMap((entry) => entry.evidence),
          ...interaction.valuations.flatMap((entry) => entry.evidence),
          ...interaction.fileActions.flatMap((entry) => [
            ...entry.evidence,
            ...entry.renameChain.flatMap((step) => step.evidence),
            ...entry.producedArtifactVersions.flatMap((artifact) => artifact.evidence)
          ]),
          ...(interaction.forkBoundary.status === 'available' ? interaction.forkBoundary.value.evidence : [])
        ]
        const evidenceIds = [...new Set(evidence.map((entry) => entry.evidenceId))]
        return <li key={interaction.interactionId} data-testid={`interaction-${interaction.ordinal}`}>
          <header><strong>{t('interactionLedger.round')} {interaction.ordinal}</strong> <span>{t('interactionLedger.wall')} {duration(interaction.timing.wall.milliseconds, t)} ({interaction.timing.wall.measurement}; {grade(interaction.timing.wall.evidence, t)})</span></header>
          <p>{t('interactionLedger.active')}: {duration(interaction.timing.agentActive.milliseconds, t)} ({interaction.timing.agentActive.measurement}; {grade(interaction.timing.agentActive.evidence, t)}) · {t('interactionLedger.wait')}: {duration(interaction.timing.wait.milliseconds, t)} ({interaction.timing.wait.measurement}; {grade(interaction.timing.wait.evidence, t)}) · {t('interactionLedger.tools')}: {interaction.toolCount}</p>
          <ul aria-label={`${t('interactionLedger.models')} ${interaction.ordinal}`}>{interaction.modelCalls.map((model) => <li key={`${model.providerId}:${model.observedModelId}`}>{model.providerId}/{model.observedModelId} · {grade(model.evidence, t)}</li>)}</ul>
          <ul aria-label={`${t('interactionLedger.usage')} ${interaction.ordinal}`}>{interaction.usageAttributions.map((usage) => <li key={usage.usageAttributionId}>{t(`interactionLedger.quantity.${usage.quantityKind}`)}: {factValue(usage.quantity.status, usage.quantity.status === 'available' ? usage.quantity.value : undefined, t)} {t(`interactionLedger.unit.${usage.quantityUnit}`)} ({t(`interactionLedger.measurement.${usage.measurement}`)}; {grade(usage.evidence, t)})</li>)}</ul>
          <ul aria-label={`${t('interactionLedger.rollups')} ${interaction.ordinal}`}>{interaction.branchUsageRollups.flatMap((rollup) => rollup.bases.map((basis) => <li key={`${rollup.rollupId}:${basis.basis}`}>{t(`interactionLedger.basis.${basis.basis}`)} · {t(`interactionLedger.quantity.${rollup.quantityKind}`)}: {factValue(basis.total.status, basis.total.status === 'available' ? basis.total.value : undefined, t)}</li>))}</ul>
          <ul aria-label={`${t('interactionLedger.files')} ${interaction.ordinal}`}>{interaction.fileActions.map((action) => <li key={action.fileActionId}>{t(`interactionLedger.operation.${action.operation}`)}: {action.target.scope.displayPath} ({t(`interactionLedger.result.${action.result}`)}; {t('interactionLedger.fileRevision')} {revision(action.afterRevision, t)}; {t('interactionLedger.artifacts')} {action.producedArtifactVersions.length}; {grade(action.evidence, t)})</li>)}</ul>
          <ul aria-label={`${t('interactionLedger.valuationGroup')} ${interaction.ordinal}`}>{interaction.valuations.map((valuation) => <li key={valuation.usageFactId}>{t('interactionLedger.valuation')}: {t(`interactionLedger.state.${valuation.resolution}`)} · {t('interactionLedger.public')} {valuationAmount(valuation.publicEquivalent, t)} · {t('interactionLedger.contract')} {valuationAmount(valuation.actualContract, t)} · {grade(valuation.evidence, t)}</li>)}</ul>
          <p>{t('interactionLedger.fork')}: {t(`interactionLedger.lineage.${interaction.lineagePhase}`)}{interaction.forkBoundary.status === 'available' ? ` · ${interaction.forkBoundary.value.detection} · ${grade(interaction.forkBoundary.value.evidence, t)}` : ` · ${t('interactionLedger.state.unavailable')}`}</p>
          <button type="button" disabled={evidenceIds.length === 0} onClick={() => onEvidence?.(interaction.interactionId, evidenceIds)}>{t('interactionLedger.evidence')} ({evidenceIds.length})</button>
        </li>
      })}
    </ol>}
  </section>
}
