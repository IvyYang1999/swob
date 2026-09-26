import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { censusClaude, claudeLossKind } from './claude-census'
import { LS, claude, jsonl, syntheticTime, syntheticUuid, writeSample } from '../self-test/samples'

const homes: string[] = []
function home(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-census-'))
  homes.push(dir)
  return fs.realpathSync(dir)
}
afterEach(() => {
  for (const dir of homes.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const CWD = '/synthetic/project'
function base(seed: number, sessionId: string, parentUuid: string | null = null) {
  return { uuid: syntheticUuid(seed), parentUuid, sessionId, timestamp: syntheticTime(seed), cwd: CWD }
}

describe('Claude census', () => {
  it('classifies main, subagent (both layouts) and other JSONL units under every project root', async () => {
    const root = home()
    const sid = syntheticUuid(1)
    const project = path.join('.claude', 'projects', '-synthetic-project')
    writeSample(root, path.join(project, `${sid}.jsonl`), jsonl([
      claude.user({ ...base(10, sid), text: `hi${LS}there` }),
      claude.assistant({ ...base(11, sid, syntheticUuid(10)), text: 'hello', messageId: 'm1', requestId: 'r1' }),
      claude.compactBoundary({ ...base(12, sid), logicalParentUuid: syntheticUuid(11) }),
      claude.compactSummary({ ...base(13, sid, syntheticUuid(12)) }),
      claude.queueOperation({ sessionId: sid, timestamp: syntheticTime(14), content: `queued${LS}` })
    ]))
    writeSample(root, path.join(project, sid, 'subagents', 'agent-a.jsonl'), jsonl([
      claude.subagentUser({ ...base(20, sid), agentId: 'a', text: 'task' }),
      claude.subagentAssistant({ ...base(21, sid, syntheticUuid(20)), agentId: 'a', text: 'done', messageId: 'm2', requestId: 'r2' })
    ]))
    writeSample(root, path.join(project, 'subagents', 'nested', 'agent-b.jsonl'), jsonl([
      claude.subagentUser({ ...base(30, sid), agentId: 'b', text: 'task' })
    ]))
    writeSample(root, path.join(project, sid, 'tool-results', 'extra.jsonl'), jsonl([{ type: 'launched' }]))
    writeSample(root, path.join(project, 'notes.txt'), 'not a transcript')
    const windowSid = syntheticUuid(2)
    writeSample(root, path.join('.claude-window', 'acct', 'projects', '-p', `${windowSid}.jsonl`), jsonl([
      claude.user({ ...base(40, windowSid), text: 'window' })
    ]))
    fs.symlinkSync(path.join(root, project, `${sid}.jsonl`), path.join(root, project, 'linked.jsonl'))

    const census = await censusClaude(root)
    expect(census.roots.map((entry) => entry.fixedRoot)).toEqual(['~/.claude/projects', '~/.claude-window/*/projects'])
    expect(census.lowerSymlinks).toBe(1)
    expect(census.otherFiles).toBe(1)
    const byName = new Map(census.units.map((unit) => [path.basename(unit.path), unit]))
    expect(census.units).toHaveLength(5)
    const main = byName.get(`${sid}.jsonl`)!
    expect(main).toMatchObject({ kind: 'claude-main', basenameId: sid, conversationRecords: 4, userRecords: 2, assistantRecords: 1, compactBoundaryRows: 1, compactSummaryRows: 1 })
    expect(main.compactBoundaryUuids).toEqual([syntheticUuid(12)])
    expect(main.hazardKinds).toEqual({ user: 1, assistant: 0, tool_result: 0, meta: 1 })
    expect(main.stats.lineSeparatorRecords).toBe(2)
    expect(main.sessionIds).toEqual([sid])
    expect(main.timeRange.min).toBe(syntheticTime(10))
    expect(byName.get('agent-a.jsonl')).toMatchObject({ kind: 'claude-subagent', ownerDirName: sid, subagentsSegment: 2, subagentDepth: 0 })
    expect(byName.get('agent-b.jsonl')).toMatchObject({ kind: 'claude-subagent', ownerDirName: null, subagentsSegment: 1, subagentDepth: 1 })
    expect(byName.get('extra.jsonl')).toMatchObject({ kind: 'claude-other', conversationRecords: 0 })
    expect(byName.get(`${windowSid}.jsonl`)).toMatchObject({ kind: 'claude-main', fixedRoot: '~/.claude-window/*/projects' })
    for (const unit of census.units) {
      expect(unit.before).toEqual(unit.after)
      expect(unit.unreadable).toBe(false)
    }
  })

  it('classifies record kinds for loss attribution', () => {
    expect(claudeLossKind({ type: 'assistant' })).toBe('assistant')
    expect(claudeLossKind({ type: 'user', message: { content: 'x' } })).toBe('user')
    expect(claudeLossKind({ type: 'user', isMeta: true, message: { content: 'x' } })).toBe('meta')
    expect(claudeLossKind({ type: 'user', message: { content: [{ type: 'tool_result' }] } })).toBe('tool_result')
    expect(claudeLossKind({ type: 'last-prompt' })).toBe('meta')
  })

  it('returns an empty census when there are no Claude roots', async () => {
    const census = await censusClaude(home())
    expect(census).toMatchObject({ roots: [], units: [], lowerSymlinks: 0 })
  })
})
