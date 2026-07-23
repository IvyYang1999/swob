import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { CanonicalRecord, SourceRef } from '../shared/provider-schema.generated'
import {
  closeSearchIndex,
  grepTranscripts,
  indexCanonicalSession,
  indexParsedSearchSource,
  searchFTS,
  searchIndexStats,
  tombstoneCanonicalSession
} from './search-index'

let root = ''
let priorIndexDir: string | undefined

function canonicalRecords(text: string): CanonicalRecord[] {
  const sourceRef: SourceRef = {
    kind: 'file',
    providerId: 'swob/pi',
    stableId: 'pi:canonical-search',
    uri: 'file:///synthetic/pi.jsonl',
    displayLocator: 'ssh://example.invalid/sessions/pi.jsonl',
    fingerprint: { algorithm: 'sha256', value: text }
  }
  const provenance = {
    providerId: 'swob/pi',
    sourceRefId: sourceRef.stableId,
    parserDataVersion: '1',
    formatVersion: 'pi-jsonl-v3',
    observedAt: '2026-07-23T00:00:00.000Z'
  }
  return [
    {
      id: 'canonical-session-record',
      recordType: 'session',
      sourceRef,
      sourceSessionId: 'canonical-search-session',
      createdAt: '2026-07-23T00:00:00.000Z',
      updatedAt: '2026-07-23T00:01:00.000Z',
      cwd: ['/synthetic/search-project'],
      projectPath: '/synthetic/search-project',
      providerTitle: null,
      provenance
    },
    {
      id: 'canonical-message-user',
      recordType: 'message',
      sessionRecordId: 'canonical-session-record',
      ordinal: 0,
      role: 'user',
      timestamp: '2026-07-23T00:00:01.000Z',
      content: [{ kind: 'text', text }],
      provenance
    },
    {
      id: 'canonical-message-assistant',
      recordType: 'message',
      sessionRecordId: 'canonical-session-record',
      ordinal: 1,
      role: 'assistant',
      timestamp: '2026-07-23T00:00:02.000Z',
      content: [{ kind: 'thinking', text: 'private-thinking-marker' }],
      provenance
    },
    {
      id: 'canonical-tool-call',
      recordType: 'tool-call',
      sessionRecordId: 'canonical-session-record',
      messageRecordId: 'canonical-message-assistant',
      ordinal: 2,
      name: 'synthetic-tool-name',
      input: { command: 'synthetic-tool-input' },
      provenance
    },
    {
      id: 'canonical-tool-result',
      recordType: 'tool-result',
      sessionRecordId: 'canonical-session-record',
      toolCallRecordId: 'canonical-tool-call',
      timestamp: '2026-07-23T00:00:03.000Z',
      content: 'synthetic-tool-result',
      isError: false,
      provenance
    }
  ]
}

beforeEach(() => {
  closeSearchIndex()
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-canonical-search-'))
  priorIndexDir = process.env.SWOB_SEARCH_INDEX_DIR
  process.env.SWOB_SEARCH_INDEX_DIR = root
})

afterEach(() => {
  closeSearchIndex()
  if (priorIndexDir === undefined) delete process.env.SWOB_SEARCH_INDEX_DIR
  else process.env.SWOB_SEARCH_INDEX_DIR = priorIndexDir
  fs.rmSync(root, { recursive: true, force: true })
})

describe('canonical search projection', () => {
  it('indexes text, privacy-controlled thinking, and structured tools with filters', async () => {
    await indexCanonicalSession('canonical-search-session', canonicalRecords('canonical-text-marker'), {
      includeThinking: false
    })
    expect(searchFTS('canonical-text-marker')).toHaveLength(1)
    expect(searchFTS('private-thinking-marker')).toHaveLength(0)
    expect(searchFTS('synthetic-tool-name')).toHaveLength(1)
    expect(searchFTS('synthetic-tool-input')).toHaveLength(1)
    expect(searchFTS('synthetic-tool-result')).toHaveLength(1)

    const filtered = grepTranscripts('synthetic', {
      source: 'swob/pi',
      sessionIds: ['canonical-search-session'],
      project: '/synthetic/search-project'
    })
    expect(filtered).toHaveLength(1)
    expect(filtered[0].filePath).toBe('ssh://example.invalid/sessions/pi.jsonl')
    expect(grepTranscripts('synthetic', { source: 'swob/hermes' })).toHaveLength(0)

    await indexCanonicalSession('canonical-search-session', canonicalRecords('canonical-text-marker'))
    expect(searchFTS('private-thinking-marker')).toHaveLength(1)
  })

  it('merges legacy and canonical results, replaces old rows, and removes tombstones', async () => {
    const legacyPath = path.join(root, 'legacy.jsonl')
    fs.writeFileSync(legacyPath, '{"fixture":true}\n')
    await indexParsedSearchSource({ filePath: legacyPath, source: 'claude-code' }, [{
      uuid: 'legacy-message',
      parentUuid: null,
      sessionId: 'legacy-session',
      type: 'user',
      timestamp: '2026-07-23T00:00:00.000Z',
      message: { role: 'user', content: 'shared-bridge-marker legacy-only-marker' }
    }] as any)
    await indexCanonicalSession(
      'canonical-search-session',
      canonicalRecords('shared-bridge-marker canonical-old-marker')
    )
    expect(searchFTS('shared-bridge-marker').map((result) => result.sessionId).sort())
      .toEqual(['canonical-search-session', 'legacy-session'])

    await indexCanonicalSession(
      'canonical-search-session',
      canonicalRecords('shared-bridge-marker canonical-new-marker')
    )
    expect(searchFTS('canonical-old-marker')).toHaveLength(0)
    expect(searchFTS('canonical-new-marker')).toHaveLength(1)
    expect(searchIndexStats().sessions).toBe(2)

    await tombstoneCanonicalSession('canonical-session-record')
    expect(searchFTS('canonical-new-marker')).toHaveLength(0)
    expect(searchFTS('legacy-only-marker')).toHaveLength(1)
  })
})
