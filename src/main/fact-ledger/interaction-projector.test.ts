import { describe, expect, it } from 'vitest'
import type { CanonicalEvent } from '../../shared/provider-schema-v2.generated'
import { projectInteractionLedger, projectTrajectory } from './interaction-projector'

function event(overrides: Partial<CanonicalEvent>): CanonicalEvent {
  return {
    id: 'e1', identity: { physicalSourceId: 'source', logicalSessionKey: 'key', logicalSessionId: 'session', branchViewId: 'branch', parentBranchViewId: null }, sharedEventKey: 'shared', messageId: null, sequence: 1, messageBlockIndex: null, timestamp: '2026-08-11T00:00:00.000Z', actor: 'user', kind: 'message.text', payload: { text: 'go' }, visibility: 'primary', classification: 'user-content', timeline: { archived: true, modelContext: [] }, provenance: { providerId: 'codex', sourceRefId: 'source-ref', parserDataVersion: '1', formatVersion: '1', observedAt: '2026-08-11T00:00:00.000Z', sourceRecordId: 'record', rawRecordFingerprint: null }, rawRef: null, ...overrides
  }
}

describe('projectInteractionLedger', () => {
  it('uses actual user boundaries and preserves unknown time rather than estimating active/wait', () => {
    const ledger = projectInteractionLedger([
      event({ id: 'u1', sequence: 1 }),
      event({ id: 'artifact', sequence: 2, actor: 'tool', kind: 'artifact', payload: { uri: 'C:\\repo\\file.ts', action: 'edit', exists: true, fingerprint: null }, timestamp: '2026-08-11T00:00:02.000Z' }),
      event({ id: 'u2', sequence: 3, timestamp: null })
    ])
    expect(ledger.interactions).toHaveLength(2)
    expect(ledger.interactions[0].timing.wall.milliseconds).toEqual({ status: 'available', value: 2000 })
    expect(ledger.interactions[0].timing.agentActive.milliseconds.status).toBe('unavailable')
    expect(ledger.fileActions[0].target.scope.originalPath).toEqual({ status: 'available', value: 'C:\\repo\\file.ts' })
    expect(ledger.fileActions[0].afterRevision.status).toBe('unavailable')
    expect(projectTrajectory(ledger.interactions[0], ledger.usageAttributions, ledger.fileActions).forkBoundary.status).toBe('unavailable')
  })

  it('emits the complete usage shape and keeps cumulative source granularity visible', () => {
    const ledger = projectInteractionLedger([event({ id: 'usage', kind: 'usage', actor: 'assistant', payload: { eventId: 'usage', turnId: null, modelId: 'model', input: { total: 30, uncached: 10, cacheRead: 20, cacheWrite5m: null, cacheWrite1h: null }, output: { total: 4, visible: 4, reasoning: null }, providerTotal: 34, aggregation: 'cumulative', relations: { cacheRead: 'subset-of-input', cacheWrite: 'provider-defined', reasoning: 'subset-of-output' }, dedupKey: 'd', billingFactKey: 'b', measurement: { source: 'reported', confidence: 'exact', sourceField: 'usage' }, cost: null, priceRevision: null } })])
    expect(ledger.usageAttributions.map((row) => row.quantityKind)).toEqual(['input-token', 'output-token', 'cache-read-token', 'cache-write-token', 'reasoning-token', 'tool-token', 'non-token'])
    expect(ledger.usageAttributions.every((row) => row.sourceGranularity === 'cumulative-snapshot')).toBe(true)
    expect(ledger.interactions[0].modelCalls).toMatchObject([{ providerId: 'codex', observedModelId: 'model' }])
  })

  it('converts adjacent cumulative snapshots to deltas and conserves the authoritative total', () => {
    const usage = (id: string, sequence: number, input: number, cacheWrite5m: number, cacheWrite1h: number): CanonicalEvent => event({
      id, sequence, actor: 'assistant', kind: 'usage', payload: {
        eventId: id, turnId: null, modelId: 'model',
        input: { total: input, uncached: input, cacheRead: 0, cacheWrite5m, cacheWrite1h },
        output: { total: 0, visible: 0, reasoning: 0 }, providerTotal: input,
        aggregation: 'cumulative', relations: { cacheRead: 'subset-of-input', cacheWrite: 'provider-defined', reasoning: 'subset-of-output' },
        dedupKey: id, billingFactKey: 'session-total', measurement: { source: 'reported', confidence: 'exact', sourceField: 'usage' }, cost: null, priceRevision: null
      }
    })
    const ledger = projectInteractionLedger([
      event({ id: 'u1', sequence: 1 }), usage('usage-1', 2, 10, 2, 3),
      event({ id: 'u2', sequence: 3 }), usage('usage-2', 4, 15, 4, 5)
    ])
    const inputs = ledger.usageAttributions.filter((row) => row.quantityKind === 'input-token')
    expect(inputs.map((row) => row.quantity)).toEqual([{ status: 'available', value: 10 }, { status: 'available', value: 5 }])
    expect(inputs.reduce((sum, row) => sum + (row.quantity.status === 'available' ? row.quantity.value : 0), 0)).toBe(15)
    const writes = ledger.usageAttributions.filter((row) => row.quantityKind === 'cache-write-token')
    expect(writes.map((row) => row.quantity)).toEqual([{ status: 'available', value: 5 }, { status: 'available', value: 4 }])
    expect(ledger.branchUsageRollups.find((row) => row.quantityKind === 'input-token')).toMatchObject({ sourceTotal: { status: 'available', value: 15 }, attributedTotal: { status: 'available', value: 15 } })
  })

  it('records reset anomalies and preserves model, scoped revision, artifact and rename facts', () => {
    const ledger = projectInteractionLedger([
      event({ id: 'meta', kind: 'session.metadata', actor: 'system', sequence: 0, payload: { title: null, cwd: ['/repo'], projectPath: '/repo', rootId: 'root', repositoryId: 'repo', worktreeId: 'wt' } }),
      event({ id: 'model', kind: 'model.changed', actor: 'assistant', sequence: 1, payload: { fromModelId: null, toModelId: 'gpt-5' } }),
      event({ id: 'rename', kind: 'artifact', actor: 'tool', sequence: 2, payload: { uri: 'b.ts', action: 'rename', fromUri: 'a.ts', toUri: 'b.ts', beforeFingerprint: { algorithm: 'sha256', value: 'a'.repeat(64) }, afterFingerprint: { algorithm: 'sha256', value: 'b'.repeat(64) }, artifactId: 'artifact', version: '2' } })
    ])
    expect(ledger.interactions[0].modelCalls).toEqual([])
    expect(ledger.fileActions[0]).toMatchObject({ operation: 'rename', target: { scope: { rootId: { status: 'available', value: 'root' }, repositoryId: { status: 'available', value: 'repo' }, worktreeId: { status: 'available', value: 'wt' } } } })
    expect(ledger.fileActions[0].renameChain).toHaveLength(1)
    expect(ledger.fileActions[0].producedArtifactVersions).toHaveLength(1)
  })

  it('fails closed on cumulative resets and derives inherited/independent fork phases', () => {
    const usagePayload = (input: number) => ({ eventId: null, turnId: null, modelId: 'model', input: { total: input, uncached: input, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, output: { total: 0, visible: 0, reasoning: 0 }, providerTotal: input, aggregation: 'cumulative', relations: { cacheRead: 'subset-of-input', cacheWrite: 'provider-defined', reasoning: 'subset-of-output' }, dedupKey: `d-${input}`, billingFactKey: `b-${input}`, measurement: { source: 'reported', confidence: 'exact', sourceField: 'usage' }, cost: null, priceRevision: null })
    const childIdentity = { physicalSourceId: 'child-source', logicalSessionKey: 'child-key', logicalSessionId: 'child', branchViewId: 'child-branch', parentBranchViewId: 'parent-branch' }
    const ledger = projectInteractionLedger([
      event({ id: 'parent-shared', sequence: 1, sharedEventKey: 'shared-prefix' }),
      event({ id: 'child-shared', sequence: 2, identity: childIdentity, sharedEventKey: 'shared-prefix' }),
      event({ id: 'parent-usage-10', sequence: 3, sharedEventKey: 'shared-usage', actor: 'assistant', kind: 'usage', payload: usagePayload(10) }),
      event({ id: 'child-usage-10', sequence: 4, identity: childIdentity, sharedEventKey: 'shared-usage', actor: 'assistant', kind: 'usage', payload: usagePayload(10) }),
      event({ id: 'child-independent', sequence: 5, identity: childIdentity, sharedEventKey: 'independent' }),
      event({ id: 'child-usage-reset', sequence: 6, identity: childIdentity, actor: 'assistant', kind: 'usage', payload: usagePayload(5) })
    ])
    const childInteractions = ledger.interactions.filter((row) => row.logicalSessionId === 'child')
    expect(childInteractions.map((row) => row.lineagePhase)).toEqual(['shared-prefix', 'independent'])
    expect(ledger.forkBoundaries.find((row) => row.childLogicalSessionId === 'child')).toMatchObject({ detection: 'shared-event-key', firstIndependentEventId: { status: 'available', value: 'child-independent' } })
    expect(ledger.branchUsageRollups.find((row) => row.logicalSessionId === 'child' && row.quantityKind === 'input-token')?.anomalyRefs).toMatchObject([{ code: 'counter-reset', usageFactIds: ['child-usage-reset'] }])
  })
})
