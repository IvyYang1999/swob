import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Pass-through spy on the Markdown scanner: every behaviour stays real, but the tests can see that the
// digest scans the exact line it returns (the reverse test below fails when that step is removed).
vi.mock('./privacy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./privacy')>()
  return { ...actual, assertMarkdownPrivacyClean: vi.fn(actual.assertMarkdownPrivacyClean) }
})

import type { CheckupReport } from './contract'
import { checkupDigest } from './digest'
import { PrivacyViolationError, assertMarkdownPrivacyClean, scanMarkdownForPrivacy } from './privacy'
import type { ReadoutSession, SwobReadout } from './readout'
import { runKernelCheckup } from './run'
import { claude, codex, codexRolloutPath, jsonl, syntheticTime, syntheticUuid, writeSample } from './self-test/samples'
import { allUndeterminedReport, d, dayReport, finding, mixedReport, partialReport, passReport, r, u } from './__fixtures__/checkup-reports'

const LINK = 'Swob内核体检-2026-09-27-a1b2c3'

const dirs: string[] = []
function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** The per-source readout of the real run on the owner's machine (numbers only). */
function realShapeReport(): CheckupReport {
  const report = mixedReport()
  report.checks[0].findings = report.checks[0].findings.filter((finding) => finding.code !== 'readout.source-empty')
  const counts: Record<string, number> = { 'claude-code': 59, codex: 525, cursor: 43, opencode: 63, zcode: 73, 'cc-mirror': 0 }
  for (const source of Object.keys(report.readoutBySource!)) {
    report.readoutBySource![source] = source in counts
      ? { sessions: r(counts[source], 'sessions') }
      : { sessions: u('sessions', 'readout.provider-host-not-parsed-readonly') }
  }
  return report
}

describe('checkupDigest (AI-diary one-liner, design §五)', () => {
  it('lists sessions per source, then only the problems; [D] numbers carry 「≈」 and the line says so', () => {
    const line = checkupDigest(mixedReport(), { linkTarget: LINK })
    expect(line).toBe('体检 · 全部 59 场会话（Codex 40 · Claude Code 12 · Cursor 7） · 3 个来源 · OpenCode：一场会话都没读到（注意） · 纳入：≈2 个单元没挂上（注意） · 丢 ≈3 条（不通过） · 压缩：Codex 原始 ≈9 处，Swob 认出 0 处（不通过） → [[Swob内核体检-2026-09-27-a1b2c3]]（≈ 为 [D]，其余为 [R]）')
    expect(scanMarkdownForPrivacy(line)).toEqual({ ok: true, hits: [] })
  })

  it('counts sessions and sources from readoutBySource: 763 sessions in 5 sources on the real shape', () => {
    const line = checkupDigest(realShapeReport(), { linkTarget: LINK })
    expect(line).toMatch(/^体检 · 全部 763 场会话（Codex 525 · ZCode 73 · OpenCode 63 · Claude Code 59 · Cursor 43） · 5 个来源 · 纳入：/)
    expect(line).not.toContain('一场会话都没读到')
    expect(scanMarkdownForPrivacy(line).ok).toBe(true)
  })

  it('falls back to ① swob.sessions for reports without readoutBySource, and takes [R] counts only', () => {
    const legacy = mixedReport()
    delete legacy.readoutBySource
    expect(checkupDigest(legacy)).toMatch(/^体检 · 全部 52 场会话（Codex 40 · Claude Code 12） · 2 个来源 · OpenCode：一场会话都没读到（注意） · /)
    const report = mixedReport()
    report.readoutBySource!.codex = { sessions: d(40, 'sessions') }
    report.readoutBySource!['claude-code'] = { sessions: r(0, 'sessions') }
    expect(checkupDigest(report)).toMatch(/^体检 · 全部 7 场会话（Cursor 7） · 1 个来源 · /)
  })

  it('without a link the label note is its own part', () => {
    expect(checkupDigest(mixedReport())).toMatch(/ · ≈ 为 \[D\]，其余为 \[R\]$/)
  })

  it('says 「今天」 for a one-day report (① counts) and 「数字均为 [R]」 when every number is reported', () => {
    const line = checkupDigest(dayReport(), { linkTarget: 'Swob内核体检-2026-09-26-a1b2c3' })
    expect(line).toBe('体检 · 今天 7 场会话（Codex 6 · Claude Code 1） · 2 个来源 · 记录读全 · 压缩：Codex 原始 4 处，Swob 认出 0 处（不通过） → [[Swob内核体检-2026-09-26-a1b2c3]]（数字均为 [R]）')
    expect(scanMarkdownForPrivacy(line).ok).toBe(true)
  })

  it('collapses to one sentence when everything graded passed', () => {
    expect(checkupDigest(passReport(), { linkTarget: LINK })).toBe('体检 · 全部 59 场会话（Codex 40 · Claude Code 12 · Cursor 7） · 3 个来源 · 已检查的 3 项都通过 → [[Swob内核体检-2026-09-27-a1b2c3]]（数字均为 [R]）')
    const all = passReport()
    for (const check of all.checks) check.verdict = 'pass'
    expect(checkupDigest(all)).toBe('体检 · 全部 59 场会话（Codex 40 · Claude Code 12 · Cursor 7） · 3 个来源 · 各项通过 · 数字均为 [R]')
  })

  it('gives 「无法判定（原因）」 for an undetermined report', () => {
    expect(checkupDigest(allUndeterminedReport(), { linkTarget: LINK })).toBe('体检 · 无法判定（自检没有全部通过，这次不给结论） → [[Swob内核体检-2026-09-27-a1b2c3]]')
    const noVerdict = allUndeterminedReport()
    delete noVerdict.verdictReason
    expect(checkupDigest(noVerdict)).toBe('体检 · 无法判定（没有能给出结论的检查项）')
  })

  it('refuses a link that is not a report note name; an unknown reason code reads 「原因未登记」', () => {
    expect(() => checkupDigest(mixedReport(), { linkTarget: '../secret-project/notes' })).toThrow(/link target/)
    expect(() => checkupDigest(mixedReport(), { linkTarget: 'Swob内核体检-2026-09-27-a1b2c3.json' })).toThrow(/link target/)
    const report = mixedReport()
    report.checks[1].verdict = 'undetermined'
    report.verdict = 'undetermined'
    report.verdictReason = 'not-a-registered-reason'
    expect(checkupDigest(report)).toBe('体检 · 无法判定（原因未登记） · OpenCode：一场会话都没读到（注意）')
  })

  it('names sources read as empty also when the overall verdict is undetermined (acceptance P2-14)', () => {
    const report = allUndeterminedReport()
    expect(checkupDigest(report)).toBe('体检 · 无法判定（自检没有全部通过，这次不给结论）')
    report.checks[0].findings.push(finding('readout.source-empty', 'warn', 'opencode', u('units', 'census.not-implemented')))
    const line = checkupDigest(report, { linkTarget: LINK })
    expect(line).toBe('体检 · 无法判定（自检没有全部通过，这次不给结论） · OpenCode：一场会话都没读到（注意） → [[Swob内核体检-2026-09-27-a1b2c3]]')
    expect(scanMarkdownForPrivacy(line).ok).toBe(true)
  })

  it('lists compaction per source that did not pass, and sums only when no source can be split (acceptance P2-3)', () => {
    const both = mixedReport()
    const claude = both.checks[2].bySource['claude-code']
    claude.verdict = 'warn'
    claude.oracle.perSessionUniqueSum = d(6, 'markers')
    const line = checkupDigest(both)
    expect(line).toContain(' · 压缩：Claude Code 原始 ≈6 处，Swob 认出 5 处（注意） · 压缩：Codex 原始 ≈9 处，Swob 认出 0 处（不通过） · ')
    expect(line).not.toContain('原始 ≈15 处')
    expect(scanMarkdownForPrivacy(line).ok).toBe(true)
    // A failing check whose sources all passed individually (not produced by C1a) still gets the sum.
    const unsplit = mixedReport()
    unsplit.checks[2].bySource.codex.verdict = 'pass'
    expect(checkupDigest(unsplit)).toContain(' · 压缩：原始 ≈14 处，Swob 认出 5 处（不通过） · ')
  })

  it('says 「（部分来源）」 for a --sources report and counts only the selected sources (C1c; C1b-2 knownRisk)', () => {
    const line = checkupDigest(partialReport(), { linkTarget: LINK })
    expect(line).toBe('体检（部分来源） · 所选来源 52 场会话（Codex 40 · Claude Code 12） · 2 个来源 · 已检查的 3 项都通过 → [[Swob内核体检-2026-09-27-a1b2c3]]（数字均为 [R]）')
    expect(scanMarkdownForPrivacy(line).ok).toBe(true)
    // C1d (C1c acceptance P2-2): the counts cover the selected sources only, so the line never says 「全部」.
    expect(line).not.toContain('全部')
    // A report written before C1c still carried counts for unselected sources: they are not counted.
    const older = partialReport()
    older.readoutBySource!.cursor = { sessions: r(7, 'sessions') }
    expect(checkupDigest(older)).toBe('体检（部分来源） · 所选来源 52 场会话（Codex 40 · Claude Code 12） · 2 个来源 · 已检查的 3 项都通过 · 数字均为 [R]')
    // No selected source with a session count: the bare form, still without 「全部」.
    const bare = partialReport(['claude-code'])
    bare.readoutBySource!['claude-code'] = { sessions: r(0, 'sessions') }
    expect(checkupDigest(bare)).toBe('体检（部分来源） · 所选来源 0 场会话 · 0 个来源 · 已检查的 3 项都通过 · 数字均为 [R]')
    // Also when nothing could be judged.
    const blocked = partialReport(['claude-code'])
    blocked.verdict = 'undetermined'
    blocked.verdictReason = 'checkup.self-test-failed'
    expect(checkupDigest(blocked)).toBe('体检（部分来源） · 无法判定（自检没有全部通过，这次不给结论）')
    // A full report keeps its lead.
    expect(checkupDigest(passReport())).toMatch(/^体检 · 全部 59 场会话/)
  })

  it('always scans its own line and throws when a part is not whitelisted (reverse test of the scan step)', () => {
    const scan = vi.mocked(assertMarkdownPrivacyClean)
    scan.mockClear()
    const line = checkupDigest(mixedReport(), { linkTarget: LINK })
    expect(scan).toHaveBeenCalledTimes(1)
    expect(scan).toHaveBeenCalledWith(line)
    // A count that cannot be written as a number leaves a segment no template accepts: without the scan
    // step the digest would hand this line out.
    const broken = mixedReport()
    broken.readoutBySource!.codex = { sessions: r(Number.POSITIVE_INFINITY, 'sessions') }
    expect(() => checkupDigest(broken)).toThrow(PrivacyViolationError)
  })
})

describe('checkupDigest on a synthetic HOME (runKernelCheckup)', () => {
  it('names the sources whose data is present but read as empty, even when every graded check passes', async () => {
    const root = tempDir('digest-home-')
    const sid = syntheticUuid(80)
    const main = fs.realpathSync(writeSample(root, path.join('.claude', 'projects', '-p', `${sid}.jsonl`), jsonl([
      claude.user({ uuid: syntheticUuid(800), parentUuid: null, sessionId: sid, timestamp: syntheticTime(1), cwd: '/p', text: 'q' }),
      claude.assistant({ uuid: syntheticUuid(801), parentUuid: syntheticUuid(800), sessionId: sid, timestamp: syntheticTime(2), cwd: '/p', text: 'a', messageId: 'm80', requestId: 'r80' })
    ])))
    const codexId = syntheticUuid(81, 'c0de')
    const rollout = fs.realpathSync(writeSample(root, codexRolloutPath(codexId, 0), jsonl([
      codex.topLevelMeta({ timestamp: syntheticTime(0), ordinal: 0, id: codexId, cwd: '/p' }),
      codex.userMessage({ timestamp: syntheticTime(1), ordinal: 1, text: 'q' }),
      codex.assistantMessage({ timestamp: syntheticTime(2), ordinal: 2, text: 'a' })
    ])))
    // OpenCode and ZCode keep their stores here, but the Swob readout returns no session of theirs.
    writeSample(root, path.join('.local', 'share', 'opencode', 'opencode.db'), '')
    writeSample(root, path.join('.zcode', 'cli', 'db', 'db.sqlite'), '')
    const sessions: ReadoutSession[] = [
      { source: 'claude-code', sessionId: sid, primaryPath: main, paths: [main], subagentPaths: [], subagentIds: [], compactCount: 0, virtual: false },
      { source: 'codex', sessionId: codexId, primaryPath: rollout, paths: [rollout], subagentPaths: [], subagentIds: [], compactCount: 0, virtual: false }
    ]
    const readout: SwobReadout = {
      status: 'ok', sessions, claudeParsed: new Map([[main, { records: 2, elapsedMs: 1, partial: false }]]),
      discovered: { claudeMain: new Set([main]), codex: new Set([rollout]) }, attributedChildIds: new Set(), consoleLines: 0, timingsMs: {}
    }
    const report = await runKernelCheckup({ homeDir: root, stateDir: tempDir('digest-state-'), privacySalt: 'digest-home' }, { readout: async () => readout })
    expect(report.verdict).toBe('pass')
    const line = checkupDigest(report, { linkTarget: LINK })
    expect(line).toBe('体检 · 全部 2 场会话（Claude Code 1 · Codex 1） · 2 个来源 · OpenCode、ZCode：一场会话都没读到（注意） · 已检查的 3 项都通过 → [[Swob内核体检-2026-09-27-a1b2c3]]（数字均为 [R]）')
    expect(scanMarkdownForPrivacy(line).ok).toBe(true)
  })

  it('names a source that got no read count at all instead of 「记录读全」, like ②\'s one-liner (C1d)', async () => {
    const root = tempDir('digest-unread-')
    const sid = syntheticUuid(82)
    const main = fs.realpathSync(writeSample(root, path.join('.claude', 'projects', '-p', `${sid}.jsonl`), jsonl([
      claude.user({ uuid: syntheticUuid(820), parentUuid: null, sessionId: sid, timestamp: syntheticTime(1), cwd: '/p', text: 'q' }),
      claude.assistant({ uuid: syntheticUuid(821), parentUuid: syntheticUuid(820), sessionId: sid, timestamp: syntheticTime(2), cwd: '/p', text: 'a', messageId: 'm82', requestId: 'r82' })
    ])))
    const codexId = syntheticUuid(83, 'c0de')
    // One legacy compaction Swob did not count: ③ fails, so the digest goes through the checks one by one.
    const rollout = fs.realpathSync(writeSample(root, codexRolloutPath(codexId, 0), jsonl([
      codex.topLevelMeta({ timestamp: syntheticTime(0), ordinal: 0, id: codexId, cwd: '/p' }),
      codex.userMessage({ timestamp: syntheticTime(1), ordinal: 1, text: 'q' }),
      codex.assistantMessage({ timestamp: syntheticTime(2), ordinal: 2, text: 'a' }),
      codex.compacted({ timestamp: syntheticTime(3), ordinal: 3, message: 'summary', window: 1 })
    ])))
    const sessions: ReadoutSession[] = [
      { source: 'claude-code', sessionId: sid, primaryPath: main, paths: [main], subagentPaths: [], subagentIds: [], compactCount: 0, virtual: false },
      { source: 'codex', sessionId: codexId, primaryPath: rollout, paths: [rollout], subagentPaths: [], subagentIds: [], compactCount: 0, virtual: false }
    ]
    // No Codex read count at all (as when every Codex read threw): Codex ② is undetermined, Claude Code ② passes.
    const readout: SwobReadout = {
      status: 'ok', sessions, claudeParsed: new Map([[main, { records: 2, elapsedMs: 1, partial: false }]]),
      discovered: { claudeMain: new Set([main]), codex: new Set([rollout]) }, attributedChildIds: new Set(), consoleLines: 0, timingsMs: {}
    }
    const report = await runKernelCheckup({ homeDir: root, stateDir: tempDir('digest-state-'), privacySalt: 'digest-unread' }, { readout: async () => readout })
    expect([report.verdict, report.checks[1].verdict, report.checks[1].bySource.codex.verdict]).toEqual(['fail', 'pass', 'undetermined'])
    const line = checkupDigest(report, { linkTarget: LINK })
    expect(line).toBe('体检 · 全部 2 场会话（Claude Code 1 · Codex 1） · 2 个来源 · Codex：本轮未取得读数 · 压缩：Codex 原始 ≈1 处，Swob 认出 0 处（不通过） → [[Swob内核体检-2026-09-27-a1b2c3]]（≈ 为 [D]，其余为 [R]）')
    expect(line).not.toContain('记录读全')
    expect(scanMarkdownForPrivacy(line).ok).toBe(true)
  })
})
