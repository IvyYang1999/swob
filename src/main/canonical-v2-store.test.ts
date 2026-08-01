import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { CanonicalEvent, ParseChunk, SessionIdentity } from '../shared/provider-schema-v2.generated'
import { ProviderChunkAssembler } from '../shared/provider-protocol-v2'
import { renderCanonicalEventPage } from './canonical-v2-projection'
import { CanonicalSessionStore } from './canonical-store'

const temporaryRoots: string[] = []

const identity: SessionIdentity = {
  physicalSourceId: 'synthetic:100k',
  logicalSessionKey: 'v1\u0000example/load\u0000named\u0000fixture\u0000session-100k',
  logicalSessionId: 'session-100k',
  branchViewId: 'branch:main',
  parentBranchViewId: null
}

function event(sequence: number): CanonicalEvent {
  return {
    id: `event:${sequence}`,
    identity,
    sharedEventKey: `shared:${sequence}`,
    messageId: `message:${Math.floor(sequence / 4)}`,
    sequence,
    messageBlockIndex: sequence % 4,
    timestamp: null,
    actor: sequence % 2 === 0 ? 'user' : 'assistant',
    kind: 'message.text',
    payload: { text: `synthetic-event-${sequence}` },
    visibility: 'primary',
    classification: 'user-content',
    timeline: {
      archived: true,
      modelContext: [{ contextRevision: 0, state: 'visible-to-model', fromSequence: sequence, untilSequence: null }]
    },
    provenance: {
      providerId: 'example/load',
      sourceRefId: identity.physicalSourceId,
      parserDataVersion: '2',
      formatVersion: 'synthetic-v1',
      observedAt: null,
      sourceRecordId: `row:${sequence}`,
      rawRecordFingerprint: null
    },
    rawRef: null
  }
}

function chunk(chunkIndex: number, size: number, total: number): ParseChunk {
  const start = chunkIndex * size
  const count = Math.min(size, total - start)
  const done = start + count === total
  return {
    providerId: 'example/load',
    parserDataVersion: '2',
    formatVersion: 'synthetic-v1',
    fingerprint: { algorithm: 'sha256', value: 'synthetic-100k' },
    identity,
    mode: 'replace',
    chunkIndex,
    previousCursor: chunkIndex === 0 ? null : `cursor:${chunkIndex - 1}`,
    cursor: done ? null : `cursor:${chunkIndex}`,
    done,
    events: Array.from({ length: count }, (_, offset) => event(start + offset)),
    diagnostics: []
  }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('Canonical v2 分片存储', () => {
  it('100k events 完整走通 parse → store → 分页 render，不受 v1 10k 限制', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-canonical-v2-100k-'))
    temporaryRoots.push(root)
    const store = new CanonicalSessionStore(path.join(root, 'canonical.db'))
    const assembler = new ProviderChunkAssembler()
    const total = 100_000
    const chunkSize = 1_000

    for (let index = 0; index < total / chunkSize; index++) {
      const next = chunk(index, chunkSize, total)
      assembler.accept(next)
      store.applyParseChunkV2(next)
    }

    expect(assembler.completedSessions()).toBe(1)
    expect(store.getV2Session(identity.logicalSessionKey, identity.branchViewId)).toMatchObject({
      complete: true,
      eventCount: total
    })
    let rendered = 0
    let afterSequence: number | null = null
    do {
      const page = store.readV2EventPage(identity.logicalSessionKey, identity.branchViewId, {
        afterSequence,
        limit: 2_048
      })
      const view = renderCanonicalEventPage(page.events)
      rendered += view.length
      afterSequence = page.nextSequence
    } while (afterSequence !== null)

    expect(rendered).toBe(total)
    store.close()
  }, 30_000)

  it('append 传输保留既有事件，只从当前 sequence 增量提交', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-canonical-v2-append-'))
    temporaryRoots.push(root)
    const store = new CanonicalSessionStore(path.join(root, 'canonical.db'))
    const initial = chunk(0, 2, 2)
    store.applyParseChunkV2(initial)

    const append: ParseChunk = {
      ...initial,
      fingerprint: { algorithm: 'sha256', value: 'synthetic-append' },
      mode: 'append',
      events: [event(2)]
    }
    const assembler = new ProviderChunkAssembler()
    expect(assembler.accept(append)).toEqual({ acceptedEvents: 1, done: true })
    store.applyParseChunkV2(append)

    expect(store.getV2Session(identity.logicalSessionKey, identity.branchViewId)).toMatchObject({
      complete: true,
      eventCount: 3,
      fingerprint: { value: 'synthetic-append' }
    })
    expect(store.readV2EventPage(identity.logicalSessionKey, identity.branchViewId).events.map((item) => item.id))
      .toEqual(['event:0', 'event:1', 'event:2'])
    store.close()
  })
})
