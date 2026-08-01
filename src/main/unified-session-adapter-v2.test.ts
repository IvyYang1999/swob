import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  PROVIDER_ADAPTER_LAYERS,
  UNIFIED_PROVIDER_DESCRIPTORS_V2,
  UNIFIED_PROVIDER_SOURCES
} from '../shared/seven-source-contract-v2'
import { validateResumeContractV2 } from '../shared/provider-protocol-v2'
import { ProviderChunkAssembler } from '../shared/provider-protocol-v2'
import { builtinProviderForSource } from '../shared/provider-capabilities'
import {
  accountClaudeUsage,
  tokenUsageFromAccounting,
  unavailableTokenAccounting
} from './token-accounting'
import type { ParsedMessage, RawJsonlMessage, SessionDetail } from './types'
import { adaptSessionDetailV2 } from './unified-session-adapter-v2'
import { providerAdapterMode } from './provider-adapter-mode'
import { buildCodexSessionDetail } from './codex-loader'
import { enrichPiSessionDetailV2 } from './pi-detail-adapter'
import { verifyResumeContractV2 } from './resume-contract-v2'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function parsed(raw: RawJsonlMessage): ParsedMessage {
  return {
    uuid: raw.uuid,
    type: raw.type === 'summary' ? 'system' : raw.type as ParsedMessage['type'],
    subtype: raw.subtype,
    timestamp: raw.timestamp,
    role: raw.message?.role,
    origin: raw.type === 'user' ? 'human' : 'unknown',
    textContent: typeof raw.message?.content === 'string' ? raw.message.content : '',
    toolCalls: [],
    images: [],
    isPreCompact: false,
    isSidechain: false,
    isSharedContext: false,
    isSystemGenerated: raw.type === 'system',
    raw
  }
}

function detailFor(
  source: typeof UNIFIED_PROVIDER_SOURCES[number],
  messages: ParsedMessage[] = []
): SessionDetail {
  const accounting = unavailableTokenAccounting(source, 'synthetic fixture deliberately has no counters')
  return {
    id: `${source}:fixture`,
    sessionId: `${source}-fixture`,
    resumeSessionId: `${source}-fixture`,
    slug: '',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:01:00.000Z',
    activityDays: ['2026-08-01'],
    messageCount: messages.length,
    turnCount: 1,
    compactCount: 0,
    cwds: ['/fixture'],
    version: 'fixture',
    firstUserMessage: 'fixture',
    toolUsage: {},
    skillInvocations: [],
    projectPath: '/fixture',
    filePath: `/fixture/${source}.jsonl`,
    fileSizeBytes: 1,
    userImages: [],
    pastedImageCount: 0,
    tokenUsage: tokenUsageFromAccounting(accounting),
    tokenAccounting: accounting,
    providerOutcome: { detected: 'detected', parse: 'parsed', usage: 'unavailable' },
    referencedFiles: [],
    configFiles: [],
    source,
    messages
  }
}

function writeCodex(lines: unknown[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-t173-codex-'))
  temporaryRoots.push(root)
  const filePath = path.join(root, 'rollout-fixture.jsonl')
  fs.writeFileSync(filePath, lines.map((line) => JSON.stringify(line)).join('\n'))
  return filePath
}

function writePi(lines: unknown[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-t173-pi-'))
  temporaryRoots.push(root)
  const filePath = path.join(root, 'pi-fixture.jsonl')
  fs.writeFileSync(filePath, lines.map((line) => JSON.stringify(line)).join('\n'))
  return filePath
}

function rendererSourceFiles(root: string): string[] {
  const files: string[] = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name)
    if (entry.isDirectory()) files.push(...rendererSourceFiles(absolute))
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) files.push(absolute)
  }
  return files
}

describe('t173 七来源统一 Provider Protocol v2', () => {
  it('7×8 能力表逐格给出真实性、fixture 和独立 conformance ID', () => {
    expect(UNIFIED_PROVIDER_DESCRIPTORS_V2.map((entry) => entry.sourceId)).toEqual(UNIFIED_PROVIDER_SOURCES)
    expect(UNIFIED_PROVIDER_DESCRIPTORS_V2).toHaveLength(7)
    const conformanceIds = new Set<string>()
    for (const descriptor of UNIFIED_PROVIDER_DESCRIPTORS_V2) {
      expect(builtinProviderForSource(descriptor.sourceId)?.adapterContract).toBe('provider-protocol-v2')
      expect(Object.keys(descriptor.layers)).toEqual(PROVIDER_ADAPTER_LAYERS)
      expect(fs.existsSync(path.resolve(descriptor.layers.discovery.fixture))).toBe(true)
      expect(validateResumeContractV2(descriptor.resumeContract).ok).toBe(true)
      expect(verifyResumeContractV2(descriptor.resumeContract, {
        launched: true,
        expectedSourceRefId: `${descriptor.sourceId}:fixture`,
        observedSourceRefId: `${descriptor.sourceId}:fixture`,
        sourceExists: true,
        expectedAnchors: { user: 'last user', assistant: 'last assistant' },
        observedDefaultMessages: [
          { role: 'user', text: 'last user' },
          { role: 'assistant', text: 'last assistant' }
        ],
        observedAllMessages: [
          { role: 'user', text: 'last user' },
          { role: 'assistant', text: 'last assistant' }
        ]
      })).toMatchObject({ ok: true, status: 'verified' })
      for (const layer of PROVIDER_ADAPTER_LAYERS) {
        const cell = descriptor.layers[layer]
        expect(['exact', 'derived', 'estimated', 'unavailable']).toContain(cell.truth)
        expect(cell.reason).not.toBe('')
        expect(fs.existsSync(path.resolve(cell.fixture))).toBe(true)
        expect(cell.conformanceTestId).toBe(`T173-${descriptor.sourceId.toUpperCase().replace(/-/g, '_')}-${layer.toUpperCase().replace(/-/g, '_')}`)
        conformanceIds.add(cell.conformanceTestId)
      }
    }
    expect(conformanceIds.size).toBe(UNIFIED_PROVIDER_DESCRIPTORS_V2.length * PROVIDER_ADAPTER_LAYERS.length)
    const zcode = UNIFIED_PROVIDER_DESCRIPTORS_V2.find((entry) => entry.sourceId === 'zcode')!
    const opencode = UNIFIED_PROVIDER_DESCRIPTORS_V2.find((entry) => entry.sourceId === 'opencode')!
    expect(zcode).not.toBe(opencode)
    expect(zcode.usageSemantics).toContain('independent')
  })

  it('七来源都生成校验通过的分片，并可由同一装配器消费', () => {
    for (const source of UNIFIED_PROVIDER_SOURCES) {
      const raw: RawJsonlMessage = {
        uuid: `${source}:message`,
        parentUuid: null,
        sessionId: `${source}-fixture`,
        type: 'assistant',
        timestamp: '2026-08-01T00:00:01.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'fixture output' }] }
      }
      const result = adaptSessionDetailV2(detailFor(source, [parsed(raw)]))
      const assembler = new ProviderChunkAssembler()
      for (const chunk of result.chunks) assembler.accept(chunk)
      expect(assembler.completedSessions()).toBe(1)
      expect(result.events.some((event) => event.kind === 'message.text')).toBe(true)
      expect(result.events.some((event) => event.kind === 'usage' &&
        (event.payload as any).measurement.source === 'unavailable')).toBe(true)
    }
  })

  it('Claude block、交互、权限、compact 和 usage 去重不经过来源名渲染分支', () => {
    const assistant: RawJsonlMessage = {
      uuid: 'claude-assistant',
      parentUuid: null,
      sessionId: 'claude-code-fixture',
      type: 'assistant',
      timestamp: '2026-08-01T00:00:01.000Z',
      requestId: 'request-1',
      message: {
        id: 'message-1',
        role: 'assistant',
        content: [
          { type: 'text', text: 'answer' },
          { type: 'thinking', text: 'private reasoning' },
          { type: 'tool_use', id: 'question-1', name: 'AskUserQuestion', input: { question: 'Continue?' } },
          { type: 'tool_use', id: 'permission-1', name: 'RequestPermissions', input: { permission: 'write' } }
        ],
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 2 }
      }
    }
    const duplicate = structuredClone(assistant)
    duplicate.uuid = 'claude-assistant-streaming'
    const results: RawJsonlMessage = {
      uuid: 'claude-results',
      parentUuid: assistant.uuid,
      sessionId: assistant.sessionId,
      type: 'user',
      timestamp: '2026-08-01T00:00:02.000Z',
      message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'question-1', content: 'Yes' },
        { type: 'tool_result', tool_use_id: 'permission-1', content: 'allow' }
      ] }
    }
    const compact: RawJsonlMessage = {
      uuid: 'claude-compact',
      parentUuid: results.uuid,
      sessionId: assistant.sessionId,
      type: 'system',
      subtype: 'microcompact_boundary',
      timestamp: '2026-08-01T00:00:03.000Z',
      message: { role: 'system', content: 'summary' }
    }
    const hook: RawJsonlMessage = {
      uuid: 'claude-hook',
      parentUuid: compact.uuid,
      sessionId: assistant.sessionId,
      type: 'system',
      subtype: 'hook-response',
      timestamp: '2026-08-01T00:00:04.000Z',
      message: { role: 'system', content: 'hook completed' }
    }
    const base = detailFor('claude-code', [assistant, duplicate, results, compact, hook].map(parsed))
    base.tokenAccounting = accountClaudeUsage([assistant, duplicate])
    base.tokenUsage = tokenUsageFromAccounting(base.tokenAccounting)
    const result = adaptSessionDetailV2(base)
    expect(result.events.map((event) => event.kind)).toEqual(expect.arrayContaining([
      'message.thinking', 'interaction.request', 'interaction.response',
      'permission.request', 'permission.response', 'context.compaction', 'context.summary', 'usage'
    ]))
    expect(result.events.filter((event) => event.kind === 'usage')).toHaveLength(1)
    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'message.text', classification: 'promoted-system' })
    ]))
    expect(result.detail.messages.some((message) => message.textContent.includes('[Thinking]'))).toBe(true)
  })

  it('Codex 保留 reasoning、compact、rollback、多 agent、review 与累计 usage', async () => {
    const sessionId = '019f0000-0000-7000-8000-000000000173'
    const detail = await buildCodexSessionDetail(writeCodex([
      { timestamp: '2026-08-01T00:00:00Z', type: 'session_meta', payload: { id: sessionId, cwd: '/fixture' } },
      { timestamp: '2026-08-01T00:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'review this' }] } },
      { timestamp: '2026-08-01T00:00:02Z', type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'inspect first' }] } },
      { timestamp: '2026-08-01T00:00:03Z', type: 'event_msg', payload: { type: 'context_compacted' } },
      { timestamp: '2026-08-01T00:00:04Z', type: 'event_msg', payload: { type: 'collab_agent_spawn', agent_id: 'reviewer-1' } },
      { timestamp: '2026-08-01T00:00:05Z', type: 'event_msg', payload: { type: 'review_started' } },
      { timestamp: '2026-08-01T00:00:06Z', type: 'event_msg', payload: { type: 'rollback', reason: 'retry' } },
      { timestamp: '2026-08-01T00:00:07Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] } },
      { timestamp: '2026-08-01T00:00:07.100Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'repeat the earlier phrase' }] } },
      { timestamp: '2026-08-01T00:00:07.200Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'inspect first' }] } },
      { timestamp: '2026-08-01T00:00:08Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 30, reasoning_output_tokens: 10 } } } },
      { timestamp: '2026-08-01T00:00:09Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 150, cached_input_tokens: 30, output_tokens: 40, reasoning_output_tokens: 12 } } } }
    ]))
    expect(detail).not.toBeNull()
    const result = adaptSessionDetailV2(detail!)
    expect(result.events.map((event) => event.kind)).toEqual(expect.arrayContaining([
      'message.reasoning', 'context.compaction', 'subagent.spawn', 'mode.changed', 'rollback', 'usage'
    ]))
    expect(result.events.filter((event) => event.kind === 'message.reasoning')).toHaveLength(1)
    expect(result.events.filter((event) => event.kind === 'usage').map((event) => (event.payload as any).aggregation))
      .toEqual(['delta', 'delta'])
  })

  it('Pi v3 保留全树、active chain、block 顺序、model change 与 compaction', async () => {
    const filePath = writePi([
      { type: 'session', version: 3, id: 'pi-session', timestamp: '2026-08-01T00:00:00Z', cwd: '/fixture', branchedFrom: '/fixture/pi-parent.jsonl' },
      { type: 'message', id: 'root', parentId: null, timestamp: '2026-08-01T00:00:01Z', message: { role: 'user', content: 'root prompt' } },
      { type: 'message', id: 'inactive-answer', parentId: 'root', timestamp: '2026-08-01T00:00:02Z', message: { role: 'assistant', content: 'old branch' } },
      { type: 'model_change', id: 'model-1', parentId: 'root', timestamp: '2026-08-01T00:00:03Z', modelId: 'pi-model-2' },
      { type: 'message', id: 'active-answer', parentId: 'model-1', timestamp: '2026-08-01T00:00:04Z', message: { role: 'assistant', content: [
        { type: 'thinking', thinking: 'active reasoning' },
        { type: 'custom', future: { retained: true } },
        { type: 'toolCall', id: 'pi-tool-1', name: 'read', arguments: { path: '/fixture/a.txt' } }
      ] } },
      { type: 'message', id: 'tool-result', parentId: 'active-answer', timestamp: '2026-08-01T00:00:05Z', message: { role: 'toolResult', toolCallId: 'pi-tool-1', content: 'read failed', isError: true } },
      { type: 'compaction', id: 'compact-1', parentId: 'tool-result', timestamp: '2026-08-01T00:00:06Z', summary: 'active summary' },
      { type: 'message', id: 'active-leaf', parentId: 'compact-1', timestamp: '2026-08-01T00:00:07Z', message: {
        role: 'assistant',
        content: 'new context',
        usage: { input: 12, output: 3, cacheRead: 4, cacheCreation: 2 }
      } }
    ])
    const base = detailFor('pi')
    base.filePath = filePath
    const enriched = await enrichPiSessionDetailV2(base)
    const result = adaptSessionDetailV2(enriched)

    expect(enriched).toMatchObject({
      version: 'pi-jsonl-v3',
      branchLeafUuid: 'active-leaf',
      branchParentId: 'pi-parent'
    })
    expect(result.chunks[0]).toMatchObject({
      formatVersion: 'pi-jsonl-v3',
      identity: { branchViewId: 'active-leaf', parentBranchViewId: 'pi-parent' }
    })
    expect(enriched.messages.find((message) => message.uuid === 'inactive-answer')?.isSidechain).toBe(true)
    expect(enriched.messages.find((message) => message.uuid === 'root')?.isSidechain).toBe(false)
    expect(result.events.map((event) => event.kind)).toEqual(expect.arrayContaining([
      'message.thinking', 'unknown', 'tool.call', 'tool.result',
      'model.changed', 'context.compaction', 'context.summary'
    ]))
    expect(result.events.filter((event) => event.messageId === 'active-answer')
      .map((event) => event.kind)).toEqual(['message.thinking', 'unknown', 'tool.call'])
    expect(result.events.find((event) => event.messageId === 'active-answer' && event.kind === 'unknown'))
      .toMatchObject({ payload: { rawType: 'content.custom' } })
    expect(result.events.find((event) => event.messageId === 'tool-result' && event.kind === 'tool.result'))
      .toMatchObject({ payload: { isError: true, state: 'error', output: 'read failed' } })
    expect(result.events.find((event) => event.kind === 'model.changed'))
      .toMatchObject({ payload: { fromModelId: null, toModelId: 'pi-model-2' } })
    const compaction = result.events.find((event) => event.kind === 'context.compaction')!
    const summary = result.events.find((event) => event.kind === 'context.summary')!
    expect(compaction.payload).toMatchObject({ contextRevision: 1, summaryEventId: summary.id })
    expect(summary.payload).toMatchObject({ contextRevision: 1 })
    const inactive = result.events.find((event) =>
      event.messageId === 'inactive-answer' && event.kind === 'message.text'
    )!
    expect(inactive.visibility).toBe('collapsed')
    expect(inactive.timeline.modelContext).toEqual([{
      contextRevision: 0,
      state: 'archived',
      fromSequence: inactive.sequence,
      untilSequence: null
    }])
    expect(result.events.find((event) => event.messageId === 'root')?.timeline.modelContext)
      .toEqual(expect.arrayContaining([expect.objectContaining({ state: 'archived' })]))
    expect(result.events.find((event) => event.messageId === 'active-leaf')?.timeline.modelContext)
      .toEqual([expect.objectContaining({ contextRevision: 1, state: 'visible-to-model' })])
    expect(enriched.messages.find((message) => message.uuid === 'active-leaf')?.tokenUsage).toEqual({
      inputTokens: 12,
      outputTokens: 3,
      cacheReadTokens: 4,
      cacheCreationTokens: 2
    })
  })

  it('Pi v1 线性日志不会被误判为 v3 非 active 分支', async () => {
    const filePath = writePi([
      { type: 'session', version: 1, id: 'pi-v1' },
      { type: 'message', id: 'v1-user', message: { role: 'user', content: 'one' } },
      { type: 'message', id: 'v1-assistant', message: { role: 'assistant', content: 'two' } }
    ])
    const base = detailFor('pi')
    base.filePath = filePath
    const enriched = await enrichPiSessionDetailV2(base)
    expect(enriched.version).toBe('pi-jsonl-v1')
    expect(enriched.messages.map((message) => message.isSidechain)).toEqual([false, false])
  })

  it('CC-Mirror 只复用 fixture 证明的公共字段，fork 扩展走 unknown 保真', () => {
    const raw: RawJsonlMessage = {
      uuid: 'mirror-message',
      parentUuid: null,
      sessionId: 'cc-mirror-fixture',
      type: 'assistant',
      timestamp: '2026-08-01T00:00:01Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'mirror text' }] },
      data: { forkExtension: { kind: 'mirror-checkpoint', revision: 2 } }
    }
    const result = adaptSessionDetailV2(detailFor('cc-mirror', [parsed(raw)]))
    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'message.text' }),
      expect.objectContaining({
        kind: 'unknown',
        payload: expect.objectContaining({ rawType: 'assistant.extension' })
      })
    ]))
    expect(JSON.stringify(result.events)).toContain('mirror-checkpoint')
  })

  it('全局/按来源开关一键回退 legacy，默认启用 v2', () => {
    expect(providerAdapterMode('codex', undefined, {})).toEqual({ mode: 'unified-v2', reason: 'default' })
    expect(providerAdapterMode('codex', undefined, { SWOB_PROVIDER_ADAPTER_MODE: 'legacy' }))
      .toEqual({ mode: 'legacy', reason: 'environment' })
    expect(providerAdapterMode('cursor', {
      preferences: { defaultViewMode: 'compact', terminalApp: 'Terminal', legacyProviderSources: ['cursor'] }
    }, {})).toEqual({ mode: 'legacy', reason: 'source-config' })
  })

  it('renderer 不按来源名分支 thinking、compact、工具或 usage', () => {
    const root = path.resolve(__dirname, '../renderer/src')
    const providerNames = '\\b(claude-code|codex|cursor|opencode|zcode|cc-mirror|pi)\\b'
    const semanticFields = '(thinking|reasoning|compact|toolCalls|tokenUsage|usage)'
    const forbidden = new RegExp(`${providerNames}.{0,100}${semanticFields}|${semanticFields}.{0,100}${providerNames}`, 'i')
    const violations = rendererSourceFiles(root).flatMap((filePath) => fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .flatMap((line, index) => forbidden.test(line) ? [`${path.relative(root, filePath)}:${index + 1}`] : []))
    expect(violations).toEqual([])
  })
})
