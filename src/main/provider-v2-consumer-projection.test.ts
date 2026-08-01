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
})
