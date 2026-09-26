import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import {
  censusCodex,
  codexHomes,
  codexRoleFromMeta,
  codexUnitParentId,
  countForkUsageCopies,
  countInheritedCodexMarkers
} from './codex-census'
import { findCodexStateDb, readCodexStateDb } from './codex-state-db'
import { LS, codex, codexRolloutPath, jsonl, syntheticTime, syntheticUuid, writeSample } from '../self-test/samples'

const homes: string[] = []
function home(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-census-'))
  homes.push(dir)
  return fs.realpathSync(dir)
}
afterEach(() => {
  for (const dir of homes.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const CWD = '/synthetic/project'
const usage = { total: { input: 10, cached: 2, output: 1 }, last: { input: 10, cached: 2, output: 1 } }

describe('Codex census', () => {
  it('derives roles from session_meta and counts markers, hazards and snapshots', async () => {
    const root = home()
    const top = syntheticUuid(1, 'c0de')
    const spawn = syntheticUuid(2, 'c0de')
    const guardian = syntheticUuid(3, 'c0de')
    writeSample(root, codexRolloutPath(top, 0), jsonl([
      codex.topLevelMeta({ timestamp: syntheticTime(0), ordinal: 0, id: top, cwd: CWD }),
      codex.userMessage({ timestamp: syntheticTime(1), ordinal: 1, text: `hi${LS}` }),
      codex.assistantMessage({ timestamp: syntheticTime(2), ordinal: 2, text: 'ok' }),
      codex.functionCallOutput({ timestamp: syntheticTime(3), ordinal: 3, callId: 'c1', output: `out${LS}` }),
      codex.compacted({ timestamp: syntheticTime(4), ordinal: 4, message: 'summary' }),
      codex.contextCompactionEvent({ timestamp: syntheticTime(5), ordinal: 5, threadId: top, turnId: 't1', itemId: 'i1' }),
      codex.tokenCount({ timestamp: syntheticTime(6), ordinal: 6, ...usage })
    ]))
    writeSample(root, codexRolloutPath(spawn, 10), jsonl([
      codex.threadSpawnMeta({ timestamp: syntheticTime(10), ordinal: 0, id: spawn, parentId: top, cwd: CWD, depth: 1 }),
      codex.tokenCount({ timestamp: syntheticTime(11), ordinal: 1, ...usage }),
      codex.agentMessage({ timestamp: syntheticTime(12), ordinal: 2, text: 'done' })
    ]))
    writeSample(root, codexRolloutPath(guardian, 20, 'archived_sessions'), jsonl([
      codex.guardianMeta({ timestamp: syntheticTime(20), ordinal: 0, id: guardian, parentId: top, cwd: CWD })
    ]))
    writeSample(root, path.join('.codex', 'sessions', 'notes.jsonl'), jsonl([{ type: 'note' }]))
    const census = await censusCodex(root, { env: {} })
    expect(census.roots.map((entry) => entry.fixedRoot)).toEqual(['~/.codex/sessions', '~/.codex/archived_sessions'])
    const byKind = new Map(census.units.map((unit) => [unit.kind, unit]))
    expect(census.units).toHaveLength(4)
    const topUnit = byKind.get('codex-top-level')!
    expect(topUnit).toMatchObject({ isRollout: true, userMessages: 1, assistantSide: 1, sessionMetaCount: 1, usageSnapshots: 1 })
    expect(topUnit.compaction).toMatchObject({ legacy: 1, items: 0, contextCompactionEvents: 1, contextCompactedEvents: 0 })
    expect(topUnit.compaction.markerSigs).toHaveLength(1)
    expect(topUnit.hazardKinds).toEqual({ user: 1, assistant: 0, tool_result: 1, meta: 0 })
    expect(topUnit.hazardTypes).toEqual({ 'response_item:message': 1, 'response_item:function_call_output': 1 })
    expect(topUnit.fileNameId).toBe(top)
    expect(byKind.get('codex-thread-spawn')).toMatchObject({ meta: { id: spawn, role: 'thread-spawn', parentThreadId: top, forkedFromId: top, depth: 1 } })
    expect(byKind.get('codex-guardian')).toMatchObject({ container: 'archived_sessions', meta: { role: 'guardian', parentThreadId: top } })
    expect(byKind.get('codex-non-rollout')).toMatchObject({ isRollout: false })
    expect(codexUnitParentId(byKind.get('codex-guardian')!)).toBe(top)
    expect(countForkUsageCopies(census.units)).toEqual({ rewritten: 1, sameTimestamp: 0, childUnits: 1 })
  })

  it('classifies roles like Codex metadata does', () => {
    expect(codexRoleFromMeta({ id: 'a', source: 'cli' }).role).toBe('top-level')
    expect(codexRoleFromMeta({ id: 'a', source: 'vscode', thread_source: 'subagent', parent_thread_id: 'p' })).toMatchObject({ role: 'subagent', parentThreadId: 'p' })
    expect(codexRoleFromMeta({ id: 'a', source: { subagent: { other: 'guardian' } }, parent_thread_id: 'p' }).role).toBe('guardian')
    expect(codexRoleFromMeta({ id: 'a', source: { subagent: { thread_spawn: { parent_thread_id: 'p', depth: 2 } } } })).toMatchObject({ role: 'thread-spawn', parentThreadId: 'p', depth: 2 })
  })

  it('adds CODEX_HOME and codex-homes.json roots once (deduplicated by real path)', async () => {
    const root = home()
    const extra = home()
    const envHome = home()
    fs.mkdirSync(path.join(root, '.codex', 'sessions'), { recursive: true })
    fs.mkdirSync(path.join(extra, 'sessions'), { recursive: true })
    fs.mkdirSync(path.join(envHome, 'archived_sessions'), { recursive: true })
    writeSample(root, path.join('.claude-session-manager', 'codex-homes.json'), JSON.stringify({ version: 1, homes: [extra, path.join(root, '.codex')] }))
    const homesFound = codexHomes(root, { CODEX_HOME: envHome })
    expect(homesFound.homes.map((entry) => entry.origin)).toEqual(['default', 'environment', 'additional'])
    expect(homesFound).toMatchObject({ codexHomeEnvSet: true, additionalHomes: 2 })
    const census = await censusCodex(root, { env: { CODEX_HOME: envHome } })
    expect(census.roots.map((entry) => entry.fixedRoot)).toEqual(['~/.codex/sessions', '$CODEX_HOME/archived_sessions', '<additional-codex-home>/sessions'])
  })

  it('counts compaction markers copied into forked children', async () => {
    const root = home()
    const parent = syntheticUuid(5, 'c0de')
    const child = syntheticUuid(6, 'c0de')
    const row = codex.compacted({ timestamp: syntheticTime(1), ordinal: 1, message: 'parent summary' })
    writeSample(root, codexRolloutPath(parent, 0), jsonl([codex.topLevelMeta({ timestamp: syntheticTime(0), ordinal: 0, id: parent, cwd: CWD }), row]))
    writeSample(root, codexRolloutPath(child, 5), jsonl([
      codex.threadSpawnMeta({ timestamp: syntheticTime(5), ordinal: 0, id: child, parentId: parent, cwd: CWD }),
      { ...row, timestamp: syntheticTime(6) },
      codex.compacted({ timestamp: syntheticTime(7), ordinal: 2, message: 'own summary' })
    ]))
    const census = await censusCodex(root, { env: {} })
    expect(countInheritedCodexMarkers(census.units)).toEqual({ inherited: 1, childUnits: 1 })
  })
})

function makeStateDb(file: string, threads: Array<[string, string | null, string]>, edges: Array<[string, string]>): void {
  const db = new Database(file)
  try {
    db.pragma('journal_mode = DELETE')
    db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, source TEXT NOT NULL, thread_source TEXT, archived INTEGER NOT NULL DEFAULT 0, tokens_used INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE thread_spawn_edges (parent_thread_id TEXT NOT NULL, child_thread_id TEXT NOT NULL PRIMARY KEY, status TEXT NOT NULL);`)
    const insert = db.prepare('INSERT INTO threads (id, rollout_path, source, thread_source) VALUES (?, ?, ?, ?)')
    for (const [id, rollout, source] of threads) insert.run(id, rollout ?? '', 'cli', source)
    const edge = db.prepare('INSERT INTO thread_spawn_edges VALUES (?, ?, ?)')
    for (const [parent, child] of edges) edge.run(parent, child, 'open')
  } finally {
    db.close()
  }
}

describe('Codex state db (read-only)', () => {
  it('picks the highest state_<N>.sqlite and reads threads and spawn edges without leaving sidecars', () => {
    const root = home()
    const codexHome = path.join(root, '.codex')
    fs.mkdirSync(codexHome, { recursive: true })
    makeStateDb(path.join(codexHome, 'state_3.sqlite'), [['old', '/x', 'user']], [])
    makeStateDb(path.join(codexHome, 'state_5.sqlite'), [['t1', '/rollout-a.jsonl', 'user'], ['t2', null, 'subagent']], [['t1', 't2']])
    const before = fs.readdirSync(codexHome).sort()
    expect(findCodexStateDb(codexHome)).toMatchObject({ version: 5, candidates: 2 })
    const db = readCodexStateDb(codexHome)
    expect(db).toMatchObject({ available: true, version: 5, candidates: 2 })
    expect(db.threads).toEqual([
      { id: 't1', rolloutPath: '/rollout-a.jsonl', threadSource: 'user', archived: false },
      { id: 't2', rolloutPath: null, threadSource: 'subagent', archived: false }
    ])
    expect(db.edges).toEqual([{ parent: 't1', child: 't2', status: 'open' }])
    expect(db.audit?.sidecarsTouched).toBe(0)
    expect(fs.readdirSync(codexHome).sort()).toEqual(before)
  })

  it('reports a missing or unreadable database without throwing', () => {
    const root = home()
    expect(readCodexStateDb(root)).toMatchObject({ available: false, reason: 'codex.state-db-missing' })
    fs.writeFileSync(path.join(root, 'state_7.sqlite'), 'not a database')
    expect(readCodexStateDb(root)).toMatchObject({ available: false, reason: 'codex.state-db-unreadable', version: 7 })
  })
})
