import { describe, expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import piGolden from '../../schema/fixtures/v2/pi-golden.json'
import type { SourceRef } from '../shared/provider-schema.generated'
import type { ParseChunk, UsageRecord } from '../shared/provider-schema-v2.generated'
import { validateParseChunkV2 } from '../shared/provider-protocol-v2'
import { canonicalRecordsToSessionSummary } from './canonical-projection'
import { projectNativeV2ChunksForConsumers } from './provider-v2-consumer-projection'

describe('native v2 legacy-consumer projection', () => {
  it('does not miscount projected lifecycle text as context compaction', () => {
    const chunk = structuredClone(
      piGolden.envelopes.find((entry) => entry.kind === 'parse-chunk')!.payload
    ) as unknown as ParseChunk
    const template = chunk.events[0]
    chunk.events = [
      {
        ...structuredClone(template),
        id: 'synthetic-lifecycle', sharedEventKey: 'synthetic-lifecycle', sequence: 0,
        messageId: null, kind: 'session.lifecycle', actor: 'system', classification: 'lifecycle',
        visibility: 'collapsed', payload: { phase: 'turn.cancelled' }
      },
      {
        ...structuredClone(template),
        id: 'synthetic-summary', sharedEventKey: 'synthetic-summary', sequence: 1,
        messageId: null, kind: 'context.summary', actor: 'system', classification: 'lifecycle',
        visibility: 'collapsed', payload: { text: 'One real compact summary', contextRevision: 1 }
      }
    ]
    chunk.done = true
    chunk.cursor = null
    const sourceRoot = '/synthetic/lifecycle-project'
    const source: SourceRef = {
      kind: 'composite-directory', stableId: chunk.identity.physicalSourceId, providerId: chunk.providerId,
      rootUri: pathToFileURL(sourceRoot).href,
      memberUris: [pathToFileURL(`${sourceRoot}/wire.jsonl`).href],
      displayLocator: `${sourceRoot}/wire.jsonl`, fingerprint: chunk.fingerprint
    }
    expect(validateParseChunkV2(chunk).ok).toBe(true)

    const outcome = projectNativeV2ChunksForConsumers(
      chunk.providerId, chunk.parserDataVersion, [source], [chunk]
    )[0]
    const summary = canonicalRecordsToSessionSummary(outcome.sessions[0].records, {
      filePath: source.displayLocator,
      source: 'pi'
    })

    expect(summary.compactCount).toBe(1)
  })

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

  it('fails closed when provider-defined usage relations cannot be represented by v1', () => {
    const chunk = structuredClone(
      piGolden.envelopes.find((entry) => entry.kind === 'parse-chunk')!.payload
    ) as unknown as ParseChunk
    const usage = chunk.events.find((event) => event.kind === 'usage')!
    const payload = usage.payload as unknown as UsageRecord
    payload.relations = { cacheRead: 'provider-defined', cacheWrite: 'provider-defined', reasoning: 'provider-defined' }
    const sourceRoot = '/synthetic/ambiguous-usage'
    const source: SourceRef = {
      kind: 'composite-directory', stableId: chunk.identity.physicalSourceId, providerId: chunk.providerId,
      rootUri: pathToFileURL(sourceRoot).href,
      memberUris: [pathToFileURL(`${sourceRoot}/session.jsonl`).href],
      displayLocator: sourceRoot, fingerprint: chunk.fingerprint
    }

    const records = projectNativeV2ChunksForConsumers(
      chunk.providerId, chunk.parserDataVersion, [source], [chunk]
    )[0].sessions[0].records
    const projected = records.find((record) => record.recordType === 'usage')

    expect(projected).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
      costUsd: null,
      usageProvenance: 'unavailable'
    })
  })

  it('keeps separately reported reasoning inside the billable v1 output total', () => {
    const chunk = structuredClone(
      piGolden.envelopes.find((entry) => entry.kind === 'parse-chunk')!.payload
    ) as unknown as ParseChunk
    const usage = chunk.events.find((event) => event.kind === 'usage')!
    const payload = usage.payload as unknown as UsageRecord
    payload.output = { total: 30, visible: 25, reasoning: 5 }
    payload.relations.reasoning = 'subset-of-output'
    const sourceRoot = '/synthetic/reasoning-accounting'
    const source: SourceRef = {
      kind: 'composite-directory', stableId: chunk.identity.physicalSourceId, providerId: chunk.providerId,
      rootUri: pathToFileURL(sourceRoot).href,
      memberUris: [pathToFileURL(`${sourceRoot}/session.jsonl`).href],
      displayLocator: sourceRoot, fingerprint: chunk.fingerprint
    }

    const records = projectNativeV2ChunksForConsumers(
      chunk.providerId, chunk.parserDataVersion, [source], [chunk]
    )[0].sessions[0].records
    const projected = records.find((record) => record.recordType === 'usage')

    expect(projected).toMatchObject({ outputTokens: 30, reasoningTokens: 5 })
  })
})
