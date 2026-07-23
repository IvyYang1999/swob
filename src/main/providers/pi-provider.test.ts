import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { validateProviderEnvelope } from '../../shared/provider-protocol'
import { PROVIDER_PROTOCOL_VERSION } from '../../shared/provider-schema.generated'
import { createPiProvider } from './pi-provider'

const temporaryRoots: string[] = []

function fixturePath(): string {
  return path.resolve(__dirname, '../../../testdata/pi/session.jsonl')
}

function temporaryPiRoot(): { root: string; sessionPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-pi-provider-'))
  temporaryRoots.push(root)
  const sessionPath = path.join(root, 'project', 'session.jsonl')
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true })
  fs.copyFileSync(fixturePath(), sessionPath)
  return { root, sessionPath }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('Pi builtin provider', () => {
  it('discovers, fingerprints, and parses the synthetic v3 fixture into structured canonical records', async () => {
    const { root, sessionPath } = temporaryPiRoot()
    const provider = createPiProvider({ homeDir: root, roots: [root] })
    const controller = new AbortController()

    const sources = await provider.discover(controller.signal)
    expect(sources).toHaveLength(1)
    expect(sources[0]).toMatchObject({
      providerId: 'swob/pi',
      stableId: 'pi:synthetic-pi-session',
      displayLocator: sessionPath
    })

    const fingerprint = await provider.fingerprint(sources[0], controller.signal)
    expect(fingerprint.algorithm).toBe('sha256')
    expect(fingerprint.value).toMatch(/^[0-9a-f]{64}$/)
    expect(await provider.inputBytes(sources[0], controller.signal)).toBe(fs.statSync(sessionPath).size)

    const outcome = await provider.parse(sources[0], fingerprint, controller.signal)
    expect(outcome).toMatchObject({
      providerId: 'swob/pi',
      formatVersion: 'pi-jsonl-v3',
      status: 'complete'
    })
    const validation = validateProviderEnvelope({
      protocolVersion: PROVIDER_PROTOCOL_VERSION,
      messageId: 'pi-provider-test',
      kind: 'parse-outcome',
      payload: outcome
    })
    expect(validation.ok, validation.error?.message).toBe(true)

    const records = outcome.sessions[0].records
    expect(records.filter((record) => record.recordType === 'session')).toHaveLength(1)
    expect(records.filter((record) => record.recordType === 'message')).toHaveLength(4)
    expect(records.filter((record) => record.recordType === 'tool-call')).toMatchObject([
      { name: 'read', input: { file_path: '/workspace/synthetic-pi/README.md' } }
    ])
    expect(records.filter((record) => record.recordType === 'tool-result')).toMatchObject([
      { content: [{ type: 'text', text: 'synthetic-search-needle' }], isError: false }
    ])
    expect(records.filter((record) => record.recordType === 'usage')).toMatchObject([
      {
        model: 'synthetic-model-v1', inputTokens: 120, outputTokens: 30,
        cacheReadTokens: 20, cacheWriteTokens: 10, usageProvenance: 'reported'
      },
      { model: 'synthetic-model-v1', inputTokens: 80, outputTokens: 18, usageProvenance: 'reported' }
    ])
    expect(records.some((record) => record.recordType === 'relationship' &&
      record.relationshipType === 'parent-child')).toBe(true)
    expect(JSON.stringify(records)).toContain('Inspect the sample fixture without touching private data.')
  })

  it('reports malformed lines as partial-data instead of silently dropping them', async () => {
    const { root, sessionPath } = temporaryPiRoot()
    fs.appendFileSync(sessionPath, '\n{malformed\n')
    const provider = createPiProvider({ homeDir: root, roots: [root] })
    const signal = new AbortController().signal
    const source = (await provider.discover(signal))[0]
    const fingerprint = await provider.fingerprint(source, signal)
    const outcome = await provider.parse(source, fingerprint, signal)

    expect(outcome.status).toBe('partial')
    expect(outcome.errors).toMatchObject([{ code: 'partial-data', providerId: 'swob/pi' }])
    expect(outcome.sessions[0].records.some((record) => record.recordType === 'message')).toBe(true)
  })

  it('recognizes the legacy v1 header without changing the canonical record model', async () => {
    const { root, sessionPath } = temporaryPiRoot()
    const v1 = fs.readFileSync(sessionPath, 'utf8').replace('"version":3', '"version":1')
    fs.writeFileSync(sessionPath, v1)
    const provider = createPiProvider({ homeDir: root, roots: [root] })
    const signal = new AbortController().signal
    const source = (await provider.discover(signal))[0]
    const fingerprint = await provider.fingerprint(source, signal)
    const outcome = await provider.parse(source, fingerprint, signal)

    expect(outcome).toMatchObject({ status: 'complete', formatVersion: 'pi-jsonl-v1' })
    expect(outcome.sessions[0].records.some((record) => record.recordType === 'usage')).toBe(true)
  })

  it('keeps stable source identity when the same session file moves', async () => {
    const { root, sessionPath } = temporaryPiRoot()
    const provider = createPiProvider({ homeDir: root, roots: [root] })
    const signal = new AbortController().signal
    const first = (await provider.discover(signal))[0]
    const movedPath = path.join(root, 'moved', 'renamed.jsonl')
    fs.mkdirSync(path.dirname(movedPath), { recursive: true })
    fs.renameSync(sessionPath, movedPath)
    const moved = (await provider.discover(signal))[0]

    expect(moved.stableId).toBe(first.stableId)
    expect(moved.displayLocator).toBe(movedPath)
  })

  it('rejects a parse when the file changed after fingerprinting', async () => {
    const { root, sessionPath } = temporaryPiRoot()
    const provider = createPiProvider({ homeDir: root, roots: [root] })
    const signal = new AbortController().signal
    const source = (await provider.discover(signal))[0]
    const fingerprint = await provider.fingerprint(source, signal)

    fs.appendFileSync(sessionPath, '\n{"type":"title","title":"changed"}\n')

    await expect(provider.parse(source, fingerprint, signal))
      .rejects.toThrow('pi-source-changed-during-parse')
  })
})
