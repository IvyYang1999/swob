import { describe, expect, it } from 'vitest'
import { checkupDigest } from './digest'
import { scanMarkdownForPrivacy } from './privacy'
import { allUndeterminedReport, d, dayReport, mixedReport, passReport, r } from './__fixtures__/checkup-reports'

const LINK = 'Swob内核体检-2026-09-27-a1b2c3'

describe('checkupDigest (AI-diary one-liner, design §五)', () => {
  it('lists sessions per source, then only the problems; [D] numbers carry 「≈」 and the line says so', () => {
    const line = checkupDigest(mixedReport(), { linkTarget: LINK })
    expect(line).toBe('体检 · 全部 52 场会话（Codex 40 · Claude Code 12） · 2 个来源 · 纳入：≈2 个单元没挂上（注意） · 丢 ≈3 条（不通过） · 压缩：原始 ≈14 处，Swob 认出 5 处（不通过） → [[Swob内核体检-2026-09-27-a1b2c3]]（≈ 为 [D]，其余为 [R]）')
    expect(scanMarkdownForPrivacy(line)).toEqual({ ok: true, hits: [] })
  })

  it('without a link the label note is its own part', () => {
    expect(checkupDigest(mixedReport())).toMatch(/ · ≈ 为 \[D\]，其余为 \[R\]$/)
  })

  it('says 「今天」 for a one-day report and 「数字均为 [R]」 when every number is reported', () => {
    const line = checkupDigest(dayReport(), { linkTarget: 'Swob内核体检-2026-09-26-a1b2c3' })
    expect(line).toBe('体检 · 今天 7 场会话（Codex 6 · Claude Code 1） · 2 个来源 · 记录读全 · 压缩：原始 4 处，Swob 认出 0 处（不通过） → [[Swob内核体检-2026-09-26-a1b2c3]]（数字均为 [R]）')
    expect(scanMarkdownForPrivacy(line).ok).toBe(true)
  })

  it('collapses to one sentence when everything graded passed', () => {
    expect(checkupDigest(passReport(), { linkTarget: LINK })).toBe('体检 · 全部 52 场会话（Codex 40 · Claude Code 12） · 2 个来源 · 已检查的 3 项都通过 → [[Swob内核体检-2026-09-27-a1b2c3]]（数字均为 [R]）')
    const all = passReport()
    for (const check of all.checks) check.verdict = 'pass'
    expect(checkupDigest(all)).toBe('体检 · 全部 52 场会话（Codex 40 · Claude Code 12） · 2 个来源 · 各项通过 · 数字均为 [R]')
  })

  it('gives 「无法判定（原因）」 for an undetermined report', () => {
    expect(checkupDigest(allUndeterminedReport(), { linkTarget: LINK })).toBe('体检 · 无法判定（自检没有全部通过，这次不给结论） → [[Swob内核体检-2026-09-27-a1b2c3]]')
    const noVerdict = allUndeterminedReport()
    delete noVerdict.verdictReason
    expect(checkupDigest(noVerdict)).toBe('体检 · 无法判定（没有能给出结论的检查项）')
  })

  it('only takes [R] session counts and skips sources with none', () => {
    const report = mixedReport()
    report.checks[0].bySource.codex.swob.sessions = d(40, 'sessions')
    report.checks[0].bySource['claude-code'].swob.sessions = r(0, 'sessions')
    expect(checkupDigest(report)).toMatch(/^体检 · 全部 0 场会话 · 0 个来源 · /)
  })

  it('refuses a link that is not a report note name, and unregistered text in the report', () => {
    expect(() => checkupDigest(mixedReport(), { linkTarget: '../secret-project/notes' })).toThrow(/link target/)
    expect(() => checkupDigest(mixedReport(), { linkTarget: 'Swob内核体检-2026-09-27-a1b2c3.json' })).toThrow(/link target/)
    const report = mixedReport()
    report.checks[1].verdict = 'undetermined'
    report.verdict = 'undetermined'
    report.verdictReason = 'not-a-registered-reason'
    // An unknown reason code falls back to the registered 「原因未登记」.
    expect(checkupDigest(report)).toBe('体检 · 无法判定（原因未登记）')
  })
})
