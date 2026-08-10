import { createRoot } from 'react-dom/client'
import type { EvidenceRef, InteractionTrajectoryReadModel } from '../../../../shared/contracts/truth-kernel'
import { InteractionLedger } from './InteractionLedger'

const unavailable = <T,>(reason: string) => ({ status: 'unavailable' as const, reason })
const evidence = (ordinal: number, fact: string): EvidenceRef => ({
  evidenceId: `fixture-${ordinal}:${fact}`, sourceId: 'canonical-fixture', sourceKind: 'provider', providerId: 'codex',
  logicalSessionId: 'fixture-session', sourceEventId: `event-${ordinal}:${fact}`,
  capturedAt: '2026-08-11T00:00:00.000Z', grade: 'A', claim: 'wire-exact'
})

const interaction = (ordinal: number): InteractionTrajectoryReadModel => {
  const eventEvidence = evidence(ordinal, 'event')
  return {
    schemaVersion: 1, interactionId: `fixture-${ordinal}`, logicalSessionId: 'fixture-session', ordinal,
    modelCalls: [{ providerId: 'openai', observedModelId: 'gpt-5', canonicalModelId: { status: 'available', value: 'gpt-5' }, mode: { status: 'available', value: 'agent' }, evidence: [evidence(ordinal, 'model')] }],
    toolCount: 12,
    timing: {
      wall: { milliseconds: { status: 'available', value: 12_345 }, measurement: 'exact', evidence: [evidence(ordinal, 'wall')] },
      agentActive: { milliseconds: { status: 'available', value: 9_500 }, measurement: 'exact', evidence: [evidence(ordinal, 'active')] },
      wait: { milliseconds: { status: 'available', value: 2_845 }, measurement: 'derived', evidence: [evidence(ordinal, 'wait')] }
    },
    usageAttributions: [{
      schemaVersion: 1, usageAttributionId: `usage-${ordinal}`, interactionId: `fixture-${ordinal}`,
      usageFactIds: ['fact'], billingFactIds: ['bill'], quantityKind: 'input-token', quantityUnit: 'token',
      quantity: { status: 'available', value: 1_234_567 }, measurement: 'derived', residual: { status: 'available', value: 0 },
      sourceGranularity: 'cumulative-snapshot', lineageScope: 'physical-session', evidence: [evidence(ordinal, 'usage')]
    }],
    branchUsageRollups: [{
      schemaVersion: 1, rollupId: `rollup-${ordinal}`, logicalSessionId: 'fixture-session', quantityKind: 'input-token', quantityUnit: 'token',
      bases: [
        { basis: 'physical-session-usage', total: { status: 'available', value: 1_234_567 }, residual: { status: 'available', value: 0 }, billingFactIds: ['bill'] },
        { basis: 'current-branch-incremental-usage', total: { status: 'available', value: 234_567 }, residual: { status: 'available', value: 0 }, billingFactIds: ['bill'] },
        { basis: 'lineage-unique-usage', total: { status: 'available', value: 1_100_000 }, residual: { status: 'available', value: 0 }, billingFactIds: ['bill'] }
      ],
      sourceTotal: { status: 'available', value: 1_234_567 }, attributedTotal: { status: 'available', value: 1_234_567 }, anomalyRefs: [], evidence: [evidence(ordinal, 'rollup')]
    }],
    valuations: [{
      schemaVersion: 1, usageFactId: `fact-${ordinal}`, rawModelId: 'gpt-5',
      officialPriceSnapshot: { status: 'available', value: { snapshotId: 'official', revision: '2026-08', digest: 'a'.repeat(64) } },
      publicEquivalent: { status: 'available', value: { amount: 2.345678, currency: 'USD', source: 'official-snapshot', policyRevisionId: unavailable('official-snapshot-used') } },
      actualContract: { status: 'available', value: { amount: 1.234567, currency: 'USD', policyRevisionId: 'contract:r2' } },
      resolution: 'exact', evidence: [evidence(ordinal, 'valuation')]
    }],
    fileActions: [{
      schemaVersion: 1, fileActionId: `file-${ordinal}`, interactionId: `fixture-${ordinal}`, sourceEventId: 'event', operation: 'rename', result: 'succeeded',
      target: { fileEntityId: 'entity-new', entityKind: 'file', scope: { rootId: { status: 'available', value: 'root' }, repositoryId: { status: 'available', value: 'repo' }, worktreeId: { status: 'available', value: 'worktree' }, logicalPath: 'src/new.ts', originalPath: { status: 'available', value: '/very/long/repository/path/with/a/deeply/nested/directory/and/a-file-with-an-intentionally-long-name.ts' }, displayPath: '/very/long/repository/path/with/a/deeply/nested/directory/and/a-file-with-an-intentionally-long-name.ts' } },
      beforeRevision: unavailable('before-hash-not-exposed'),
      afterRevision: { status: 'available', value: { fileRevisionId: 'revision', fileEntityId: 'entity-new', contentDigest: { status: 'available', value: 'b'.repeat(64) }, observedAt: { status: 'available', value: '2026-08-11T00:00:00.000Z' } } },
      renameChain: [], producedArtifactVersions: [{ schemaVersion: 1, artifactVersionId: 'artifact:v2', artifactId: 'artifact', contentDigest: { status: 'available', value: 'c'.repeat(64) }, sourceVersion: { status: 'available', value: '2' }, evidence: [eventEvidence] }],
      derivation: 'observed', evidence: [eventEvidence]
    }],
    toolEventIds: ['tool'], contextPhase: 'preserved', lineagePhase: ordinal === 1 ? 'inherited' : 'independent',
    forkBoundary: { status: 'available', value: { schemaVersion: 1, forkBoundaryId: 'fork', parentLogicalSessionId: unavailable('parent-id-not-exposed'), childLogicalSessionId: 'fixture-session', forkEventId: { status: 'available', value: 'fork-event' }, firstIndependentEventId: { status: 'available', value: 'event-2' }, sharedAncestorInteractionId: { status: 'available', value: 'fixture-1' }, firstIndependentInteractionId: { status: 'available', value: 'fixture-2' }, sharedEventKeys: ['shared'], detection: 'shared-event-key', evidence: [evidence(ordinal, 'fork')] } }
  }
}

const locale = new URLSearchParams(location.search).get('locale') === 'zh' ? 'zh' : 'en'
createRoot(document.getElementById('root')!).render(<InteractionLedger locale={locale} interactions={[interaction(1), interaction(2), interaction(3)]} />)
