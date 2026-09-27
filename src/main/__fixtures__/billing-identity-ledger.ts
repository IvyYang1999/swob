/**
 * Synthetic usage-ledger sessions for the billing-identity guards (F1m). Every
 * value is made up. They cover each branch of the usage-facts identity:
 * event_id (source, session, the audit stream that carried the copy, its dedup
 * key), billing_fact_id (source + billingFactKey, else the event_id),
 * occurred_at (a raw timestamp that parses, kept as written; else NULL) and
 * agent_scope (main; sidechain and subagent as subagent). The pinned values in
 * billing-identity.test.ts were derived from this fixture by usage-fact-store's
 * own private implementation before the rules moved to billing-identity.ts.
 */
import type { SessionSource, SessionSummary } from '../session-types'
import type { TokenAccounting, UsageEvent, UsageScope } from '../token-accounting'

interface CopySpec {
  dedupKey: string
  billingFactKey?: string
  auditSourceId?: string
  timestamp?: string
  scope?: UsageScope
  input: number
  output: number
}

function copy(provider: SessionSource, spec: CopySpec): UsageEvent {
  return {
    provider,
    providerFormatVersion: 'billing-identity-fixture-v1',
    dedupKey: spec.dedupKey,
    ...(spec.billingFactKey ? { billingFactKey: spec.billingFactKey } : {}),
    ...(spec.auditSourceId ? { auditSourceId: spec.auditSourceId } : {}),
    ...(spec.timestamp ? { timestamp: spec.timestamp } : {}),
    modelProvenance: 'unknown',
    providerProvenance: 'unknown',
    scope: spec.scope || 'main',
    counterKind: 'incremental',
    provenance: 'reported',
    components: {
      nonCachedInputTokens: spec.input,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      outputTokens: spec.output
    },
    semantics: provider === 'codex' ? 'openai-input-subset' : 'anthropic-disjoint',
    warnings: []
  }
}

function session(
  sessionId: string,
  source: SessionSource | undefined,
  provider: SessionSource,
  specs: CopySpec[]
): SessionSummary {
  const usageEvents = specs.map((spec) => copy(provider, spec))
  const input = specs.reduce((sum, spec) => sum + spec.input, 0)
  const output = specs.reduce((sum, spec) => sum + spec.output, 0)
  const main = specs.filter((spec) => (spec.scope || 'main') === 'main')
  const mainTotal = main.reduce((sum, spec) => sum + spec.input + spec.output, 0)
  const tokenAccounting: TokenAccounting = {
    provider,
    metricVersion: 2,
    provenance: 'reported',
    billingTotal: input + output,
    conversationOnly: mainTotal,
    components: {
      nonCachedInputTokens: input,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      outputTokens: output,
      reasoningTokens: 0
    },
    usageEvents,
    warnings: []
  }
  return {
    id: sessionId,
    sessionId,
    slug: sessionId,
    createdAt: '2026-07-20T00:00:00Z',
    updatedAt: '2026-07-22T00:00:00Z',
    messageCount: specs.length * 2,
    turnCount: main.length,
    compactCount: 0,
    cwds: [`/billing-identity/${sessionId}`],
    version: 'fixture',
    firstUserMessage: sessionId,
    toolUsage: {},
    skillInvocations: [],
    projectPath: `/billing-identity/${sessionId}`,
    filePath: `/billing-identity/${sessionId}.jsonl`,
    fileSizeBytes: 1,
    userImages: [],
    pastedImageCount: 0,
    tokenUsage: { inputTokens: input, outputTokens: output, cacheCreationTokens: 0, cacheReadTokens: 0 },
    tokenAccounting,
    providerOutcome: { detected: 'detected', parse: 'parsed', usage: 'available' },
    referencedFiles: [],
    configFiles: [],
    ...(source ? { source } : {})
  }
}

/** Five sessions, 13 usage copies; billing-identity.test.ts pins their ids. */
export function billingIdentityLedgerSessions(): SessionSummary[] {
  return [
    session('bi-claude-a', 'claude-code', 'claude-code', [
      { dedupKey: 'claude:message:msg_bi_1', billingFactKey: 'claude:message:msg_bi_1', timestamp: '2026-07-21T10:00:00.000Z', input: 100, output: 10 },
      { dedupKey: 'claude:request:req_bi_2', billingFactKey: 'claude:request:req_bi_2', timestamp: '2026-07-21T10:00:00Z', scope: 'sidechain', input: 200, output: 20 },
      { dedupKey: 'claude:uuid:bi-uuid-3', billingFactKey: 'claude:uuid:bi-uuid-3', timestamp: '2026-07-21T18:05:00+08:00', scope: 'subagent', input: 300, output: 30 },
      { dedupKey: 'claude:row:7', input: 40, output: 4 },
      { dedupKey: 'claude:message:msg_bi_5', billingFactKey: 'claude:message:msg_bi_5', timestamp: 'not-a-date', input: 50, output: 5 },
      { dedupKey: 'claude:message:msg_bi_6', billingFactKey: 'claude:message:msg_bi_6', auditSourceId: 'bi-audit-stream', timestamp: '2026-07-21T10:06:00Z', input: 60, output: 6 },
      { dedupKey: 'claude:message:消息-7', billingFactKey: 'claude:message:消息-7', timestamp: '2026-07-21T10:07:00Z', input: 70, output: 7 }
    ]),
    // Carries the same Claude call as bi-claude-a: same billing_fact_id, another event_id.
    session('bi-claude-b', 'claude-code', 'claude-code', [
      { dedupKey: 'claude:message:msg_bi_1', billingFactKey: 'claude:message:msg_bi_1', timestamp: '2026-07-21T10:00:00.000Z', input: 100, output: 10 },
      { dedupKey: 'claude:row:7', input: 41, output: 4 }
    ]),
    session('bi-codex', 'codex', 'codex', [
      { dedupKey: 'codex:total:bi-total-1', billingFactKey: 'codex:event:bi-turn-1:bi-last-1:bi-total-1', auditSourceId: 'bi-codex-child', timestamp: '2026-07-21T11:00:00.000Z', scope: 'subagent', input: 500, output: 50 },
      { dedupKey: 'codex:turn:bi-turn-2:bi-last-2', billingFactKey: 'codex:event:bi-turn-2:bi-last-2:no-total', timestamp: '2026-07-21T11:01:00.000Z', input: 600, output: 60 }
    ]),
    session('bi-opencode', 'opencode', 'opencode', [
      { dedupKey: 'opencode:aggregate', input: 700, output: 70 }
    ]),
    // No `source`: usageFactsForSession falls back to the ledger's provider.
    session('bi-no-source', undefined, 'claude-code', [
      { dedupKey: 'claude:message:msg_bi_8', billingFactKey: 'claude:message:msg_bi_8', timestamp: '2026-07-21T12:00:00.000Z', input: 80, output: 8 }
    ])
  ]
}
