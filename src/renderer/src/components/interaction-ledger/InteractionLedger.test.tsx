// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InteractionLedger } from './InteractionLedger'
import { INTERACTION_LEDGER_TRANSLATIONS, interactionLedgerTranslationContribution } from './translations'

afterEach(cleanup)

describe('InteractionLedger', () => {
  it('renders unavailable facts honestly and does not offer an empty evidence drill-down', () => {
    const onEvidence = vi.fn()
    render(<InteractionLedger onEvidence={onEvidence} interactions={[{
      schemaVersion: 1, interactionId: 'i', logicalSessionId: 's', ordinal: 1, modelCalls: [], toolCount: 0,
      timing: { wall: { milliseconds: { status: 'unavailable', reason: 'missing' }, measurement: 'unavailable', evidence: [] }, agentActive: { milliseconds: { status: 'unavailable', reason: 'missing' }, measurement: 'unavailable', evidence: [] }, wait: { milliseconds: { status: 'unavailable', reason: 'missing' }, measurement: 'unavailable', evidence: [] } },
      usageAttributions: [], branchUsageRollups: [], valuations: [], fileActions: [], toolEventIds: [], contextPhase: 'unknown', lineagePhase: 'unknown', forkBoundary: { status: 'unavailable', reason: 'missing' }
    }]} />)
    expect(screen.getByText(/Agent active: unavailable/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'View evidence (0)' }) as HTMLButtonElement).disabled).toBe(true)
    expect(onEvidence).not.toHaveBeenCalled()
  })

  it('collects timing, model, usage, rollup, valuation, file and fork evidence', () => {
    const onEvidence = vi.fn()
    const evidence = (evidenceId: string) => ({ evidenceId, sourceId: 'source', sourceKind: 'provider' as const, capturedAt: '2026-08-11T00:00:00.000Z', grade: 'A' as const, claim: 'wire-exact' as const })
    const base = evidence('timing')
    render(<InteractionLedger onEvidence={onEvidence} interactions={[{
      schemaVersion: 1, interactionId: 'i', logicalSessionId: 's', ordinal: 1,
      modelCalls: [{ providerId: 'openai', observedModelId: 'gpt', canonicalModelId: { status: 'available', value: 'gpt' }, mode: { status: 'available', value: 'agent' }, evidence: [evidence('model')] }], toolCount: 1,
      timing: { wall: { milliseconds: { status: 'available', value: 1000 }, measurement: 'exact', evidence: [base] }, agentActive: { milliseconds: { status: 'available', value: 800 }, measurement: 'exact', evidence: [base] }, wait: { milliseconds: { status: 'available', value: 200 }, measurement: 'exact', evidence: [base] } },
      usageAttributions: [{ schemaVersion: 1, usageAttributionId: 'u', interactionId: 'i', usageFactIds: ['fact'], billingFactIds: ['bill'], quantityKind: 'input-token', quantityUnit: 'token', quantity: { status: 'available', value: 10 }, measurement: 'exact', residual: { status: 'available', value: 0 }, sourceGranularity: 'per-call', lineageScope: 'physical-session', evidence: [evidence('usage')] }],
      branchUsageRollups: [{ schemaVersion: 1, rollupId: 'r', logicalSessionId: 's', quantityKind: 'input-token', quantityUnit: 'token', bases: ['physical-session-usage', 'current-branch-incremental-usage', 'lineage-unique-usage'].map((basis) => ({ basis, total: { status: 'available', value: 10 }, residual: { status: 'available', value: 0 }, billingFactIds: ['bill'] })) as never, sourceTotal: { status: 'available', value: 10 }, attributedTotal: { status: 'available', value: 10 }, anomalyRefs: [], evidence: [evidence('rollup')] }],
      valuations: [{ schemaVersion: 1, usageFactId: 'fact', rawModelId: 'gpt', officialPriceSnapshot: { status: 'unavailable', reason: 'missing' }, publicEquivalent: { status: 'available', value: { amount: 1, currency: 'USD', source: 'user-policy', policyRevisionId: { status: 'available', value: 'p:r1' } } }, actualContract: { status: 'available', value: { amount: 0.5, currency: 'USD', policyRevisionId: 'c:r1' } }, resolution: 'exact', evidence: [evidence('valuation')] }],
      fileActions: [{ schemaVersion: 1, fileActionId: 'f', interactionId: 'i', sourceEventId: 'event', operation: 'update', result: 'succeeded', target: { fileEntityId: 'entity', entityKind: 'file', scope: { rootId: { status: 'available', value: 'root' }, repositoryId: { status: 'available', value: 'repo' }, worktreeId: { status: 'available', value: 'wt' }, logicalPath: 'a.ts', originalPath: { status: 'available', value: 'a.ts' }, displayPath: 'a.ts' } }, beforeRevision: { status: 'unavailable', reason: 'missing' }, afterRevision: { status: 'unavailable', reason: 'missing' }, renameChain: [], producedArtifactVersions: [], derivation: 'observed', evidence: [evidence('file')] }],
      toolEventIds: ['tool'], contextPhase: 'unknown', lineagePhase: 'independent',
      forkBoundary: { status: 'available', value: { schemaVersion: 1, forkBoundaryId: 'fork', parentLogicalSessionId: { status: 'unavailable', reason: 'missing' }, childLogicalSessionId: 's', forkEventId: { status: 'available', value: 'fork-event' }, firstIndependentEventId: { status: 'available', value: 'event' }, sharedAncestorInteractionId: { status: 'unavailable', reason: 'missing' }, firstIndependentInteractionId: { status: 'available', value: 'i' }, sharedEventKeys: [], detection: 'harness-metadata', evidence: [evidence('fork')] } }
    }]} />)
    fireEvent.click(screen.getByRole('button', { name: 'View evidence (7)' }))
    expect(onEvidence).toHaveBeenCalledWith('i', ['model', 'timing', 'usage', 'rollup', 'valuation', 'file', 'fork'])
  })

  it('renders the same owned contract in Chinese and English without missing or unused keys', () => {
    const owned = [...interactionLedgerTranslationContribution.ownedKeys].sort()
    expect(Object.keys(interactionLedgerTranslationContribution.locales.en).sort()).toEqual(owned)
    expect(Object.keys(interactionLedgerTranslationContribution.locales.zh).sort()).toEqual(owned)
    expect(Object.keys(INTERACTION_LEDGER_TRANSLATIONS.en).sort()).toEqual(owned)
    expect(Object.keys(INTERACTION_LEDGER_TRANSLATIONS.zh).sort()).toEqual(owned)
    const { rerender } = render(<InteractionLedger locale="zh" interactions={[]} />)
    expect(screen.getByRole('heading', { name: '会话轨迹' })).toBeTruthy()
    expect(screen.getByText('暂无可用的交互事实。')).toBeTruthy()
    rerender(<InteractionLedger locale="en" interactions={[]} />)
    expect(screen.getByRole('heading', { name: 'Session trajectory' })).toBeTruthy()
    expect(screen.getByText('No interaction facts are available.')).toBeTruthy()
  })
})
