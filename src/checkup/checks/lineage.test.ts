import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { censusClaude } from '../census/claude-census'
import { censusCodex } from '../census/codex-census'
import type { CodexStateDb } from '../census/codex-state-db'
import type { ReadoutSession, SwobReadout } from '../readout'
import { claude, claudeProjectDir, codex, codexRolloutPath, jsonl, syntheticTime, syntheticUuid, writeSample } from '../self-test/samples'
import { applicability, type CheckContext } from './common'
import { lineageCheck } from './lineage'

const homes: string[] = []
function home(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkup-lineage-'))
  homes.push(dir)
  return fs.realpathSync(dir)
}
afterEach(() => {
  for (const dir of homes.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const CWD = '/synthetic/lineage-project'
const CLAUDE_PROJECT = path.join('.claude', 'projects', claudeProjectDir(CWD))

function readout(sessions: ReadoutSession[]): SwobReadout {
  return {
    status: 'ok', sessions, claudeParsed: new Map(), discovered: { claudeMain: new Set(), codex: new Set() },
    attributedChildIds: new Set(), consoleLines: 0, timingsMs: {}
  }
}

function ctx(partial: Partial<CheckContext> & Pick<CheckContext, 'readout'>): CheckContext {
  return {
    salt: 'lineage-salt', selected: new Set(['claude-code', 'codex', 'cursor']),
    claude: null, codex: null, codexDb: null, unscanned: null, presence: [], changed: new Set(), resumeProbe: null,
    resumeSample: { perSource: 4, seed: '2026-09-28' }, ...partial
  }
}

function codexSession(id: string, filePath: string, extra: Partial<ReadoutSession> = {}): ReadoutSession {
  return { source: 'codex', sessionId: id, primaryPath: filePath, paths: [filePath], subagentPaths: [], subagentIds: [], compactCount: 0, virtual: false, ...extra }
}

function claudeSession(id: string, filePath: string, extra: Partial<ReadoutSession> = {}): ReadoutSession {
  return { source: 'claude-code', sessionId: id, primaryPath: filePath, paths: [filePath], subagentPaths: [], subagentIds: [], compactCount: 0, virtual: false, ...extra }
}

async function writeCodexTopLevel(root: string, id: string, minute: number): Promise<string> {
  const file = writeSample(root, codexRolloutPath(id, minute), jsonl([
    codex.topLevelMeta({ timestamp: syntheticTime(minute), ordinal: 0, id, cwd: CWD }),
    codex.userMessage({ timestamp: syntheticTime(minute), ordinal: 1, text: 'q' }),
    codex.assistantMessage({ timestamp: syntheticTime(minute), ordinal: 2, text: 'a' })
  ]))
  return fs.realpathSync(file)
}

async function writeCodexChild(root: string, id: string, parentId: string, minute: number): Promise<string> {
  const file = writeSample(root, codexRolloutPath(id, minute), jsonl([
    codex.threadSpawnMeta({ timestamp: syntheticTime(minute), ordinal: 0, id, parentId, cwd: CWD }),
    codex.assistantMessage({ timestamp: syntheticTime(minute), ordinal: 1, text: 'child work' })
  ]))
  return fs.realpathSync(file)
}

/** A top-level session_meta row that is itself a fork/replay of another top-level session (not a thread-spawn). */
function codexTopLevelForkRow(input: { id: string; forkedFromId: string; timestamp: string }): Record<string, unknown> {
  return {
    timestamp: input.timestamp,
    ordinal: 0,
    type: 'session_meta',
    payload: {
      session_id: input.id, id: input.id, forked_from_id: input.forkedFromId, timestamp: input.timestamp, cwd: CWD,
      originator: 'codex_cli_rs', cli_version: '0.130.0', source: 'cli', thread_source: 'user', model_provider: 'openai',
      base_instructions: { text: 'synthetic base instructions' }
    }
  }
}

async function writeCodexFork(root: string, id: string, forkedFromId: string, minute: number): Promise<string> {
  const file = writeSample(root, codexRolloutPath(id, minute), jsonl([
    codexTopLevelForkRow({ id, forkedFromId, timestamp: syntheticTime(minute) }),
    codex.assistantMessage({ timestamp: syntheticTime(minute + 1), ordinal: 1, text: 'continued elsewhere' })
  ]))
  return fs.realpathSync(file)
}

/** A run of Claude user/assistant records with explicit uuids (for cross-file overlap fixtures). */
function claudeMessages(sessionId: string, uuids: string[], textPrefix: string): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = []
  let parent: string | null = null
  uuids.forEach((uuid, index) => {
    records.push(index % 2 === 0
      ? claude.user({ uuid, parentUuid: parent, sessionId, timestamp: syntheticTime(index), cwd: CWD, text: `${textPrefix}-${index}` })
      : claude.assistant({
        uuid, parentUuid: parent, sessionId, timestamp: syntheticTime(index), cwd: CWD, text: `${textPrefix}-${index}`,
        messageId: `msg-${uuid}`, requestId: `req-${uuid}`
      }))
    parent = uuid
  })
  return records
}

describe('④ lineage — Codex derivation edges (first-party, thread_spawn_edges)', () => {
  it('全部表达 → 通过', async () => {
    const root = home()
    const topId = syntheticUuid(1, 'c0de')
    const childId = syntheticUuid(2, 'c0de')
    const topPath = await writeCodexTopLevel(root, topId, 0)
    await writeCodexChild(root, childId, topId, 10)
    const codexCensus = await censusCodex(root, { env: {} })
    const codexDb: CodexStateDb = {
      available: true, version: 1, candidates: 1, threads: [], edges: [{ parent: topId, child: childId, status: 'open' }], audit: null
    }
    const sessions = [{ ...codexSession(topId, topPath), subagents: [{ sessionId: childId, parentSessionId: topId }] }]
    const result = lineageCheck(ctx({ codex: codexCensus, codexDb, readout: readout(sessions) }))
    expect(result.bySource.codex.swob.derivationExpressed?.value).toBe(1)
    expect(result.bySource.codex.swob.derivationNotExpressed?.value).toBe(0)
    expect(result.bySource.codex.verdict).toBe('pass')
    expect(result.verdict).toBe('pass')
    expect(result.findings).toEqual([])
  })

  it('派生边未表达 → 不通过', async () => {
    const root = home()
    const topId = syntheticUuid(11, 'c0de')
    const childIds = Array.from({ length: 10 }, (_, index) => syntheticUuid(12 + index, 'c0de'))
    const topPath = await writeCodexTopLevel(root, topId, 0)
    for (const [index, childId] of childIds.entries()) await writeCodexChild(root, childId, topId, 10 + index)
    const codexCensus = await censusCodex(root, { env: {} })
    const edges = childIds.map((childId) => ({ parent: topId, child: childId, status: 'open' }))
    const codexDb: CodexStateDb = { available: true, version: 1, candidates: 1, threads: [], edges, audit: null }
    // Only 9 of the 10 children are attached under their recorded parent: 1/10 = 10% > 1%.
    const subagents = childIds.slice(0, 9).map((childId) => ({ sessionId: childId, parentSessionId: topId }))
    const sessions = [{ ...codexSession(topId, topPath), subagents }]
    const result = lineageCheck(ctx({ codex: codexCensus, codexDb, readout: readout(sessions) }))
    expect(result.bySource.codex.swob.derivationExpressed?.value).toBe(9)
    expect(result.bySource.codex.swob.derivationNotExpressed?.value).toBe(1)
    expect(result.bySource.codex.verdict).toBe('fail')
    expect(result.verdict).toBe('fail')
    const finding = result.findings.find((entry) => entry.code === 'codex.derivation-edge-unexpressed')
    expect(finding).toMatchObject({ verdict: 'fail', source: 'codex', count: { value: 1 } })
  })

  it('未表达 ≤ 1% → 注意', async () => {
    const root = home()
    const topId = syntheticUuid(21, 'c0de')
    const childIds = Array.from({ length: 200 }, (_, index) => syntheticUuid(22 + index, 'c0de'))
    const topPath = await writeCodexTopLevel(root, topId, 0)
    for (const [index, childId] of childIds.entries()) await writeCodexChild(root, childId, topId, 10 + index)
    const codexCensus = await censusCodex(root, { env: {} })
    const edges = childIds.map((childId) => ({ parent: topId, child: childId, status: 'open' }))
    const codexDb: CodexStateDb = { available: true, version: 1, candidates: 1, threads: [], edges, audit: null }
    // 1 of 200 unattached: 0.5% <= 1%.
    const subagents = childIds.slice(0, 199).map((childId) => ({ sessionId: childId, parentSessionId: topId }))
    const sessions = [{ ...codexSession(topId, topPath), subagents }]
    const result = lineageCheck(ctx({ codex: codexCensus, codexDb, readout: readout(sessions) }))
    expect(result.bySource.codex.swob.derivationNotExpressed?.value).toBe(1)
    expect(result.bySource.codex.verdict).toBe('warn')
    expect(result.verdict).toBe('warn')
  })
})

describe('④ lineage — Codex fork edges (first-party, session_meta.forked_from_id)', () => {
  it('分叉边表达 → 通过', async () => {
    const root = home()
    const parentId = syntheticUuid(31, 'c0de')
    const childId = syntheticUuid(32, 'c0de')
    const parentPath = await writeCodexTopLevel(root, parentId, 0)
    const childPath = await writeCodexFork(root, childId, parentId, 10)
    const codexCensus = await censusCodex(root, { env: {} })
    const codexDb: CodexStateDb = { available: true, version: 1, candidates: 1, threads: [], edges: [], audit: null }
    const sessions = [codexSession(parentId, parentPath), codexSession(childId, childPath, { branchParentId: `codex:${parentId}` })]
    const result = lineageCheck(ctx({ codex: codexCensus, codexDb, readout: readout(sessions) }))
    expect(result.bySource.codex.oracle.forkTotal?.value).toBe(1)
    expect(result.bySource.codex.swob.forkExpressed?.value).toBe(1)
    expect(result.bySource.codex.swob.forkNotExpressed?.value).toBe(0)
    expect(result.bySource.codex.verdict).toBe('pass')
  })

  it('Codex 分叉边不一致 → 不通过', async () => {
    const root = home()
    const parentId = syntheticUuid(41, 'c0de')
    const childId = syntheticUuid(42, 'c0de')
    const parentPath = await writeCodexTopLevel(root, parentId, 0)
    const childPath = await writeCodexFork(root, childId, parentId, 10)
    const codexCensus = await censusCodex(root, { env: {} })
    const codexDb: CodexStateDb = { available: true, version: 1, candidates: 1, threads: [], edges: [], audit: null }
    // Swob never linked the fork (no branchParentId on the child) even though derivation edges are clean (none exist).
    const sessions = [codexSession(parentId, parentPath), codexSession(childId, childPath)]
    const result = lineageCheck(ctx({ codex: codexCensus, codexDb, readout: readout(sessions) }))
    expect(result.bySource.codex.swob.forkNotExpressed?.value).toBe(1)
    expect(result.bySource.codex.verdict).toBe('fail')
    expect(result.verdict).toBe('fail')
    const finding = result.findings.find((entry) => entry.code === 'codex.fork-edge-unexpressed')
    expect(finding).toMatchObject({ verdict: 'fail', source: 'codex' })
  })
})

describe('④ lineage — Claude physical evidence (continuation / subagent / resume-fork)', () => {
  it('续写与子 agent 边全部表达 → 通过', async () => {
    const root = home()
    const mainA = syntheticUuid(51)
    const mainB = syntheticUuid(52)
    const pathA = fs.realpathSync(writeSample(root, path.join(CLAUDE_PROJECT, `${mainA}.jsonl`), jsonl(claudeMessages(mainA, [syntheticUuid(510), syntheticUuid(511)], 'first'))))
    // mainB's own records carry mainA's sessionId (continuation evidence), and it has one subagent.
    const pathB = fs.realpathSync(writeSample(root, path.join(CLAUDE_PROJECT, `${mainB}.jsonl`), jsonl(claudeMessages(mainA, [syntheticUuid(520), syntheticUuid(521)], 'second'))))
    const subPath = fs.realpathSync(writeSample(root, path.join(CLAUDE_PROJECT, mainB, 'subagents', 'agent-1.jsonl'), jsonl([
      claude.subagentUser({ uuid: syntheticUuid(530), parentUuid: null, sessionId: mainB, timestamp: syntheticTime(0), cwd: CWD, agentId: 'a1', text: 'work' }),
      claude.subagentAssistant({ uuid: syntheticUuid(531), parentUuid: syntheticUuid(530), sessionId: mainB, timestamp: syntheticTime(1), cwd: CWD, agentId: 'a1', text: 'done', messageId: 'm1', requestId: 'r1' })
    ])))
    const claudeCensus = await censusClaude(root)
    // Swob merged the two files into one logical session (paths cover both), and the subagent is under that same session.
    const sessions = [{ ...claudeSession(mainA, pathA, { paths: [pathA, pathB] }), subagentPaths: [subPath], subagentIds: ['agent-1'] }]
    const result = lineageCheck(ctx({ claude: claudeCensus, readout: readout(sessions) }))
    expect(result.bySource['claude-code'].oracle.continuationTotal?.value).toBe(1)
    expect(result.bySource['claude-code'].swob.continuationNotExpressed?.value).toBe(0)
    expect(result.bySource['claude-code'].oracle.subagentTotal?.value).toBe(1)
    expect(result.bySource['claude-code'].swob.subagentExpressed?.value).toBe(1)
    expect(result.bySource['claude-code'].verdict).toBe('pass')
  })

  it('Claude 分歧只报观察（uuid 重叠边未连接不判不通过）', async () => {
    const root = home()
    const sharedUuids = Array.from({ length: 8 }, (_, index) => syntheticUuid(600 + index))
    const sessionA = syntheticUuid(61)
    const sessionB = syntheticUuid(62)
    const pathA = fs.realpathSync(writeSample(root, path.join(CLAUDE_PROJECT, `${sessionA}.jsonl`), jsonl(claudeMessages(sessionA, sharedUuids, 'orig'))))
    const pathB = fs.realpathSync(writeSample(root, path.join(CLAUDE_PROJECT, `${sessionB}.jsonl`), jsonl([
      ...claudeMessages(sessionB, sharedUuids, 'orig'),
      ...claudeMessages(sessionB, [syntheticUuid(700)], 'own')
    ])))
    const claudeCensus = await censusClaude(root)
    // Two independent, unconnected sessions: Swob never noticed the resume/fork (no branchParentId, no
    // continuationSessionIds, not merged into one logical session).
    const sessions = [claudeSession(sessionA, pathA), claudeSession(sessionB, pathB)]
    const result = lineageCheck(ctx({ claude: claudeCensus, readout: readout(sessions) }))
    expect(result.bySource['claude-code'].oracle.resumeForkTotal?.value).toBe(1)
    expect(result.bySource['claude-code'].swob.resumeForkNotExpressed?.value).toBe(1)
    const finding = result.findings.find((entry) => entry.code === 'claude.resume-fork-edge-unexpressed')
    // Reported (an observation) but never escalated past warn.
    expect(finding).toMatchObject({ verdict: 'warn', source: 'claude-code' })
    expect(result.bySource['claude-code'].verdict).toBe('warn')
    expect(result.bySource['claude-code'].verdict).not.toBe('fail')
    // Codex is absent (no data): the overall verdict is driven only by Claude's observation, still not fail.
    expect(result.verdict).toBe('warn')
    expect(result.verdict).not.toBe('fail')
  })
})

describe('④ lineage — not-applicable sources', () => {
  it('Cursor 没有关系解析能力，不适用', () => {
    expect(applicability('cursor', 'lineage', { presence: [{ source: 'cursor', roots: [], present: true }], selected: new Set(['cursor']) }))
      .toEqual({ verdict: 'not-applicable', reason: 'source.capability-unavailable' })
  })

  it('Swob 侧读数未就绪时，无法判定（不误判为不通过）', async () => {
    const root = home()
    const topId = syntheticUuid(81, 'c0de')
    await writeCodexTopLevel(root, topId, 0)
    const codexCensus = await censusCodex(root, { env: {} })
    const badReadout: SwobReadout = { ...readout([]), status: 'undetermined', reason: 'readout.not-isolated' }
    const result = lineageCheck(ctx({ codex: codexCensus, readout: badReadout }))
    expect(result.bySource.codex.verdict).toBe('undetermined')
    expect(result.verdict).toBe('undetermined')
    expect(result.reason).toBe('readout.not-isolated')
  })
})
