/**
 * ⑤ Token (C2a). Six scenarios per the task book: consistent (pass) / 0.5% deviation (warn) / 2% deviation
 * (fail) / forked duplicate copies deduped correctly (pass) / Cursor not applicable ([U]) / a registered
 * calibration difference (warn, not fail even past the raw 1% threshold).
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { censusClaude } from '../census/claude-census'
import { censusCodex } from '../census/codex-census'
import type { ReadoutSession, ReadoutSessionTokens, SwobReadout } from '../readout'
import { unavailableReadoutTokens } from '../readout'
import { claude, claudeProjectDir, codex, codexRolloutPath, jsonl, syntheticTime, syntheticUuid, writeSample } from '../self-test/samples'
import type { CheckContext } from './common'
import { tokensCheck } from './tokens'

const homes: string[] = []
function home(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkup-tokens-'))
  homes.push(dir)
  return fs.realpathSync(dir)
}
afterEach(() => {
  for (const dir of homes.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const CWD = '/synthetic/tokens-project'

function readout(sessions: ReadoutSession[]): SwobReadout {
  return { status: 'ok', sessions, claudeParsed: new Map(), discovered: { claudeMain: new Set(), codex: new Set() }, attributedChildIds: new Set(), consoleLines: 0, timingsMs: {} }
}

function ctx(partial: Partial<CheckContext> & Pick<CheckContext, 'readout'>): CheckContext {
  return {
    salt: 'tokens-test-salt', selected: new Set(['claude-code', 'codex', 'cursor']),
    claude: null, codex: null, codexDb: null, unscanned: null, presence: [], changed: new Set(), ...partial
  }
}

function tokens(components: Partial<NonNullable<ReadoutSessionTokens['components']>>, calibrationDeltaTokens = 0): ReadoutSessionTokens {
  return {
    provenance: 'reported',
    components: { nonCachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, ...components },
    billingTotal: (components.nonCachedInput ?? 0) + (components.cacheRead ?? 0) + (components.cacheWrite ?? 0) + (components.output ?? 0),
    cacheWriteCalibrationDeltaTokens: calibrationDeltaTokens
  }
}

function codexSession(id: string, filePath: string, sessionTokens: ReadoutSessionTokens): ReadoutSession {
  return { source: 'codex', sessionId: id, primaryPath: filePath, paths: [filePath], subagentPaths: [], subagentIds: [], compactCount: 0, virtual: false, tokens: sessionTokens }
}

function claudeSession(id: string, filePath: string, sessionTokens: ReadoutSessionTokens, extra: Partial<ReadoutSession> = {}): ReadoutSession {
  return { source: 'claude-code', sessionId: id, primaryPath: filePath, paths: [filePath], subagentPaths: [], subagentIds: [], compactCount: 0, virtual: false, tokens: sessionTokens, ...extra }
}

/** Real Claude file at `<project>/<sessionId>.jsonl` (real physical Claude naming: by sessionId, never `.id`). */
function writeClaudeFile(root: string, project: string, sessionId: string, rows: Array<Record<string, unknown>>): string {
  return fs.realpathSync(writeSample(root, path.join(project, `${sessionId}.jsonl`), jsonl(rows)))
}

async function codexUnitAt(root: string, id: string, minute: number, usage: { input: number; cached?: number; output: number }): Promise<string> {
  const value = { input: usage.input, cached: usage.cached ?? 0, output: usage.output }
  const filePath = fs.realpathSync(writeSample(root, codexRolloutPath(id, minute), jsonl([
    codex.topLevelMeta({ timestamp: syntheticTime(minute), ordinal: 0, id, cwd: CWD }),
    codex.userMessage({ timestamp: syntheticTime(minute + 1), ordinal: 1, text: 'hello' }),
    codex.tokenCount({ timestamp: syntheticTime(minute + 2), ordinal: 2, total: value, last: value })
  ])))
  return filePath
}

describe('⑤ tokens', () => {
  it('consistent Swob and oracle totals, every session an exact match → pass', async () => {
    const root = home()
    const a = syntheticUuid(1, 'c0de')
    const b = syntheticUuid(2, 'c0de')
    const pathA = await codexUnitAt(root, a, 0, { input: 1000, cached: 200, output: 50 })
    const pathB = await codexUnitAt(root, b, 10, { input: 500, cached: 0, output: 25 })
    const codexCensus = await censusCodex(root, { env: {} })
    const result = tokensCheck(ctx({
      codex: codexCensus,
      readout: readout([
        codexSession(a, pathA, tokens({ nonCachedInput: 800, cacheRead: 200, output: 50 })),
        codexSession(b, pathB, tokens({ nonCachedInput: 500, cacheRead: 0, output: 25 }))
      ])
    }))
    expect(result.bySource.codex.verdict).toBe('pass')
    expect(result.bySource.codex.swob.billingTotalDeviationPct.value).toBe(0)
    expect(result.bySource.codex.swob.sessionsEqual.value).toBe(2)
    expect(result.bySource.codex.swob.sessionsCompared.value).toBe(2)
    expect(result.findings.filter((finding) => finding.source === 'codex')).toEqual([])
    expect(result.verdict).toBe('pass')
  })

  it('0.5% deviation → warn (note), not fail', async () => {
    const root = home()
    const id = syntheticUuid(3, 'c0de')
    const filePath = await codexUnitAt(root, id, 0, { input: 1000, cached: 0, output: 0 })
    const codexCensus = await censusCodex(root, { env: {} })
    // Oracle billingTotal is 1000; Swob reports 1005 (+0.5%).
    const result = tokensCheck(ctx({
      codex: codexCensus,
      readout: readout([codexSession(id, filePath, tokens({ nonCachedInput: 1005 }))])
    }))
    expect(result.bySource.codex.verdict).toBe('warn')
    expect(result.bySource.codex.swob.billingTotalDeviationPct.value).toBe(0.5)
    const finding = result.findings.find((entry) => entry.source === 'codex' && entry.code === 'tokens.deviation-note')
    expect(finding?.verdict).toBe('warn')
    expect(finding?.count.value).toBe(0.5)
  })

  it('2% deviation → fail (exceeds the 1% threshold, no known calibration difference explains it)', async () => {
    const root = home()
    const id = syntheticUuid(4, 'c0de')
    const filePath = await codexUnitAt(root, id, 0, { input: 1000, cached: 0, output: 0 })
    const codexCensus = await censusCodex(root, { env: {} })
    const result = tokensCheck(ctx({
      codex: codexCensus,
      readout: readout([codexSession(id, filePath, tokens({ nonCachedInput: 1020 }))])
    }))
    expect(result.bySource.codex.verdict).toBe('fail')
    expect(result.bySource.codex.swob.billingTotalDeviationPct.value).toBe(2)
    const finding = result.findings.find((entry) => entry.source === 'codex' && entry.code === 'tokens.deviation-high')
    expect(finding?.verdict).toBe('fail')
  })

  it('a forked child copying the parent\'s token_count snapshots is deduplicated correctly, not double-counted → pass', async () => {
    const root = home()
    const parent = syntheticUuid(5, 'c0de')
    const child = syntheticUuid(6, 'c0de')
    const usage = { input: 300, cached: 50, output: 20 }
    const parentPath = fs.realpathSync(writeSample(root, codexRolloutPath(parent, 0), jsonl([
      codex.topLevelMeta({ timestamp: syntheticTime(0), ordinal: 0, id: parent, cwd: CWD }),
      codex.userMessage({ timestamp: syntheticTime(1), ordinal: 1, text: 'task' }),
      codex.tokenCount({ timestamp: syntheticTime(2), ordinal: 2, total: usage, last: usage })
    ])))
    // Child copies the exact same cumulative snapshot (same total+last), then adds one genuinely new one.
    const own = { input: 350, cached: 50, output: 25 }
    fs.realpathSync(writeSample(root, codexRolloutPath(child, 10), jsonl([
      codex.threadSpawnMeta({ timestamp: syntheticTime(10), ordinal: 0, id: child, parentId: parent, cwd: CWD, historyStartOrdinal: 1 }),
      { ...codex.tokenCount({ timestamp: syntheticTime(11), ordinal: 1, total: usage, last: usage }) },
      codex.tokenCount({ timestamp: syntheticTime(12), ordinal: 2, total: own, last: { input: 50, cached: 0, output: 5 } })
    ])))
    const codexCensus = await censusCodex(root, { env: {} })
    // Swob (mirroring the kernel's own merge) attaches the child's usage into the parent's session and
    // dedupes the copied prefix the same way the oracle does: 250(non-cached)+50(cache)+20 + the child's
    // one genuinely new snapshot (50/0/5) = 300/50/25.
    const result = tokensCheck(ctx({
      codex: codexCensus,
      readout: readout([codexSession(parent, parentPath, tokens({ nonCachedInput: 300, cacheRead: 50, output: 25 }))])
    }))
    expect(result.bySource.codex.oracle.billingTotal.value).toBe(375) // 300+50+25, the copied snapshot counted once
    expect(result.bySource.codex.verdict).toBe('pass')
    expect(result.bySource.codex.swob.sessionsEqual.value).toBe(1)
  })

  it('Cursor has no authoritative usage counters: not-applicable, [U] — never silently 0', () => {
    const result = tokensCheck(ctx({ readout: readout([]) }))
    expect(result.bySource.cursor).toEqual({
      verdict: 'not-applicable',
      swob: { status: { value: null, label: 'unavailable', unit: 'checks', reason: 'source.capability-unavailable' } },
      oracle: {},
      oracleIds: []
    })
  })

  it('a Claude cache-write aggregate-vs-breakdown gap fully covered by the registered calibration delta → warn, not fail', async () => {
    const root = home()
    const sid = syntheticUuid(7)
    const project = path.join('.claude', 'projects', '-synthetic-tokens-project')
    const filePath = fs.realpathSync(writeSample(root, path.join(project, `${sid}.jsonl`), jsonl([
      claude.user({ uuid: syntheticUuid(700), parentUuid: null, sessionId: sid, timestamp: syntheticTime(0), cwd: CWD, text: 'hi' }),
      // ccusage-style oracle reads the raw aggregate cache_creation_input_tokens (1000).
      claude.assistant({
        uuid: syntheticUuid(701), parentUuid: syntheticUuid(700), sessionId: sid, timestamp: syntheticTime(1), cwd: CWD,
        text: 'ok', messageId: 'm7', requestId: 'r7', usage: { input: 10, cacheWrite: 1000, cacheRead: 0, output: 5 }
      })
    ])))
    const claudeCensus = await censusClaude(root)
    // Swob billed the 5m/1h breakdown (600) instead of the aggregate (1000): billingTotal is 400 lower
    // (10+0+600+5=615 vs oracle's 10+0+1000+5=1015), a gap of 400 — exactly the registered calibration delta.
    const result = tokensCheck(ctx({
      claude: claudeCensus,
      readout: readout([claudeSession(sid, filePath, tokens({ nonCachedInput: 10, cacheRead: 0, cacheWrite: 600, output: 5 }, 400))])
    }))
    expect(result.bySource['claude-code'].oracle.cacheWrite.value).toBe(1000)
    expect(result.bySource['claude-code'].swob.cacheWrite.value).toBe(600)
    const finding = result.findings.find((entry) => entry.source === 'claude-code' && entry.code === 'tokens.cache-write-calibration-difference')
    expect(finding).toBeTruthy()
    expect(result.findings.find((entry) => entry.source === 'claude-code' && entry.code === 'tokens.deviation-high')).toBeUndefined()
    expect(result.bySource['claude-code'].verdict).toBe('warn')
  })
})

describe('⑤ tokens — C2a-2 deliverable 1: branch-family grouping', () => {
  it('an owner + a split-cluster child (`.id` in "sessionId:branch-N" form) are compared once: the on-disk-duplicated shared prefix is deduped by the oracle union, not double-counted; an unrelated session is not swept in', async () => {
    const root = home()
    const project = path.join('.claude', 'projects', claudeProjectDir(CWD))
    const ownerId = syntheticUuid(900)
    const childId = syntheticUuid(901)
    const otherId = syntheticUuid(902)
    const sharedUuid = syntheticUuid(910)
    const startUuid = syntheticUuid(911)

    // Owner's file: the shared assistant row only.
    const ownerPath = writeClaudeFile(root, project, ownerId, [
      claude.user({ uuid: startUuid, parentUuid: null, sessionId: ownerId, timestamp: syntheticTime(0), cwd: CWD, text: 'start' }),
      claude.assistant({
        uuid: sharedUuid, parentUuid: startUuid, sessionId: ownerId, timestamp: syntheticTime(1), cwd: CWD, text: 'shared',
        messageId: 'm-shared', requestId: 'r-shared', usage: { input: 100, output: 20 }
      })
    ])
    // Child's file: an on-disk copy of the *same* shared row (identical messageId/requestId — the physical
    // duplication C2a's real-HOME investigation found across branch-linked top-level files) plus the
    // child's own independent tail.
    const childPath = writeClaudeFile(root, project, childId, [
      claude.user({ uuid: startUuid, parentUuid: null, sessionId: childId, timestamp: syntheticTime(0), cwd: CWD, text: 'start' }),
      claude.assistant({
        uuid: sharedUuid, parentUuid: startUuid, sessionId: childId, timestamp: syntheticTime(1), cwd: CWD, text: 'shared',
        messageId: 'm-shared', requestId: 'r-shared', usage: { input: 100, output: 20 }
      }),
      claude.assistant({
        uuid: syntheticUuid(912), parentUuid: sharedUuid, sessionId: childId, timestamp: syntheticTime(2), cwd: CWD, text: 'own',
        messageId: 'm-child-own', requestId: 'r-child-own', usage: { input: 50, output: 10 }
      })
    ])
    // Unrelated, independent session: its own row only, no link to owner/child.
    const otherPath = writeClaudeFile(root, project, otherId, [
      claude.user({ uuid: syntheticUuid(920), parentUuid: null, sessionId: otherId, timestamp: syntheticTime(0), cwd: CWD, text: 'hi' }),
      claude.assistant({
        uuid: syntheticUuid(921), parentUuid: syntheticUuid(920), sessionId: otherId, timestamp: syntheticTime(1), cwd: CWD, text: 'ok',
        messageId: 'm-other', requestId: 'r-other', usage: { input: 30, output: 5 }
      })
    ])
    const claudeCensus = await censusClaude(root)

    // F1m-correct kernel behaviour (hand-specified, as every other test in this file does): the shared
    // prefix's billing fact is attributed to exactly one side (the owner) and excluded ('scope: inherited')
    // from the child's own billingTotal — the child's ledger reports only its own tail.
    const ownerTokens = tokens({ nonCachedInput: 100, output: 20 })
    const childTokens = tokens({ nonCachedInput: 50, output: 10 })
    const otherTokens = tokens({ nonCachedInput: 30, output: 5 })
    // The owner's own `.id` is *also* a split-cluster id (a different branch index than the child's), so
    // the closure is exercised in the `.id` namespace on both ends of the edge, not only the child's —
    // package decision M2's exact concern: `branchParentId`/`branchChildIds` live in the `.id` namespace,
    // not `.sessionId`, and a naive sessionId-keyed closure would still coincidentally connect a single
    // split id to an unsplit one, but not two split ids to each other.
    const ownerNodeId = `${ownerId}:branch-2`
    const childNodeId = `${childId}:branch-1`
    const ownerSession = claudeSession(ownerId, ownerPath, ownerTokens, { id: ownerNodeId })
    const childSession = claudeSession(childId, childPath, childTokens, { id: childNodeId, branchParentId: ownerNodeId })
    const otherSession = claudeSession(otherId, otherPath, otherTokens)

    const result = tokensCheck(ctx({ claude: claudeCensus, readout: readout([ownerSession, childSession, otherSession]) }))

    const entry = result.bySource['claude-code']
    expect(entry.oracle.billingTotal.value).toBe(215) // 100+20 (shared, once) + 50+10 (child tail) + 30+5 (other)
    expect(entry.swob.billingTotal.value).toBe(215)
    expect(entry.swob.billingTotalDeviationPct.value).toBe(0)
    expect(entry.swob.sessionsRawCompared.value).toBe(3) // N: owner + child + other
    expect(entry.swob.sessionsCompared.value).toBe(2) // M: {owner,child} merged into one group, + {other}
    expect(entry.swob.sessionsEqual.value).toBe(2)
    expect(entry.swob.maxBranchGroupSize.value).toBe(2)
    expect(result.findings.find((item) => item.source === 'claude-code' && item.code === 'tokens.session-mismatch')).toBeUndefined()
    expect(entry.verdict).toBe('pass')
  })

  it('反例（S1，第二轮决定）：重合太小、内核没有识别为分支（无 branchParentId）时，⑤ 仍如实报不一致，不被并组逻辑意外吞掉', async () => {
    const root = home()
    const project = path.join('.claude', 'projects', claudeProjectDir(CWD))
    const ownerId = syntheticUuid(930)
    const otherId = syntheticUuid(931)
    const sharedUuid = syntheticUuid(940)
    const startUuid = syntheticUuid(941)

    const ownerPath = writeClaudeFile(root, project, ownerId, [
      claude.user({ uuid: startUuid, parentUuid: null, sessionId: ownerId, timestamp: syntheticTime(0), cwd: CWD, text: 'start' }),
      claude.assistant({
        uuid: sharedUuid, parentUuid: startUuid, sessionId: ownerId, timestamp: syntheticTime(1), cwd: CWD, text: 'shared',
        messageId: 'm-shared-2', requestId: 'r-shared-2', usage: { input: 100, output: 20 }
      })
    ])
    const otherPath = writeClaudeFile(root, project, otherId, [
      claude.user({ uuid: startUuid, parentUuid: null, sessionId: otherId, timestamp: syntheticTime(0), cwd: CWD, text: 'start' }),
      claude.assistant({
        uuid: sharedUuid, parentUuid: startUuid, sessionId: otherId, timestamp: syntheticTime(1), cwd: CWD, text: 'shared',
        messageId: 'm-shared-2', requestId: 'r-shared-2', usage: { input: 100, output: 20 }
      }),
      claude.assistant({
        uuid: syntheticUuid(942), parentUuid: sharedUuid, sessionId: otherId, timestamp: syntheticTime(2), cwd: CWD, text: 'own',
        messageId: 'm-other-own-2', requestId: 'r-other-own-2', usage: { input: 50, output: 10 }
      })
    ])
    const claudeCensus = await censusClaude(root)
    const ownerTokens = tokens({ nonCachedInput: 100, output: 20 })
    const otherTokens = tokens({ nonCachedInput: 50, output: 10 })
    // No branchParentId/branchChildIds on either side: this reproduces the design gap the task book's
    // complementary "反例" fixture calls for (session-loader.ts's linkCrossSessionBranches needs uuid
    // overlap >= 3 *and* both sides to carry independent tail content — below that threshold, or with a
    // one-sided tail, it never writes the link at all, and no amount of grouping logic here can find a
    // link the kernel never recorded).
    const result = tokensCheck(ctx({
      claude: claudeCensus,
      readout: readout([claudeSession(ownerId, ownerPath, ownerTokens), claudeSession(otherId, otherPath, otherTokens)])
    }))
    const entry = result.bySource['claude-code']
    // The *global* total still matches (F1m already fixed the ledger) — the bug this reproduces is at the
    // per-session granularity: the ungrouped "other" session's own solo-family oracle recount still sees
    // its file's full physical content (both the shared row and its own tail), while its ledger-correct
    // Swob total only reports its own tail.
    expect(entry.swob.billingTotalDeviationPct.value).toBe(0)
    expect(entry.swob.sessionsRawCompared.value).toBe(2)
    expect(entry.swob.sessionsCompared.value).toBe(2) // ungrouped: no branch link to merge on
    expect(entry.swob.maxBranchGroupSize.value).toBe(1)
    expect(entry.swob.sessionsEqual.value).toBe(1)
    const mismatch = result.findings.find((item) => item.source === 'claude-code' && item.code === 'tokens.session-mismatch')
    expect(mismatch).toBeTruthy()
    expect(mismatch?.count.value).toBe(1)
    expect(entry.verdict).toBe('warn')
  })
})
