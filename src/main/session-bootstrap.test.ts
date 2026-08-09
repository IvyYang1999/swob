import { describe, expect, it, vi } from 'vitest'
import {
  additiveSessionPatch,
  beginSessionBootstrap,
  sessionSummaryForRenderer
} from './session-bootstrap'
import type { SessionSummary } from './types'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function summary(id: string): SessionSummary {
  return {
    id,
    sessionId: id,
    slug: '',
    createdAt: '2026-08-09T00:00:00Z',
    updatedAt: '2026-08-09T00:00:00Z',
    messageCount: 2,
    turnCount: 1,
    compactCount: 0,
    cwds: ['/workspace'],
    version: 'test',
    firstUserMessage: id,
    allUserMessages: `private-${id}`,
    toolUsage: {},
    skillInvocations: [],
    projectPath: '/workspace',
    filePath: `/sessions/${id}.jsonl`,
    fileSizeBytes: 1,
    userImages: [],
    pastedImageCount: 0,
    tokenUsage: { inputTokens: 1, outputTokens: 2, cacheCreationTokens: 0, cacheReadTokens: 0 },
    referencedFiles: [],
    configFiles: [],
    source: 'codex',
    tokenAccounting: {
      provider: 'codex',
      metricVersion: 2,
      provenance: 'reported',
      billingTotal: 3,
      conversationOnly: 3,
      components: {
        nonCachedInputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
        outputTokens: 2,
        reasoningTokens: 0
      },
      usageEvents: [{
        provider: 'codex',
        providerFormatVersion: 'test',
        provenance: 'reported',
        modelProvenance: 'response',
        providerProvenance: 'explicit',
        scope: 'main',
        counterKind: 'incremental',
        dedupKey: id,
        components: {
          nonCachedInputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          cacheWrite5mTokens: 0,
          cacheWrite1hTokens: 0,
          outputTokens: 2,
          reasoningTokens: 0
        },
        semantics: 'provider-specific',
        warnings: []
      }],
      warnings: []
    }
  }
}

describe('session bootstrap contract', () => {
  it('returns 1500 physical sessions without waiting for ten additive projections', async () => {
    const initial = Array.from({ length: 1_500 }, (_, index) => summary(`legacy-${index}`))
    const projected = Array.from({ length: 10 }, (_, index) => summary(`provider-${index}`))
    const completion = deferred<SessionSummary[]>()
    const loadInitial = vi.fn(async () => initial)
    const loadComplete = vi.fn(() => completion.promise)

    const bootstrap = await beginSessionBootstrap(loadInitial, loadComplete)

    expect(bootstrap.initial).toHaveLength(1_500)
    expect(loadInitial).toHaveBeenCalledOnce()
    expect(loadComplete).toHaveBeenCalledOnce()

    completion.resolve([...initial, ...projected])
    expect(additiveSessionPatch(initial, await bootstrap.completion)).toEqual(projected)
  })

  it('removes audit-heavy fields from renderer IPC without mutating main-process truth', () => {
    const source = summary('large-ledger')
    const projected = sessionSummaryForRenderer(source)

    expect(projected).not.toHaveProperty('allUserMessages')
    expect(projected.tokenAccounting).not.toHaveProperty('usageEvents')
    expect(projected.tokenAccounting).toMatchObject({ billingTotal: 3, conversationOnly: 3 })
    expect(source.allUserMessages).toBe('private-large-ledger')
    expect(source.tokenAccounting?.usageEvents).toHaveLength(1)
  })
})
