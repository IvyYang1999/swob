import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanonicalEvent, ProviderEnvelope } from '../../shared/provider-schema-v2.generated'
import { PROVIDER_PROTOCOL_VERSION } from '../../shared/provider-schema-v2.generated'
import {
  helloForProviderV2,
  runProviderConformanceV2,
  validateParseChunkV2,
  validateProviderManifestV2
} from '../../shared/provider-protocol-v2'
import {
  buildGeminiResumeArgs,
  geminiHelpSupportsResume,
  probeGeminiResumeCapability
} from './gemini-resume'
import {
  createGeminiProvider,
  GEMINI_EIGHT_LAYER_EVIDENCE,
  GEMINI_JSON_FORMAT,
  GEMINI_JSONL_FORMAT,
  GEMINI_PROVIDER_ID,
  GEMINI_PROVIDER_MANIFEST
} from './gemini-provider'

const fixtureHome = path.resolve(__dirname, '../../../testdata/gemini/home')
const mainId = '11111111-1111-4111-8111-111111111111'
const legacyId = '22222222-2222-4222-8222-222222222222'
const childId = '33333333-3333-4333-8333-333333333333'
let tempRoot = ''
let home = ''

function allEvents(chunks: Array<{ events: CanonicalEvent[] }>): CanonicalEvent[] {
  return chunks.flatMap((chunk) => chunk.events)
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-gemini-provider-'))
  home = path.join(tempRoot, 'home')
  fs.cpSync(fixtureHome, home, { recursive: true })
})

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

describe('Gemini CLI native Provider Protocol v2', () => {
  it('declares an explicit eight-layer table and schema-valid two-generation manifest', () => {
    expect(GEMINI_EIGHT_LAYER_EVIDENCE.map((entry) => entry.layer)).toEqual([
      'discovery', 'metadata', 'messages', 'tools', 'system+compact', 'token', 'relationships', 'resume'
    ])
    expect(GEMINI_EIGHT_LAYER_EVIDENCE.every((entry) => entry.fixture && entry.conformanceTestId)).toBe(true)
    expect(GEMINI_EIGHT_LAYER_EVIDENCE.find((entry) => entry.layer === 'token')).toMatchObject({ grade: 'exact' })
    expect(GEMINI_EIGHT_LAYER_EVIDENCE.find((entry) => entry.layer === 'resume')).toMatchObject({ grade: 'derived' })
    expect(validateProviderManifestV2(GEMINI_PROVIDER_MANIFEST)).toMatchObject({ ok: true, issues: [] })
    expect(GEMINI_PROVIDER_MANIFEST.formatVersions).toEqual([GEMINI_JSONL_FORMAT, GEMINI_JSON_FORMAT])
    expect(GEMINI_PROVIDER_MANIFEST.capabilities['terminal-resume']).toMatchObject({ status: 'experimental' })
  })

  it('discovers JSONL, legacy JSON and nested subagent files with full stable IDs', async () => {
    const discovered = await createGeminiProvider({ homeDir: home }).discover(new AbortController().signal)
    expect(discovered.map((source) => source.stableId).sort()).toEqual([
      `gemini:${mainId}`, `gemini:${legacyId}`, `gemini:${childId}`
    ].sort())
    expect(discovered.every((source) => source.kind === 'file' && source.providerId === GEMINI_PROVIDER_ID)).toBe(true)
  })

  it('deduplicates repeated stream snapshots and keeps visible, thoughts, tools, citations and usage separate', async () => {
    const provider = createGeminiProvider({ homeDir: home })
    const signal = new AbortController().signal
    const source = (await provider.discover(signal)).find((entry) => entry.stableId === `gemini:${mainId}`)!
    const chunks = await provider.parse(source, await provider.fingerprint(source, signal), signal)
    chunks.forEach((chunk) => expect(validateParseChunkV2(chunk)).toMatchObject({ ok: true, issues: [] }))
    const events = allEvents(chunks)

    expect(events.some((event) => JSON.stringify(event.payload).includes('This record is rewound'))).toBe(false)
    expect(events.some((event) => event.kind === 'unknown' && (event.payload as any).rawType === 'gemini.rewind')).toBe(true)
    expect(events.filter((event) => event.messageId === 'assistant-1' && event.kind === 'message.text'))
      .toHaveLength(1)
    expect(events.find((event) => event.messageId === 'assistant-1' && event.kind === 'message.text')?.payload)
      .toEqual({ text: 'The inspection is complete.' })
    expect(events.find((event) => event.messageId === 'assistant-1' && event.kind === 'message.thinking')?.payload)
      .toEqual({ text: 'Plan\nRead the synthetic file first.' })
    expect(events.find((event) => event.kind === 'tool.call')?.payload).toMatchObject({
      callId: 'read_file_1', rawName: 'read_file', semanticToolId: 'filesystem.read',
      input: { file_path: '/workspace/synthetic-gemini/README.md' }
    })
    expect(events.find((event) => event.kind === 'tool.result')?.payload).toMatchObject({
      callId: 'read_file_1', state: 'complete', output: { output: 'gemini-synthetic-search-needle' }
    })
    expect(events.filter((event) => ['gemini.citationMetadata', 'gemini.groundingMetadata']
      .includes((event.payload as any).rawType))).toHaveLength(2)

    const usage = events.find((event) => event.messageId === 'assistant-1' && event.kind === 'usage')!
    expect(usage.payload).toMatchObject({
      modelId: 'gemini-synthetic-pro',
      input: { total: 127, uncached: 107, cacheRead: 20 },
      output: { total: 30, visible: 25, reasoning: 5 },
      providerTotal: 157,
      aggregation: 'per-message',
      relations: { cacheRead: 'subset-of-input', reasoning: 'subset-of-output' },
      measurement: { source: 'reported', confidence: 'exact' }
    })
    expect(events.find((event) => (event.payload as any).rawType === 'gemini.usage.rawBuckets')?.payload)
      .toMatchObject({ rawPayload: { input: 120, output: 25, cached: 20, thoughts: 5, tool: 7, total: 157 } })
    expect(events.filter((event) => event.kind === 'usage')).toHaveLength(2)
    expect(events.find((event) => event.messageId === 'assistant-2' && event.kind === 'message.thinking')?.payload)
      .toEqual({ text: 'Persisted private reasoning block.' })
    expect(chunks[0].diagnostics.map((entry) => entry.code)).toContain('gemini-jsonl-malformed')
  })

  it('parses legacy JSON structured function parts without a v1 migration', async () => {
    const provider = createGeminiProvider({ homeDir: home })
    const signal = new AbortController().signal
    const source = (await provider.discover(signal)).find((entry) => entry.stableId === `gemini:${legacyId}`)!
    const chunks = await provider.parse(source, await provider.fingerprint(source, signal), signal)
    const events = allEvents(chunks)

    expect(chunks[0].formatVersion).toBe(GEMINI_JSON_FORMAT)
    expect(events.find((event) => event.kind === 'tool.call')?.payload).toMatchObject({
      rawName: 'run_shell_command', semanticToolId: 'shell.execute'
    })
    expect(events.find((event) => event.kind === 'tool.result')?.payload).toMatchObject({
      callId: 'run_shell_1', output: { output: '/workspace/synthetic-gemini' }
    })
  })

  it('derives only the evidenced nested subagent relationship', async () => {
    const provider = createGeminiProvider({ homeDir: home })
    const signal = new AbortController().signal
    const source = (await provider.discover(signal)).find((entry) => entry.stableId === `gemini:${childId}`)!
    const chunks = await provider.parse(source, await provider.fingerprint(source, signal), signal)
    expect(chunks[0].identity).toMatchObject({
      logicalSessionId: childId,
      parentBranchViewId: `gemini:${mainId}:default`
    })
    expect(allEvents(chunks).find((event) => event.kind === 'session.lifecycle')?.payload).toEqual({
      relationshipType: 'subagent', parentBranchViewId: `gemini:${mainId}:default`
    })
  })

  it('fails closed when a file changes after fingerprinting', async () => {
    const provider = createGeminiProvider({ homeDir: home })
    const signal = new AbortController().signal
    const source = (await provider.discover(signal)).find((entry) => entry.stableId === `gemini:${legacyId}`)!
    const original = await provider.fingerprint(source, signal)
    fs.appendFileSync(source.displayLocator, '\n')
    await expect(provider.parse(source, original, signal)).rejects.toThrow('gemini-source-changed-during-parse')
  })

  it('rejects project and nested chats symlink chains that escape the canonical tmp root', async () => {
    const tmp = path.join(home, '.gemini', 'tmp')
    const fixtureFile = path.join(tmp, 'synthetic-project', 'chats', 'session-2026-08-02-11111111.jsonl')
    const outsideProject = path.join(tempRoot, 'outside-project')
    fs.mkdirSync(path.join(outsideProject, 'chats'), { recursive: true })
    fs.copyFileSync(fixtureFile, path.join(outsideProject, 'chats', path.basename(fixtureFile)))
    fs.symlinkSync(outsideProject, path.join(tmp, 'escape-project'), 'dir')

    await expect(createGeminiProvider({ homeDir: home }).discover(new AbortController().signal))
      .rejects.toThrow('gemini-project-directory-alias-not-allowed')

    fs.unlinkSync(path.join(tmp, 'escape-project'))
    const outsideChats = path.join(tempRoot, 'outside-chats')
    fs.mkdirSync(outsideChats, { recursive: true })
    fs.copyFileSync(fixtureFile, path.join(outsideChats, path.basename(fixtureFile)))
    const chainedProject = path.join(tmp, 'chained-project')
    fs.mkdirSync(chainedProject)
    fs.symlinkSync(outsideChats, path.join(chainedProject, 'chats'), 'dir')

    await expect(createGeminiProvider({ homeDir: home }).discover(new AbortController().signal))
      .rejects.toThrow('gemini-source-outside-configured-root')
  })

  it('allows an explicitly configured root symlink but rejects a tmp symlink escaping that root', async () => {
    const configuredRoot = path.join(home, '.gemini')
    const canonicalRoot = path.join(tempRoot, 'canonical-gemini-root')
    fs.renameSync(configuredRoot, canonicalRoot)
    fs.symlinkSync(canonicalRoot, configuredRoot, 'dir')
    const aliasedProvider = createGeminiProvider({ homeDir: home })
    const signal = new AbortController().signal
    const aliasedSources = await aliasedProvider.discover(signal)
    expect(aliasedSources).toHaveLength(3)
    const aliasedMain = aliasedSources.find((entry) => entry.stableId === `gemini:${mainId}`)!
    const aliasedFingerprint = await aliasedProvider.fingerprint(aliasedMain, signal)
    expect(await aliasedProvider.inputBytes(aliasedMain, signal)).toBeGreaterThan(0)
    await expect(aliasedProvider.parse(aliasedMain, aliasedFingerprint, signal)).resolves.toHaveLength(1)

    fs.unlinkSync(configuredRoot)
    fs.cpSync(canonicalRoot, configuredRoot, { recursive: true })
    fs.rmSync(path.join(configuredRoot, 'tmp'), { recursive: true, force: true })
    const outsideTmp = path.join(tempRoot, 'outside-tmp')
    fs.cpSync(path.join(canonicalRoot, 'tmp'), outsideTmp, { recursive: true })
    fs.symlinkSync(outsideTmp, path.join(configuredRoot, 'tmp'), 'dir')
    await expect(createGeminiProvider({ homeDir: home }).discover(new AbortController().signal))
      .rejects.toThrow('gemini-configured-tmp-root-outside-root')
  })

  it('rejects project directory aliases even when they stay below the canonical tmp root', async () => {
    const tmp = path.join(home, '.gemini', 'tmp')
    fs.symlinkSync('synthetic-project', path.join(tmp, 'alias-project'), 'dir')

    await expect(createGeminiProvider({ homeDir: home }).discover(new AbortController().signal))
      .rejects.toThrow('gemini-project-directory-alias-not-allowed')
  })

  it('rejects chats aliases that cross into another canonical project', async () => {
    const tmp = path.join(home, '.gemini', 'tmp')
    const secondProject = path.join(tmp, 'second-project')
    fs.mkdirSync(secondProject)
    fs.symlinkSync(path.join('..', 'synthetic-project', 'chats'), path.join(secondProject, 'chats'), 'dir')

    await expect(createGeminiProvider({ homeDir: home }).discover(new AbortController().signal))
      .rejects.toThrow('gemini-source-outside-configured-root')
  })

  it.each(['chats', 'nested'])('returns a redacted access error instead of silently treating an unreadable %s directory as empty', async (scope) => {
    const directory = scope === 'chats'
      ? path.join(home, '.gemini', 'tmp', 'synthetic-project', 'chats')
      : path.join(home, '.gemini', 'tmp', 'synthetic-project', 'chats', mainId)
    const privateDetail = `/private/gemini/${scope}`
    const originalReaddir = fs.promises.readdir.bind(fs.promises)
    const readdirSpy = vi.spyOn(fs.promises, 'readdir').mockImplementation(async (...args: any[]) => {
      if (path.basename(String(args[0])) === path.basename(directory)) {
        throw Object.assign(new Error(`permission denied: ${privateDetail}`), { code: 'EACCES' })
      }
      return originalReaddir(...args as Parameters<typeof fs.promises.readdir>) as any
    })
    try {
      const failure = await createGeminiProvider({ homeDir: home })
        .discover(new AbortController().signal)
        .then(() => null, (error) => error as Error)
      expect(failure?.message).toBe('gemini-source-access-denied')
      expect(failure?.message).not.toContain(privateDetail)
    } finally {
      readdirSpy.mockRestore()
    }
  })

  it('revalidates collected source candidates against their canonical chats root', async () => {
    const tmp = path.join(home, '.gemini', 'tmp')
    const project = path.join(tmp, 'synthetic-project')
    const chats = path.join(project, 'chats')
    const secondProject = path.join(tmp, 'second-project')
    const secondChats = path.join(secondProject, 'chats')
    fs.mkdirSync(secondProject)
    fs.cpSync(chats, secondChats, { recursive: true })
    const trigger = fs.realpathSync(path.join(chats, 'session-2026-08-02-11111111.jsonl'))
    const originalRealpath = fs.promises.realpath.bind(fs.promises)
    let replaced = false
    let triggerCalls = 0
    const realpathSpy = vi.spyOn(fs.promises, 'realpath').mockImplementation(async (...args: any[]) => {
      if (path.resolve(String(args[0])) === path.resolve(trigger)) triggerCalls++
      if (!replaced && triggerCalls === 2) {
        fs.renameSync(chats, `${chats}-original`)
        fs.symlinkSync(secondChats, chats, 'dir')
        replaced = true
      }
      return originalRealpath(...args as Parameters<typeof fs.promises.realpath>) as any
    })
    try {
      await expect(createGeminiProvider({ homeDir: home }).discover(new AbortController().signal))
        .rejects.toThrow(/gemini-source-(outside-configured-root|scope-changed|replaced-during-open)/)
      expect(replaced).toBe(true)
    } finally {
      realpathSpy.mockRestore()
    }
  })

  it('revalidates persisted source refs and rejects prefix collisions and final-file symlinks', async () => {
    const provider = createGeminiProvider({ homeDir: home })
    const signal = new AbortController().signal
    const source = (await provider.discover(signal)).find((entry) => entry.stableId === `gemini:${mainId}`)!
    const sourceFile = source.displayLocator
    const prefixCollision = path.join(home, '.gemini', 'tmp-escape', path.basename(sourceFile))
    fs.mkdirSync(path.dirname(prefixCollision), { recursive: true })
    fs.copyFileSync(sourceFile, prefixCollision)
    const forged = {
      ...source,
      uri: pathToFileURL(prefixCollision).href,
      displayLocator: prefixCollision
    }

    await expect(provider.fingerprint(forged, signal)).rejects.toThrow('gemini-source-outside-configured-root')
    await expect(provider.inputBytes(forged, signal)).rejects.toThrow('gemini-source-outside-configured-root')
    await expect(provider.parse(forged, { algorithm: 'sha256', value: 'irrelevant' }, signal))
      .rejects.toThrow('gemini-source-outside-configured-root')

    const linkedFile = path.join(home, '.gemini', 'tmp', 'synthetic-project', 'chats', 'session-escape.jsonl')
    fs.symlinkSync(prefixCollision, linkedFile)
    const linked = { ...source, uri: pathToFileURL(linkedFile).href, displayLocator: linkedFile }
    await expect(provider.fingerprint(linked, signal)).rejects.toThrow('gemini-source-file-alias-not-allowed')
  })

  it('rejects a cross-project persisted SourceRef at fingerprint, inputBytes and parse', async () => {
    const tmp = path.join(home, '.gemini', 'tmp')
    const originalLegacy = path.join(tmp, 'synthetic-project', 'chats', 'session-2026-08-01-22222222.json')
    const secondChats = path.join(tmp, 'second-project', 'chats')
    fs.mkdirSync(secondChats, { recursive: true })
    const movedLegacy = path.join(secondChats, path.basename(originalLegacy))
    fs.copyFileSync(originalLegacy, movedLegacy)
    fs.unlinkSync(originalLegacy)
    const provider = createGeminiProvider({ homeDir: home })
    const signal = new AbortController().signal
    const sources = await provider.discover(signal)
    const main = sources.find((entry) => entry.stableId === `gemini:${mainId}`)!
    const legacy = sources.find((entry) => entry.stableId === `gemini:${legacyId}`)!
    if (main.kind !== 'file' || legacy.kind !== 'file') throw new Error('synthetic Gemini sources must be files')
    const forged = { ...main, uri: legacy.uri, displayLocator: legacy.displayLocator }
    const failures = await Promise.all([
      provider.fingerprint(forged, signal),
      provider.inputBytes(forged, signal),
      provider.parse(forged, { algorithm: 'sha256', value: 'irrelevant' }, signal)
    ].map((operation) => operation.then(() => null, (error) => error as Error)))

    expect(failures.map((error) => error?.message)).toEqual([
      'gemini-source-not-issued',
      'gemini-source-not-issued',
      'gemini-source-not-issued'
    ])
    expect(failures.every((error) => !error?.message.includes(movedLegacy))).toBe(true)
  })

  it('rejects an issued final locator replaced by an in-scope sibling symlink at every provider boundary', async () => {
    const provider = createGeminiProvider({ homeDir: home })
    const signal = new AbortController().signal
    const sources = await provider.discover(signal)
    const main = sources.find((entry) => entry.stableId === `gemini:${mainId}`)!
    const legacy = sources.find((entry) => entry.stableId === `gemini:${legacyId}`)!
    fs.renameSync(main.displayLocator, `${main.displayLocator}.original`)
    fs.symlinkSync(path.basename(legacy.displayLocator), main.displayLocator, 'file')
    const failures = await Promise.all([
      provider.fingerprint(main, signal),
      provider.inputBytes(main, signal),
      provider.parse(main, { algorithm: 'sha256', value: 'irrelevant' }, signal)
    ].map((operation) => operation.then(() => null, (error) => error as Error)))

    expect(failures.map((error) => error?.message)).toEqual([
      'gemini-source-file-alias-not-allowed',
      'gemini-source-file-alias-not-allowed',
      'gemini-source-file-alias-not-allowed'
    ])
  })

  it('rejects replaced source content whose session id no longer matches the issued stable id', async () => {
    const provider = createGeminiProvider({ homeDir: home })
    const signal = new AbortController().signal
    const sources = await provider.discover(signal)
    const main = sources.find((entry) => entry.stableId === `gemini:${mainId}`)!
    const child = sources.find((entry) => entry.stableId === `gemini:${childId}`)!
    fs.copyFileSync(child.displayLocator, main.displayLocator)
    const changed = await provider.fingerprint(main, signal)

    await expect(provider.parse(main, changed, signal)).rejects.toThrow('gemini-source-identity-mismatch')
  })

  it('fails closed for a direct stale SourceRef until the provider instance rediscovers it', async () => {
    const signal = new AbortController().signal
    const source = (await createGeminiProvider({ homeDir: home }).discover(signal))[0]
    const freshProvider = createGeminiProvider({ homeDir: home })

    await expect(freshProvider.inputBytes(source, signal)).rejects.toThrow('gemini-source-not-issued')
  })

  it('detects a parent-directory replacement between containment validation and file open', async () => {
    const provider = createGeminiProvider({ homeDir: home })
    const signal = new AbortController().signal
    const source = (await provider.discover(signal)).find((entry) => entry.stableId === `gemini:${mainId}`)!
    const project = path.join(home, '.gemini', 'tmp', 'synthetic-project')
    const outsideProject = path.join(tempRoot, 'replacement-project')
    fs.mkdirSync(path.join(outsideProject, 'chats'), { recursive: true })
    fs.copyFileSync(source.displayLocator, path.join(outsideProject, 'chats', path.basename(source.displayLocator)))
    const originalOpen = fs.promises.open.bind(fs.promises)
    let replaced = false
    const openSpy = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      if (!replaced && path.resolve(String(args[0])) === path.resolve(source.displayLocator)) {
        fs.renameSync(project, `${project}-original`)
        fs.symlinkSync(outsideProject, project, 'dir')
        replaced = true
      }
      return originalOpen(...args)
    })
    try {
      await expect(provider.fingerprint(source, signal)).rejects.toThrow(/gemini-source-(outside-configured-root|replaced-during-open)/)
      expect(replaced).toBe(true)
    } finally {
      openSpy.mockRestore()
    }
  })

  it('rejects an external project marker without exposing its path or body', async () => {
    const provider = createGeminiProvider({ homeDir: home })
    const signal = new AbortController().signal
    const source = (await provider.discover(signal)).find((entry) => entry.stableId === `gemini:${mainId}`)!
    const expected = await provider.fingerprint(source, signal)
    const marker = path.join(home, '.gemini', 'tmp', 'synthetic-project', '.project_root')
    const outsideMarker = path.join(tempRoot, 'private-marker.txt')
    const externalBody = 'outside-marker-private-body'
    fs.writeFileSync(outsideMarker, externalBody)
    fs.unlinkSync(marker)
    fs.symlinkSync(outsideMarker, marker)

    const failure = await provider.parse(source, expected, signal).then(() => null, (error) => error as Error)
    expect(failure?.message).toBe('gemini-source-outside-configured-root')
    expect(failure?.message).not.toContain(outsideMarker)
    expect(failure?.message).not.toContain(externalBody)
  })

  it('rejects an external projects registry instead of treating it as optional metadata', async () => {
    const provider = createGeminiProvider({ homeDir: home })
    const signal = new AbortController().signal
    const source = (await provider.discover(signal)).find((entry) => entry.stableId === `gemini:${mainId}`)!
    const expected = await provider.fingerprint(source, signal)
    fs.unlinkSync(path.join(home, '.gemini', 'tmp', 'synthetic-project', '.project_root'))
    const registry = path.join(home, '.gemini', 'projects.json')
    const outsideRegistry = path.join(tempRoot, 'private-projects.json')
    const externalBody = '/outside/projects/private-workspace'
    fs.writeFileSync(outsideRegistry, JSON.stringify({ projects: { [externalBody]: 'synthetic-project' } }))
    fs.unlinkSync(registry)
    fs.symlinkSync(outsideRegistry, registry)

    const failure = await provider.parse(source, expected, signal).then(() => null, (error) => error as Error)
    expect(failure?.message).toBe('gemini-source-outside-configured-root')
    expect(failure?.message).not.toContain(outsideRegistry)
    expect(failure?.message).not.toContain(externalBody)
  })

  it('detects projects registry replacement during handle open without leaking replacement content', async () => {
    const provider = createGeminiProvider({ homeDir: home })
    const signal = new AbortController().signal
    const source = (await provider.discover(signal)).find((entry) => entry.stableId === `gemini:${mainId}`)!
    const expected = await provider.fingerprint(source, signal)
    fs.unlinkSync(path.join(home, '.gemini', 'tmp', 'synthetic-project', '.project_root'))
    const registry = path.join(home, '.gemini', 'projects.json')
    const outsideRegistry = path.join(tempRoot, 'replacement-projects.json')
    const externalBody = '/replacement/private-workspace'
    fs.writeFileSync(outsideRegistry, JSON.stringify({ projects: { [externalBody]: 'synthetic-project' } }))
    const originalOpen = fs.promises.open.bind(fs.promises)
    let replaced = false
    const openSpy = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      if (!replaced && path.basename(String(args[0])) === 'projects.json') {
        fs.renameSync(registry, `${registry}.original`)
        fs.symlinkSync(outsideRegistry, registry)
        replaced = true
      }
      return originalOpen(...args)
    })
    try {
      const failure = await provider.parse(source, expected, signal).then(() => null, (error) => error as Error)
      expect(failure?.message).toMatch(/gemini-source-(outside-configured-root|replaced-during-open|symlink-loop)/)
      expect(failure?.message).not.toContain(outsideRegistry)
      expect(failure?.message).not.toContain(externalBody)
      expect(replaced).toBe(true)
    } finally {
      openSpy.mockRestore()
    }
  })

  it.each([
    ['malformed JSON', '{malformed'],
    ['missing projects object', JSON.stringify({ version: 1 })],
    ['non-object projects value', JSON.stringify({ projects: [] })],
    ['non-string project slug', JSON.stringify({ projects: { '/private/workspace': 42 } })]
  ])('rejects an existing projects registry with %s using a stable redacted code', async (_label, body) => {
    const provider = createGeminiProvider({ homeDir: home })
    const signal = new AbortController().signal
    const source = (await provider.discover(signal)).find((entry) => entry.stableId === `gemini:${mainId}`)!
    const expected = await provider.fingerprint(source, signal)
    fs.unlinkSync(path.join(home, '.gemini', 'tmp', 'synthetic-project', '.project_root'))
    const registry = path.join(home, '.gemini', 'projects.json')
    fs.writeFileSync(registry, body)

    const failure = await provider.parse(source, expected, signal).then(() => null, (error) => error as Error)
    expect(failure?.message).toBe('gemini-project-registry-invalid')
    expect(failure?.message).not.toContain(registry)
    expect(failure?.message).not.toContain(body)
  })

  it('redacts an issued source that goes missing at every provider boundary', async () => {
    const provider = createGeminiProvider({ homeDir: home })
    const signal = new AbortController().signal
    const source = (await provider.discover(signal)).find((entry) => entry.stableId === `gemini:${mainId}`)!
    const missing = source.displayLocator
    fs.unlinkSync(missing)
    const failures = await Promise.all([
      provider.fingerprint(source, signal),
      provider.inputBytes(source, signal),
      provider.parse(source, { algorithm: 'sha256', value: 'irrelevant' }, signal)
    ].map((operation) => operation.then(() => null, (error) => error as Error)))

    expect(failures.map((error) => error?.message)).toEqual([
      'gemini-source-unavailable',
      'gemini-source-unavailable',
      'gemini-source-unavailable'
    ])
    expect(failures.every((error) => !error?.message.includes(missing))).toBe(true)
  })

  it('passes direct-v2 conformance', async () => {
    const provider = createGeminiProvider({ homeDir: home })
    const signal = new AbortController().signal
    const source = (await provider.discover(signal)).find((entry) => entry.stableId === `gemini:${mainId}`)!
    const chunks = await provider.parse(source, await provider.fingerprint(source, signal), signal)
    const envelopes: ProviderEnvelope[] = [
      { protocolVersion: PROVIDER_PROTOCOL_VERSION, messageId: randomUUID(), kind: 'hello', payload: helloForProviderV2(provider.manifest) },
      { protocolVersion: PROVIDER_PROTOCOL_VERSION, messageId: randomUUID(), kind: 'manifest', payload: provider.manifest },
      ...chunks.map((payload): ProviderEnvelope => ({ protocolVersion: PROVIDER_PROTOCOL_VERSION, messageId: randomUUID(), kind: 'parse-chunk', payload }))
    ]
    expect(runProviderConformanceV2({ manifest: provider.manifest, envelopes })).toMatchObject({
      ok: true, providerId: GEMINI_PROVIDER_ID, completedSessions: 1, issues: []
    })
  })

  it('probes Gemini version/help/source independently and never equates spawn with anchor success', async () => {
    const sourcePath = path.join(home, '.gemini', 'tmp', 'synthetic-project', 'chats', 'session-2026-08-02-11111111.jsonl')
    const calls: string[][] = []
    const result = await probeGeminiResumeCapability(sourcePath, async (args) => {
      calls.push(args)
      return args[0] === '--version'
        ? { stdout: '0.38.2', stderr: '' }
        : { stdout: '  -r, --resume  Resume a previous session', stderr: '' }
    })
    expect(result).toMatchObject({ available: true, reason: 'available', version: '0.38.2' })
    expect(calls).toEqual([['--version'], ['--help']])
    expect(geminiHelpSupportsResume('Usage: qodercli -r <id>')).toBe(false)
    expect(buildGeminiResumeArgs(mainId, result.helpOutput!)).toEqual(['--resume', mainId])
    expect(() => buildGeminiResumeArgs('../unsafe', result.helpOutput!)).toThrow('gemini-session-id-invalid')
    await expect(probeGeminiResumeCapability(path.join(home, 'missing'), async () => ({ stdout: '', stderr: '' })))
      .resolves.toMatchObject({ available: false, reason: 'source-unavailable' })
  })
})
