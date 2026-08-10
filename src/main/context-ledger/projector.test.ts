import { describe, expect, it } from 'vitest'
import type { RawJsonlMessage } from '../types'
import { contextLedgerEvidenceGradeFixture } from './fixtures'
import { exportHistoricalContextLedger, projectHistoricalContextLedger } from './projector'
import { contextLedgerTranslationContribution } from './translation-contribution'

const base = (overrides: Partial<RawJsonlMessage>): RawJsonlMessage => ({
  uuid: 'event-1', parentUuid: null, sessionId: 'session-1', type: 'user', timestamp: '2026-08-11T00:00:00.000Z',
  message: { role: 'user', content: 'hello' }, ...overrides
})

describe('historical Context Ledger projector', () => {
  it('keeps provider-recorded context distinct from reported input and unknown residual', () => {
    const projection = projectHistoricalContextLedger([
      base({
        uuid: 'instruction',
        data: { contextLedger: {
          kind: 'instruction-file', evidenceGrade: 'B', content: 'never overwrite source',
          sourceUri: 'project://AGENTS.md', scope: 'project', trigger: 'session-start', visibleToModel: true
        } }
      }),
      base({
        uuid: 'request', type: 'assistant', requestId: 'request-1',
        message: { role: 'assistant', model: 'test-model', content: 'answer', usage: { input_tokens: 100, output_tokens: 4 } }
      })
    ], 'session-1')

    expect(projection.artifacts).toHaveLength(1)
    expect(projection.artifacts[0].evidence[0].grade).toBe('B')
    expect(projection.snapshots[0].reportedInputTokens).toEqual({ status: 'available', value: 100 })
    expect(projection.snapshots[0].accountedInputTokens.status).toBe('unknown')
    expect(projection.snapshots[0].unknownInputTokens).toEqual({ status: 'available', value: 100 })
    expect(projection.snapshots[0].coveragePercent).toEqual({ status: 'available', value: 0 })
    expect(exportHistoricalContextLedger(projection).contractVersion).toBe('1.0.0')
  })

  it('does not promote compact-looking user prose into provider-confirmed evidence', () => {
    const projection = projectHistoricalContextLedger([
      base({ uuid: 'before', type: 'assistant', message: { role: 'assistant', content: 'one', usage: { input_tokens: 10 } } }),
      base({ uuid: 'compact', message: { role: 'user', content: 'Compact summary: preserve the safety rule.' } }),
      base({ uuid: 'after', type: 'assistant', message: { role: 'assistant', content: 'two', usage: { input_tokens: 12 } } })
    ], 'session-1')

    expect(projection.artifacts).toEqual([])
    expect(projection.transitions[0].kind).toBe('request')
    expect(projection.transitions[0].deltas).toEqual([])
  })

  it('preserves ordered add/deferred, visible/loaded, and remove MCP history', () => {
    const ref = (evidenceId: string, at: string) => ({
      evidenceId, sourceId: 'wire-capture', sourceKind: 'runtime-capture' as const,
      logicalSessionId: 'session-1', capturedAt: at, effectiveAt: at, grade: 'A' as const,
      claim: 'wire-exact' as const
    })
    const projection = projectHistoricalContextLedger([], 'session-1', {
      contextArtifacts: [contextLedgerEvidenceGradeFixture().artifacts[1]],
      deferredToolsDeltas: [
        {
          schemaVersion: 1, deltaId: 'add', contextRevision: 1,
          addedToolNames: ['github/search'], removedToolNames: [], deferredSchemaToolNames: ['github/search'],
          evidence: [ref('add-evidence', '2026-08-11T00:00:01.000Z')]
        },
        {
          schemaVersion: 1, deltaId: 'remove', contextRevision: 3,
          addedToolNames: [], removedToolNames: ['github/search'], deferredSchemaToolNames: [],
          evidence: [ref('remove-evidence', '2026-08-11T00:00:03.000Z')]
        }
      ],
      toolSearchReceipts: [{
        schemaVersion: 1, receiptId: 'load', interactionId: 'interaction-1', query: 'search',
        visibleToolNames: ['github/search'], loadedSchemaToolNames: ['github/search'],
        effectiveAt: '2026-08-11T00:00:02.000Z', evidence: [ref('load-evidence', '2026-08-11T00:00:02.000Z')]
      }]
    })

    expect(projection.artifacts).toHaveLength(1)
    expect(projection.mcpExposures).toHaveLength(3)
    expect(projection.mcpExposures.map((entry) => ({
      id: entry.exposureId,
      visible: entry.toolNameVisible.state,
      at: entry.toolNameVisible.observedAt,
      schema: entry.schemaState,
      grade: entry.toolNameVisible.evidence[0]?.grade
    }))).toEqual([
      {
        id: 'mcp-exposure:deferred-tools:add:github/search', visible: 'observed-true',
        at: { status: 'available', value: '2026-08-11T00:00:01.000Z' }, schema: 'deferred', grade: 'A'
      },
      {
        id: 'mcp-exposure:tool-search:load:github/search', visible: 'observed-true',
        at: { status: 'available', value: '2026-08-11T00:00:02.000Z' }, schema: 'loaded', grade: 'A'
      },
      {
        id: 'mcp-exposure:deferred-tools:remove:github/search', visible: 'observed-false',
        at: { status: 'available', value: '2026-08-11T00:00:03.000Z' }, schema: 'unavailable', grade: 'A'
      }
    ])
  })

  it('removes the prior active injection for the same persisted artifact and emits a dropped delta', () => {
    const projection = projectHistoricalContextLedger([
      base({
        uuid: 'add', data: { contextLedger: {
          contextArtifactId: 'artifact-1', kind: 'instruction-file', operation: 'add', visibleToModel: true
        } }
      }),
      base({ uuid: 'before', type: 'assistant', message: { role: 'assistant', content: 'one', usage: { input_tokens: 10 } } }),
      base({
        uuid: 'remove', data: { contextLedger: {
          contextArtifactId: 'artifact-1', kind: 'instruction-file', operation: 'remove', visibleToModel: false
        } }
      }),
      base({ uuid: 'after', type: 'assistant', message: { role: 'assistant', content: 'two', usage: { input_tokens: 8 } } })
    ], 'session-1')

    expect(projection.snapshots[1].activeInjectionIds).toEqual([])
    expect(projection.transitions[0].deltas).toEqual(expect.arrayContaining([
      expect.objectContaining({ contextArtifactId: 'artifact-1', disposition: 'dropped' })
    ]))
  })

  it('does not turn an MCP call into instructions, name visibility, schema load, or result visibility', () => {
    const projection = projectHistoricalContextLedger([
      base({
        uuid: 'call', type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'mcp__github__search', id: 'call-1', input: {} }] }
      })
    ], 'session-1')
    expect(projection.mcpExposures).toHaveLength(1)
    const mcp = projection.mcpExposures[0]
    expect(mcp.called.state).toBe('observed-true')
    expect(mcp.serverInstructionsVisible.state).toBe('unknown')
    expect(mcp.toolNameVisible.state).toBe('unknown')
    expect(mcp.schemaState).toBe('unknown')
    expect(mcp.resultVisible.state).toBe('unknown')
  })

  it('never reads a current file or fabricates an E-grade historical artifact', () => {
    const projection = projectHistoricalContextLedger([
      base({ uuid: 'ordinary', message: { role: 'user', content: 'Please inspect the project.' } })
    ], 'session-1')
    expect(projection.artifacts).toEqual([])
    expect(projection.evidenceCounts.E).toBe(0)
  })

  it('exports a privacy-safe fixture for every A–E evidence grade', () => {
    const exported = exportHistoricalContextLedger(contextLedgerEvidenceGradeFixture())
    expect(exported.projection.evidenceCounts).toEqual({ A: 1, B: 1, C: 1, D: 1, E: 1 })
    expect(exported.projection.artifacts.find((artifact) => artifact.evidence[0].grade === 'E')?.effectiveAt.status).toBe('unknown')
  })

  it('publishes the frozen translation descriptor with exact en/zh key parity', () => {
    expect(contextLedgerTranslationContribution.schemaVersion).toBe(1)
    expect(Object.keys(contextLedgerTranslationContribution.locales)).toEqual(['en', 'zh'])
    expect(Object.keys(contextLedgerTranslationContribution.locales.en).sort()).toEqual(
      Object.keys(contextLedgerTranslationContribution.locales.zh).sort()
    )
    expect(Object.keys(contextLedgerTranslationContribution.locales.en).sort()).toEqual(
      [...contextLedgerTranslationContribution.ownedKeys].sort()
    )
  })
})
