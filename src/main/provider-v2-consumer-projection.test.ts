import { describe, expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import piGolden from '../../schema/fixtures/v2/pi-golden.json'
import type { SourceRef } from '../shared/provider-schema.generated'
import type { ParseChunk } from '../shared/provider-schema-v2.generated'
import { validateParseChunkV2 } from '../shared/provider-protocol-v2'
import { projectNativeV2ChunksForConsumers } from './provider-v2-consumer-projection'

describe('native v2 legacy-consumer projection', () => {
  it('uses context.summary.text and preserves a composite-directory project root', () => {
    const chunk = structuredClone(
      piGolden.envelopes.find((entry) => entry.kind === 'parse-chunk')!.payload
    ) as unknown as ParseChunk
    const summary = chunk.events[0]
    summary.kind = 'context.summary'
    summary.actor = 'system'
    summary.classification = 'lifecycle'
    summary.payload = { text: 'Synthetic compact summary', contextRevision: 1 }
    expect(validateParseChunkV2(chunk).ok).toBe(true)
    const projectRoot = '/synthetic/composite-project'
    const source: SourceRef = {
      kind: 'composite-directory',
      stableId: chunk.identity.physicalSourceId,
      providerId: chunk.providerId,
      rootUri: pathToFileURL(projectRoot).href,
      memberUris: [pathToFileURL(`${projectRoot}/summary.json`).href],
      displayLocator: projectRoot,
      fingerprint: chunk.fingerprint
    }

    const projected = projectNativeV2ChunksForConsumers(
      chunk.providerId,
      chunk.parserDataVersion,
      [source],
      [chunk]
    )[0]
    const session = projected.sessions[0].records.find((record) => record.recordType === 'session')
    const message = projected.sessions[0].records.find((record) => record.recordType === 'message')

    expect(session).toMatchObject({ projectPath: projectRoot })
    expect(message).toMatchObject({
      role: 'system',
      content: [{ kind: 'text', text: 'Synthetic compact summary' }]
    })
  })

  it('projects lifecycle metadata into title and cwd without rendering it as chat text', () => {
    const chunk = structuredClone(
      piGolden.envelopes.find((entry) => entry.kind === 'parse-chunk')!.payload
    ) as unknown as ParseChunk
    const template = chunk.events[0]
    chunk.events = [
      {
        ...structuredClone(template),
        id: 'synthetic-metadata-title',
        sharedEventKey: 'synthetic-metadata-title',
        sequence: 0,
        messageId: null,
        kind: 'session.lifecycle',
        actor: 'system',
        classification: 'lifecycle',
        visibility: 'hidden-noise',
        payload: { phase: 'metadata.title:Synthetic Antigravity conversation' }
      },
      {
        ...structuredClone(template),
        id: 'synthetic-metadata-cwd',
        sharedEventKey: 'synthetic-metadata-cwd',
        sequence: 1,
        messageId: null,
        kind: 'session.lifecycle',
        actor: 'system',
        classification: 'lifecycle',
        visibility: 'hidden-noise',
        payload: { phase: 'metadata.cwd:/workspace/synthetic-antigravity' }
      },
      {
        ...structuredClone(template),
        id: 'synthetic-user-message',
        sharedEventKey: 'synthetic-user-message',
        sequence: 2,
        messageId: 'synthetic-message',
        kind: 'message.text',
        actor: 'user',
        classification: 'user-content',
        visibility: 'primary',
        payload: { text: 'Only this event is visible.' }
      }
    ]
    chunk.done = true
    chunk.cursor = null
    expect(validateParseChunkV2(chunk).ok).toBe(true)
    const sourceRoot = '/synthetic/antigravity-data'
    const source: SourceRef = {
      kind: 'composite-directory',
      stableId: chunk.identity.physicalSourceId,
      providerId: chunk.providerId,
      rootUri: pathToFileURL(sourceRoot).href,
      memberUris: [pathToFileURL(`${sourceRoot}/transcript.jsonl`).href],
      displayLocator: sourceRoot,
      fingerprint: chunk.fingerprint
    }

    const projected = projectNativeV2ChunksForConsumers(
      chunk.providerId,
      chunk.parserDataVersion,
      [source],
      [chunk]
    )[0]
    const records = projected.sessions[0].records
    const session = records.find((record) => record.recordType === 'session')
    const messages = records.filter((record) => record.recordType === 'message')

    expect(session).toMatchObject({
      providerTitle: 'Synthetic Antigravity conversation',
      projectPath: '/workspace/synthetic-antigravity',
      cwd: ['/workspace/synthetic-antigravity']
    })
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ content: [{ kind: 'text', text: 'Only this event is visible.' }] })
  })

  it('preserves authoritative sequence when only some events have timestamp anchors', () => {
    const chunk = structuredClone(
      piGolden.envelopes.find((entry) => entry.kind === 'parse-chunk')!.payload
    ) as unknown as ParseChunk
    const template = chunk.events[0]
    chunk.events = [
      {
        ...structuredClone(template),
        id: 'synthetic-sequence-first',
        sharedEventKey: 'synthetic-sequence-first',
        sequence: 0,
        timestamp: '2026-08-01T00:00:00.000Z',
        messageId: 'synthetic-sequence-first-message',
        kind: 'message.text',
        actor: 'user',
        classification: 'user-content',
        visibility: 'primary',
        payload: { text: 'Timestamped pre-compaction event' }
      },
      {
        ...structuredClone(template),
        id: 'synthetic-sequence-second',
        sharedEventKey: 'synthetic-sequence-second',
        sequence: 1,
        timestamp: null,
        messageId: 'synthetic-sequence-second-message',
        kind: 'message.text',
        actor: 'assistant',
        classification: 'user-content',
        visibility: 'primary',
        payload: { text: 'Undated current event' }
      }
    ]
    chunk.done = true
    chunk.cursor = null
    expect(validateParseChunkV2(chunk).ok).toBe(true)
    const sourceRoot = '/synthetic/mixed-timestamp-project'
    const source: SourceRef = {
      kind: 'composite-directory',
      stableId: chunk.identity.physicalSourceId,
      providerId: chunk.providerId,
      rootUri: pathToFileURL(sourceRoot).href,
      memberUris: [pathToFileURL(`${sourceRoot}/chat_history.jsonl`).href],
      displayLocator: sourceRoot,
      fingerprint: chunk.fingerprint
    }

    const records = projectNativeV2ChunksForConsumers(
      chunk.providerId,
      chunk.parserDataVersion,
      [source],
      [chunk]
    )[0].sessions[0].records
    const messages = records.filter((record) => record.recordType === 'message')

    expect(messages.map((message) => message.content[0])).toEqual([
      { kind: 'text', text: 'Timestamped pre-compaction event' },
      { kind: 'text', text: 'Undated current event' }
    ])
  })
})
