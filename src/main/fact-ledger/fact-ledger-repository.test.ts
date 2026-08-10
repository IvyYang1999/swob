import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CanonicalEvent } from '../../shared/provider-schema-v2.generated'
import { openFactLedgerRepository } from './fact-ledger-repository'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

function event(sequence: number): CanonicalEvent {
  return {
    id: `e-${sequence}`,
    identity: { physicalSourceId: 'source', logicalSessionKey: 'key', logicalSessionId: 'session', branchViewId: 'branch', parentBranchViewId: null },
    sharedEventKey: `shared-${sequence}`, messageId: null, sequence, messageBlockIndex: null,
    timestamp: new Date(sequence * 1000).toISOString(), actor: sequence % 2 ? 'user' : 'assistant',
    kind: 'message.text', payload: { text: 'event' }, visibility: 'primary', classification: 'user-content',
    timeline: { archived: true, modelContext: [] },
    provenance: { providerId: 'codex', sourceRefId: 'source-ref', parserDataVersion: '1', formatVersion: '1', observedAt: new Date(0).toISOString(), sourceRecordId: `record-${sequence}`, rawRecordFingerprint: null },
    rawRef: null
  }
}

describe('fact ledger repository', () => {
  it('rebuilds 10k events and resumes from an atomic durable checkpoint', () => {
    const dir = mkdtempSync(join(tmpdir(), 'swob-fact-ledger-'))
    dirs.push(dir)
    const databasePath = join(dir, 'ledger.db')
    const repo = openFactLedgerRepository(databasePath)
    const rebuilt = repo.rebuild(Array.from({ length: 10_000 }, (_, index) => event(index + 1)))
    expect(rebuilt.checkpoint).toMatchObject({ eventCount: 10_000, lastSequence: 10_000, lastEventId: 'e-10000' })
    repo.close()

    const resumed = openFactLedgerRepository(databasePath)
    expect(resumed.read().checkpoint.eventCount).toBe(10_000)
    expect(resumed.append([event(10_001)]).checkpoint).toMatchObject({ eventCount: 10_001, lastSequence: 10_001 })
    resumed.close()
  }, 15_000)
})
