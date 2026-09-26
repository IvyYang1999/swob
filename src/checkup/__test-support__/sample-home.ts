/**
 * Test support: a synthetic HOME with Claude, Codex and legacy Kimi data,
 * carrying privacy canaries (absolute path, UUID session id, unique user
 * text, Codex rollout file name). Test-only; never imported by production code.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import Database from 'better-sqlite3'
import {
  LS,
  claude,
  codex,
  jsonl,
  syntheticTime,
  syntheticUuid,
  writeSample
} from '../self-test/samples'

export const CANARY = {
  absolutePath: '/Users/canary-user/secret-project',
  sessionUuid: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
  userText: '独角兽金丝雀原文：请勿把这句话写进任何报告或日志',
  rolloutName: 'rollout-2026-09-20T10-11-12-0196c1a0-7e57-7c1a-8a00-00000000ca11.jsonl',
  codexSessionUuid: '0196c1a0-7e57-7c1a-8a00-00000000ca11'
} as const

const SANDBOX_REFUSAL = 'refusing to write sample data outside the Vitest sandbox'

function nearestRealpath(target: string): string {
  const tail: string[] = []
  let current = path.resolve(target)
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...tail.reverse())
    } catch {
      const parent = path.dirname(current)
      if (parent === current) throw new Error(SANDBOX_REFUSAL)
      tail.push(path.basename(current))
      current = parent
    }
  }
}

/**
 * Fail closed unless `target` resolves strictly inside the per-file Vitest
 * sandbox created by src/main/__test-support__/isolate-home.ts.
 */
export function assertInsideTestSandbox(target: string): void {
  const root = process.env.SWOB_E2E_SANDBOX_ROOT
  if (process.env.NODE_ENV !== 'test' || !root) throw new Error(SANDBOX_REFUSAL)
  let realRoot: string
  try {
    realRoot = fs.realpathSync.native(root)
  } catch {
    throw new Error(SANDBOX_REFUSAL)
  }
  const relative = path.relative(realRoot, nearestRealpath(target))
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(SANDBOX_REFUSAL)
  }
}

export interface SampleHome {
  home: string
  claudeProject: string
  expected: {
    claudeUnits: number
    codexUnits: number
    claudeMainBadLines: number
    claudeMainLineSeparatorRecords: number
    codexTopLevelLegacyCompacted: number
    kimiLegacyUnits: number
  }
}

export function buildSampleHome(home: string): SampleHome {
  assertInsideTestSandbox(home)
  const cwd = CANARY.absolutePath
  const project = path.join('.claude', 'projects', cwd.replace(/[/.]/g, '-'))
  const sidA = CANARY.sessionUuid
  const sidB = syntheticUuid(2)
  const sidC = syntheticUuid(3)
  const at = (minute: number): string => syntheticTime(minute)
  writeSample(home, path.join(project, `${sidA}.jsonl`), jsonl([
    claude.user({ uuid: syntheticUuid(100), parentUuid: null, sessionId: sidA, timestamp: at(0), cwd, text: `${CANARY.userText}${LS}第二行` }),
    claude.assistant({ uuid: syntheticUuid(101), parentUuid: syntheticUuid(100), sessionId: sidA, timestamp: at(1), cwd, text: '收到', messageId: 'msg_a1', requestId: 'req_a1' }),
    claude.compactBoundary({ uuid: syntheticUuid(102), logicalParentUuid: syntheticUuid(101), parentUuid: null, sessionId: sidA, timestamp: at(2), cwd }),
    claude.compactSummary({ uuid: syntheticUuid(103), parentUuid: syntheticUuid(102), sessionId: sidA, timestamp: at(3), cwd }),
    claude.user({ uuid: syntheticUuid(104), parentUuid: syntheticUuid(103), sessionId: sidA, timestamp: at(4), cwd, text: CANARY.userText }),
    claude.assistant({ uuid: syntheticUuid(105), parentUuid: syntheticUuid(104), sessionId: sidA, timestamp: at(5), cwd, text: `ok ${CANARY.absolutePath}`, messageId: 'msg_a2', requestId: 'req_a2' })
  ]))
  writeSample(home, path.join(project, sidA, 'subagents', 'agent-canary.jsonl'), jsonl([
    claude.subagentUser({ uuid: syntheticUuid(110), parentUuid: null, sessionId: sidA, timestamp: at(6), cwd, agentId: 'canary', text: CANARY.userText }),
    claude.subagentAssistant({ uuid: syntheticUuid(111), parentUuid: syntheticUuid(110), sessionId: sidA, timestamp: at(7), cwd, agentId: 'canary', text: 'done', messageId: 'msg_s1', requestId: 'req_s1' })
  ]))
  writeSample(home, path.join(project, `${sidB}.jsonl`), jsonl([
    claude.user({ uuid: syntheticUuid(200), parentUuid: null, sessionId: sidB, timestamp: at(10), cwd, text: 'question' }),
    '{"parentUuid":"broken","isSidechain":false,"type":"user","message":',
    claude.assistant({ uuid: syntheticUuid(201), parentUuid: syntheticUuid(200), sessionId: sidB, timestamp: at(11), cwd, text: 'answer', messageId: 'msg_b1', requestId: 'req_b1' })
  ]))
  writeSample(home, path.join(project, `${sidC}.jsonl`), jsonl([{ type: 'summary', summary: 'title only', leafUuid: syntheticUuid(300) }]))

  const codexDir = path.join('.codex', 'sessions', '2026', '09', '20')
  const parent = CANARY.codexSessionUuid
  const child = syntheticUuid(401, 'c0de')
  const grandchild = syntheticUuid(402, 'c0de')
  const guardian = syntheticUuid(403, 'c0de')
  const empty = syntheticUuid(404, 'c0de')
  const first = { total: { input: 100, cached: 20, output: 10 }, last: { input: 100, cached: 20, output: 10 } }
  const summaryRow = codex.compacted({ timestamp: at(23), ordinal: 4, message: `summary ${CANARY.userText}` })
  writeSample(home, path.join(codexDir, CANARY.rolloutName), jsonl([
    codex.topLevelMeta({ timestamp: at(20), ordinal: 0, id: parent, cwd }),
    codex.userMessage({ timestamp: at(21), ordinal: 1, text: CANARY.userText }),
    codex.assistantMessage({ timestamp: at(22), ordinal: 2, text: 'working' }),
    codex.tokenCount({ timestamp: at(22), ordinal: 3, ...first }),
    summaryRow,
    codex.compacted({ timestamp: at(24), ordinal: 5, message: 'second summary' }),
    codex.functionCallOutput({ timestamp: at(25), ordinal: 6, callId: 'call_1', output: `line${LS}break` }),
    codex.agentMessage({ timestamp: at(26), ordinal: 7, text: 'done' })
  ]))
  const rollout = (id: string, minute: number): string => path.join(codexDir, `rollout-2026-09-20T10-${String(minute).padStart(2, '0')}-00-${id}.jsonl`)
  writeSample(home, rollout(child, 30), jsonl([
    codex.threadSpawnMeta({ timestamp: at(30), ordinal: 0, id: child, parentId: parent, cwd, historyStartOrdinal: 3 }),
    codex.tokenCount({ timestamp: at(31), ordinal: 1, ...first }),
    { ...summaryRow, timestamp: at(31), ordinal: 2 },
    codex.assistantMessage({ timestamp: at(32), ordinal: 3, text: 'child work' })
  ]))
  writeSample(home, rollout(grandchild, 33), jsonl([
    codex.threadSpawnMeta({ timestamp: at(33), ordinal: 0, id: grandchild, parentId: child, cwd, depth: 2 }),
    codex.assistantMessage({ timestamp: at(34), ordinal: 1, text: 'grandchild work' })
  ]))
  writeSample(home, rollout(guardian, 35), jsonl([
    codex.guardianMeta({ timestamp: at(35), ordinal: 0, id: guardian, parentId: parent, cwd }),
    codex.tokenCount({ timestamp: at(36), ordinal: 1, total: { input: 5, cached: 0, output: 1 }, last: { input: 5, cached: 0, output: 1 } }),
    codex.assistantMessage({ timestamp: at(36), ordinal: 2, text: 'approved' })
  ]))
  writeSample(home, rollout(empty, 37), jsonl([
    codex.topLevelMeta({ timestamp: at(37), ordinal: 0, id: empty, cwd }),
    codex.userMessage({ timestamp: at(38), ordinal: 1, text: 'anyone?' })
  ]))
  const stateDbPath = path.join(home, '.codex', 'state_5.sqlite')
  // Read-write open (journal_mode change): only ever inside the sandbox.
  assertInsideTestSandbox(stateDbPath)
  const db = new Database(stateDbPath)
  try {
    db.pragma('journal_mode = DELETE')
    db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, source TEXT NOT NULL, thread_source TEXT, archived INTEGER NOT NULL DEFAULT 0, tokens_used INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE thread_spawn_edges (parent_thread_id TEXT NOT NULL, child_thread_id TEXT NOT NULL PRIMARY KEY, status TEXT NOT NULL);`)
    const insert = db.prepare('INSERT INTO threads (id, rollout_path, source, thread_source) VALUES (?, ?, ?, ?)')
    insert.run(parent, path.join(fs.realpathSync(home), codexDir, CANARY.rolloutName), 'cli', 'user')
    insert.run(child, path.join(fs.realpathSync(home), rollout(child, 30)), 'cli', 'subagent')
    insert.run(grandchild, path.join(fs.realpathSync(home), rollout(grandchild, 33)), 'cli', 'subagent')
    insert.run(guardian, path.join(fs.realpathSync(home), rollout(guardian, 35)), 'cli', 'guardian_review')
    const edge = db.prepare('INSERT INTO thread_spawn_edges VALUES (?, ?, ?)')
    edge.run(parent, child, 'open')
    edge.run(child, grandchild, 'open')
  } finally {
    db.close()
  }
  writeSample(home, path.join('.kimi', 'sessions', 'ws', 'old-session', 'context.jsonl'), jsonl([{ role: 'user', content: CANARY.userText }]))
  return {
    home,
    claudeProject: path.join(home, project),
    expected: {
      claudeUnits: 4,
      codexUnits: 5,
      claudeMainBadLines: 1,
      claudeMainLineSeparatorRecords: 1,
      codexTopLevelLegacyCompacted: 2,
      kimiLegacyUnits: 1
    }
  }
}
