import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import Database from 'better-sqlite3'
import {
  buildOpencodeSessionDetail,
  buildOpencodeSessionSummary,
  makeOpencodeSessionRef
} from './opencode-loader'
import { buildZcodeSessionDetail, buildZcodeSessionSummary, makeZcodeSessionRef } from './zcode-loader'
import { mergeTokenAccountings } from './token-accounting'
import { adaptSessionDetailV2 } from './unified-session-adapter-v2'
import {
  closeUsageFactStore,
  queryInsights,
  sessionUsageEvents,
  synchronizeUsageFacts
} from './usage-fact-store'
import type { AnalysisScope, UsageFact } from './analysis-contract'

function sqlite3Available(): boolean {
  try {
    execFileSync('sqlite3', ['-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const fixtureIt = sqlite3Available() ? it : it.skip
const scope: AnalysisScope = { range: 'all', metricBasis: 'billing' }

function usageFactTokens(fact: UsageFact): number {
  return fact.nonCachedInputTokens + fact.cacheReadTokens + fact.cacheWriteTokens + fact.outputTokens
}

function createOpenCodeGoldenDb(root: string): { dbPath: string; sessionId: string } {
  const sessionId = 'ses_golden_opencode'
  const dbPath = path.join(root, 'opencode.db')
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY, slug TEXT, directory TEXT, title TEXT, model TEXT, tokens TEXT, parent_id TEXT
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY, sessionID TEXT, data TEXT, time_created INTEGER
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY, sessionID TEXT, messageID TEXT, type TEXT, idx INTEGER, data TEXT
    );
    CREATE TABLE session_message (id TEXT PRIMARY KEY, sessionID TEXT, messageID TEXT);
  `)
  db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    sessionId,
    'golden-opencode',
    '/repo/golden-opencode',
    'OpenCode golden',
    'gpt-5.1',
    '{}',
    null
  )
  const insertMessage = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)')
  insertMessage.run('oc_user_1', sessionId, JSON.stringify({
    role: 'user', time: { created: '2026-07-08T10:00:00Z' }, path: { cwd: '/repo/golden-opencode' }
  }), 1783504800)
  insertMessage.run('oc_assistant_1', sessionId, JSON.stringify({
    role: 'assistant',
    parentID: 'oc_user_1',
    providerID: 'anthropic',
    modelID: 'claude-sonnet-4',
    time: { created: '2026-07-08T10:00:05Z' },
    tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 30, write: 10 } }
  }), 1783504805)
  insertMessage.run('oc_user_2', sessionId, JSON.stringify({
    role: 'user', parentID: 'oc_assistant_1', time: { created: '2026-07-08T10:01:00Z' }
  }), 1783504860)
  insertMessage.run('oc_assistant_2', sessionId, JSON.stringify({
    role: 'assistant',
    parentID: 'oc_user_2',
    providerID: 'openai',
    modelID: 'gpt-5.1',
    time: { created: '2026-07-08T10:01:05Z' },
    tokens: { input: 40, output: 10, reasoning: 2, cache: { read: 0, write: 0 } }
  }), 1783504865)
  const insertPart = db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)')
  insertPart.run('oc_text_u1', sessionId, 'oc_user_1', 'text', 0, JSON.stringify({ text: 'read file' }))
  insertPart.run('oc_text_a1', sessionId, 'oc_assistant_1', 'text', 0, JSON.stringify({ text: 'reading' }))
  insertPart.run('oc_tool_a1', sessionId, 'oc_assistant_1', 'tool', 1, JSON.stringify({
    id: 'oc_tool_1', name: 'read', input: { file_path: '/repo/golden-opencode/a.ts' }
  }))
  insertPart.run('oc_text_u2', sessionId, 'oc_user_2', 'text', 0, JSON.stringify({ text: 'continue' }))
  insertPart.run('oc_text_a2', sessionId, 'oc_assistant_2', 'text', 0, JSON.stringify({ text: 'done' }))
  db.close()
  return { dbPath, sessionId }
}

function createZCodeGoldenDb(root: string): {
  dbPath: string
  parentId: string
  childId: string
} {
  const parentId = 'sess_golden_zcode_parent'
  const childId = 'sess_golden_zcode_child'
  const dbPath = path.join(root, 'zcode.db')
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY, parent_id TEXT, slug TEXT, directory TEXT, title TEXT,
      time_created INTEGER, time_updated INTEGER
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, data TEXT
    );
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT);
    CREATE TABLE model_usage (
      id TEXT PRIMARY KEY, logical_request_id TEXT, attempt_index INTEGER, session_id TEXT,
      provider_id TEXT, model_id TEXT, status TEXT, started_at INTEGER, completed_at INTEGER,
      input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
      cache_creation_input_tokens INTEGER, cache_read_input_tokens INTEGER,
      provider_total_tokens INTEGER, computed_total_tokens INTEGER
    );
  `)
  const insertSession = db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?)')
  insertSession.run(parentId, null, 'z-parent', '/repo/golden-zcode', 'parent', 1783504800, 1783504865)
  insertSession.run(childId, parentId, 'z-child', '/repo/golden-zcode', 'child', 1783504900, 1783504965)
  const insertMessage = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)')
  const insertPart = db.prepare('INSERT INTO part VALUES (?, ?, ?, ?)')
  for (const [sessionId, suffix, created] of [
    [parentId, 'parent', 1783504800],
    [childId, 'child', 1783504900]
  ] as const) {
    insertMessage.run(`z_user_${suffix}`, sessionId, JSON.stringify({
      role: 'user', time: { created }, path: { cwd: '/repo/golden-zcode' }
    }), created)
    insertMessage.run(`z_assistant_${suffix}`, sessionId, JSON.stringify({
      role: 'assistant',
      parentID: `z_user_${suffix}`,
      time: { created: created + 5 },
      modelID: suffix === 'parent' ? 'glm-4.5' : 'gpt-5.1'
    }), created + 5)
    insertPart.run(`z_text_u_${suffix}`, sessionId, `z_user_${suffix}`, JSON.stringify({
      type: 'text', text: `${suffix} prompt`
    }))
    insertPart.run(`z_text_a_${suffix}`, sessionId, `z_assistant_${suffix}`, JSON.stringify({
      type: 'text', text: `${suffix} answer`
    }))
  }
  insertPart.run('z_tool_parent', parentId, 'z_assistant_parent', JSON.stringify({
    type: 'tool', id: 'z_tool_1', name: 'read', input: { file_path: '/repo/golden-zcode/a.ts' }
  }))
  const insertUsage = db.prepare('INSERT INTO model_usage VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  insertUsage.run('z_usage_shared_parent', 'request_shared', 0, parentId, 'zhipu', 'glm-4.5', 'completed',
    1783504805, 1783504806, 100, 20, 0, 10, 30, 120, 120)
  insertUsage.run('z_usage_parent_2', 'request_parent_2', 0, parentId, 'anthropic', 'claude-sonnet-4', 'completed',
    1783504865, 1783504866, 40, 10, 0, 0, 0, 50, 50)
  insertUsage.run('z_usage_shared_child', 'request_shared', 0, childId, 'zhipu', 'glm-4.5', 'completed',
    1783504805, 1783504806, 100, 20, 0, 10, 30, 120, 120)
  insertUsage.run('z_usage_child_1', 'request_child_1', 0, childId, 'openai', 'gpt-5.1', 'completed',
    1783504905, 1783504906, 60, 15, 0, 0, 10, 75, 75)
  for (const [suffix, status] of [
    ['failed', 'failed'],
    ['pending', 'pending'],
    ['cancelled', 'cancelled'],
    ['unknown', 'succeeded'],
    ['whitespace', ' completed '],
    ['missing', null]
  ] as const) {
    insertUsage.run(
      `z_usage_excluded_${suffix}`,
      `request_excluded_${suffix}`,
      0,
      parentId,
      'openai',
      'gpt-5.1',
      status,
      1783504920,
      null,
      9_000,
      1_000,
      0,
      0,
      0,
      10_000,
      10_000
    )
  }
  db.close()
  return { dbPath, parentId, childId }
}

describe('t183 SQLite agent golden reconciliation', () => {
  fixtureIt('multi-turn/tool/model switch/fork source DB = UsageEvent billing view = ledger', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-t183-golden-'))
    const previousUsageIndex = process.env.SWOB_USAGE_INDEX_PATH
    process.env.SWOB_USAGE_INDEX_PATH = path.join(root, 'usage-facts.db')
    closeUsageFactStore()
    try {
      const openCode = createOpenCodeGoldenDb(root)
      const openCodeSummary = await buildOpencodeSessionSummary(
        makeOpencodeSessionRef(openCode.sessionId, openCode.dbPath)
      )
      expect(openCodeSummary).not.toBeNull()
      const openCodeSource = new Database(openCode.dbPath, { readonly: true })
      const openCodeSourceTotal = (openCodeSource.prepare(`
        SELECT SUM(
          COALESCE(json_extract(data, '$.tokens.input'), 0) +
          COALESCE(json_extract(data, '$.tokens.cache.read'), 0) +
          COALESCE(json_extract(data, '$.tokens.cache.write'), 0) +
          COALESCE(json_extract(data, '$.tokens.output'), 0) +
          COALESCE(json_extract(data, '$.tokens.reasoning'), 0)
        ) AS total
        FROM message
        WHERE json_extract(data, '$.role') = 'assistant'
      `).get() as { total: number }).total
      openCodeSource.close()

      expect(openCodeSummary!.tokenAccounting!.usageEvents).toHaveLength(2)
      expect(openCodeSummary!.tokenAccounting!.billingTotal).toBe(openCodeSourceTotal)
      expect(openCodeSummary!.tokenAccounting!.usageEvents.map((event) => event.providerRaw)).toEqual([
        'anthropic', 'openai'
      ])
      expect(openCodeSummary!.models).toEqual(expect.arrayContaining(['claude-sonnet-4', 'gpt-5.1']))
      expect(openCodeSummary!.toolUsage).toEqual({ Read: 1 })
      const openCodeDetail = await buildOpencodeSessionDetail(
        makeOpencodeSessionRef(openCode.sessionId, openCode.dbPath)
      )
      const openCodeV2Usage = adaptSessionDetailV2(openCodeDetail!).events
        .filter((event) => event.kind === 'usage')
        .map((event) => event.payload as any)
      expect(openCodeV2Usage).toEqual(expect.arrayContaining([
        expect.objectContaining({
          eventId: 'oc_assistant_1',
          billingFactKey: 'opencode:message:oc_assistant_1',
          output: { total: 25, visible: 20, reasoning: 5 },
          relations: { cacheRead: 'independent', cacheWrite: 'independent', reasoning: 'independent' }
        })
      ]))
      synchronizeUsageFacts([openCodeSummary!], [])
      const openCodeLedger = sessionUsageEvents(openCode.sessionId, scope).events
      expect(openCodeLedger.reduce((sum, fact) => sum + usageFactTokens(fact), 0)).toBe(openCodeSourceTotal)
      expect(openCodeLedger).toHaveLength(2)

      const zcode = createZCodeGoldenDb(root)
      const parent = await buildZcodeSessionSummary(makeZcodeSessionRef(zcode.parentId, zcode.dbPath))
      const child = await buildZcodeSessionSummary(makeZcodeSessionRef(zcode.childId, zcode.dbPath))
      expect(parent).not.toBeNull()
      expect(child).not.toBeNull()
      expect(parent!.tokenAccounting!.warnings).toEqual([
        'zcode-model-usage-status-excluded:cancelled:1',
        'zcode-model-usage-status-excluded:failed:1',
        'zcode-model-usage-status-excluded:missing:1',
        'zcode-model-usage-status-excluded:pending:1',
        'zcode-model-usage-status-excluded:unknown:2'
      ])
      expect(parent!.toolUsage).toEqual({ Read: 1 })
      expect(child!.branchParentId).toBe(zcode.parentId)
      const childDetail = await buildZcodeSessionDetail(makeZcodeSessionRef(zcode.childId, zcode.dbPath))
      const childV2Usage = adaptSessionDetailV2(childDetail!).events
        .filter((event) => event.kind === 'usage')
        .map((event) => event.payload as any)
      expect(childV2Usage).toEqual(expect.arrayContaining([
        expect.objectContaining({
          eventId: 'z_usage_child_1',
          billingFactKey: 'zcode:request:request_child_1:attempt:0',
          relations: {
            cacheRead: 'subset-of-input',
            cacheWrite: 'subset-of-input',
            reasoning: 'provider-defined'
          }
        })
      ]))

      const zcodeSource = new Database(zcode.dbPath, { readonly: true })
      const zcodeSourceBillingTotal = (zcodeSource.prepare(`
        SELECT SUM(request_total) AS total
        FROM (
          SELECT logical_request_id, attempt_index, MAX(computed_total_tokens) AS request_total
          FROM model_usage
          WHERE status = 'completed'
          GROUP BY logical_request_id, attempt_index
        )
      `).get() as { total: number }).total
      zcodeSource.close()
      const merged = mergeTokenAccountings([parent!.tokenAccounting!, child!.tokenAccounting!])
      expect(merged.usageEvents).toHaveLength(4)
      expect(merged.billingTotal).toBe(zcodeSourceBillingTotal)
      expect(merged.warnings).toEqual(expect.arrayContaining([
        'zcode-model-usage-status-excluded:cancelled:1',
        'zcode-model-usage-status-excluded:failed:1',
        'zcode-model-usage-status-excluded:missing:1',
        'zcode-model-usage-status-excluded:pending:1',
        'zcode-model-usage-status-excluded:unknown:2'
      ]))

      synchronizeUsageFacts([openCodeSummary!, parent!, child!], [])
      const zcodeAuditFacts = [
        ...sessionUsageEvents(zcode.parentId, scope).events,
        ...sessionUsageEvents(zcode.childId, scope).events
      ]
      expect(zcodeAuditFacts).toHaveLength(4)
      expect(zcodeAuditFacts.filter((fact) => fact.billingIncluded)).toHaveLength(3)
      expect(queryInsights({ ...scope, sources: ['zcode'] }, 'global').total.processedTokens)
        .toBe(zcodeSourceBillingTotal)
    } finally {
      closeUsageFactStore()
      if (previousUsageIndex === undefined) delete process.env.SWOB_USAGE_INDEX_PATH
      else process.env.SWOB_USAGE_INDEX_PATH = previousUsageIndex
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
