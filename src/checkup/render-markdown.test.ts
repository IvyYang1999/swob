import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import { beforeAll, describe, expect, it } from 'vitest'
import schema from './contract/kernel-checkup-report-v1.schema.json'
import { CHECK_ORDER, CHECKUP_VERSION, MEASURE_UNITS, ORACLE_IDS, REASON_CODES, type CheckupReport } from './contract'
import { runKernelCheckup } from './run'
import { PrivacyViolationError, scanForPrivacy, scanMarkdownForPrivacy } from './privacy'
import {
  CHECK_LABELS,
  COMPARE_TEXT,
  HEADLINES,
  MARKDOWN_MARKER,
  MARKDOWN_TEXT,
  MEASURE_LABELS,
  ORACLE_LABELS,
  OWNER_ACTIONS,
  REASON_TEXT,
  RETIRED_TEMPLATES,
  UNIT_LABELS,
  VERDICT_LABELS,
  fillTemplate,
  registeredTemplateSet
} from './templates'
import {
  LATEST_FILE_PATTERN,
  REPORT_BASENAME_PATTERN,
  REPORT_FILE_PATTERN,
  localTime,
  machineTag,
  renderCheckupMarkdown,
  reportFileNames
} from './render-markdown'
import { checkupDigest } from './digest'
import { compareIssues, sourcesSelected } from './compare'
import { OTHER_FINGERPRINT, allUndeterminedReport, clone, d, finding, mixedReport, partialReport, passReport, r, u } from './__fixtures__/checkup-reports'
import { CANARY, assertInsideTestSandbox, buildSampleHome } from './__test-support__/sample-home'

// The sample-HOME report runs the kernel, which captured HOME at import time: the Vitest sandbox home.
const HOME = process.env.HOME!
assertInsideTestSandbox(HOME)

const RENDER = { machineModel: 'Mac16,10', utcOffsetMinutes: 480 } as const
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema)

function measureKeys(report: CheckupReport): string[] {
  return [...new Set(report.checks.flatMap((check) => Object.values(check.bySource)
    .flatMap((entry) => [...Object.keys(entry.swob), ...Object.keys(entry.oracle)])))]
}

let sampleReport: CheckupReport

beforeAll(async () => {
  buildSampleHome(HOME)
  const stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'checkup-render-state-')))
  assertInsideTestSandbox(stateDir)
  try {
    sampleReport = await runKernelCheckup({
      homeDir: HOME, stateDir, privacySalt: 'render-test-salt', kernelVersion: '1.4.0', kernelCommit: 'e51a952ac9d7580c67fafdc24c99f6d38355860a'
    })
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
  // Snapshot stability: the run time, timings and Node version are not part of the rendering contract.
  sampleReport.generatedAt = '2026-09-27T01:02:03.000Z'
  sampleReport.timingsMs = { total: 12_345 }
  sampleReport.machine.nodeVersion = 'v0.0.0'
}, 60_000)

describe('text registries (templates.ts)', () => {
  it('explains every reason code, verdict, check, unit and oracle', () => {
    for (const code of REASON_CODES) expect(REASON_TEXT[code], code).toMatch(/\S/)
    for (const verdict of ['pass', 'warn', 'fail', 'not-applicable', 'undetermined'] as const) expect(VERDICT_LABELS[verdict]).toMatch(/\S/)
    for (const id of CHECK_ORDER) expect(CHECK_LABELS[id]).toMatch(/\S/)
    for (const unit of MEASURE_UNITS) expect(UNIT_LABELS[unit], unit).toMatch(/\S/)
    for (const id of ORACLE_IDS) expect(ORACLE_LABELS[id], id).toMatch(/\S/)
  })

  it('names every measure key the checks produce (the data-derived lostByType:* keys excepted)', () => {
    const keys = new Set([...measureKeys(sampleReport), ...measureKeys(mixedReport())])
    const missing = [...keys].filter((key) => key !== 'status' && !key.startsWith('lostByType:') && !MEASURE_LABELS[key])
    expect(missing).toEqual([])
  })

  it('adds the new registries to registeredTemplateSet()', () => {
    const set = registeredTemplateSet()
    for (const text of [VERDICT_LABELS.fail, CHECK_LABELS.content, REASON_TEXT['readout.source-empty'], COMPARE_TEXT.none, MARKDOWN_TEXT.headReadOnly]) {
      expect(set.has(text), text).toBe(true)
    }
  })

  it('renders and scans an older report whose findings carry retired sentences, owner and engineer (C1d)', () => {
    // A report keeps the sentences of the checkup that wrote it: here the engineer locators and the owner line C1d reworded.
    const older = mixedReport()
    older.checks[1].findings.push(
      finding('readout.parse-timeout', 'undetermined', 'claude-code', r(1, 'files')),
      finding('content.swob-extra-records', 'warn', 'codex', d(1, 'files')),
      finding('content.unexplained-loss', 'fail', 'codex', d(1, 'records'))
    )
    const retiredHints = RETIRED_TEMPLATES.filter((entry) => entry.field === 'engineerHint')
    for (const check of older.checks) {
      for (const entry of check.findings) {
        const retired = retiredHints.find((item) => item.code === entry.code)
        if (retired) entry.engineerHint = fillTemplate(retired.text, [], entry.source)
      }
    }
    // The retired owner line, with the numbers mixedReport() gives that finding (3 records lost, 2 of them yours).
    const retiredOwner = RETIRED_TEMPLATES.find((entry) => entry.code === 'content.line-separator-split' && entry.field === 'ownerLine')!
    const separator = older.checks[1].findings.find((entry) => entry.code === 'content.line-separator-split')!
    separator.ownerLine = fillTemplate(retiredOwner.text, [3, 2], separator.source)
    expect(validate(older), JSON.stringify(validate.errors)).toBe(true)
    expect(scanForPrivacy(older)).toEqual({ ok: true, hits: [] })
    const engineer = renderCheckupMarkdown(older, { ...RENDER, audience: 'engineer' })
    expect(retiredHints.length).toBeGreaterThan(0)
    for (const item of retiredHints) expect(engineer, item.code).toContain(`\n  - ${item.text}\n`)
    expect(engineer).toContain(`\n- 不通过 · ${separator.ownerLine}[D]\n`)
    expect(scanMarkdownForPrivacy(engineer, { engineer: true })).toEqual({ ok: true, hits: [] })
    const owner = renderCheckupMarkdown(older, RENDER)
    expect(owner).toContain('- 无法判定 · Claude Code：有 1 个文件读取超时或没读成，这次没有参与比对')
    expect(owner).toContain(`\n- 不通过 · ${separator.ownerLine}[D]\n`)
    expect(scanMarkdownForPrivacy(owner)).toEqual({ ok: true, hits: [] })
  })
})

describe('scanMarkdownForPrivacy', () => {
  const clean = (): string => renderCheckupMarkdown(mixedReport(), RENDER)

  it('accepts rendered reports and never echoes rejected text', () => {
    expect(scanMarkdownForPrivacy(clean())).toEqual({ ok: true, hits: [] })
    const secret = `${clean()}\n${CANARY.userText}\n`
    const result = scanMarkdownForPrivacy(secret)
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain(CANARY.userText)
    expect(result.hits[0].path).toMatch(/^line:\d+$/)
  })

  it('rejects canaries, unregistered sentences, data file names, UUIDs, absolute paths and long hex', () => {
    const rejects: Array<[string, string]> = [
      [`- ${CANARY.userText}`, 'unregistered-text'],
      [`| ${CANARY.absolutePath} | 1[R] |`, 'absolute-path'],
      [`样本：${CANARY.sessionUuid}`, 'uuid'],
      [`- ${CANARY.rolloutName}`, 'codex-rollout-name'],
      ['和上次比：见 Swob内核体检-2026-09-26-118202.json', 'data-file-name'],
      ['| 编号 | 0123456789abcdef0123 |', 'long-hex'],
      ['- 这是一句没有登记过的话', 'unregistered-text'],
      ['| Claude Code | secret-project |', 'unregistered-text'],
      ['| facade | 1[R] |', 'unregistered-text'],
      [`# ${MARKDOWN_TEXT.headReadOnly} ${CANARY.userText}`, 'unregistered-text']
    ]
    for (const [line, rule] of rejects) {
      const result = scanMarkdownForPrivacy(`${MARKDOWN_MARKER}\n${line}\n`)
      expect(result.ok, line).toBe(false)
      expect(result.hits.map((hit) => hit.rule), line).toContain(rule)
    }
  })

  it('allows raw measure keys for the engineer audience only', () => {
    const line = '| lostByType:event_msg:token_count | 1[D] |'
    expect(scanMarkdownForPrivacy(line).ok).toBe(false)
    expect(scanMarkdownForPrivacy(line, { engineer: true }).ok).toBe(true)
    expect(scanMarkdownForPrivacy(`- ${CANARY.userText}`, { engineer: true }).ok).toBe(false)
  })

  it('checks typed placeholders by shape', () => {
    expect(scanMarkdownForPrivacy('> 机器：Mac16,10 · 机器标签：118202').ok).toBe(true)
    expect(scanMarkdownForPrivacy('> 机器：secret host').ok).toBe(false)
    expect(scanMarkdownForPrivacy('> 内核：swob 1.4.0 @e51a952').ok).toBe(true)
    expect(scanMarkdownForPrivacy('> 内核：swob 1.4.0-secret @e51a952').ok).toBe(false)
    expect(scanMarkdownForPrivacy('| —（本版体检还没有清点这个来源） |').ok).toBe(true)
    expect(scanMarkdownForPrivacy('| —（我编的原因） |').ok).toBe(false)
  })
})

describe('renderCheckupMarkdown (hand-written reports)', () => {
  it('fixtures are schema-valid reports', () => {
    for (const report of [mixedReport(), allUndeterminedReport(), passReport(), partialReport()]) expect(validate(report), JSON.stringify(validate.errors)).toBe(true)
  })

  it('names the selected sources in the head of a --sources report (C1c; C1b-2 knownRisk)', () => {
    const partial = renderCheckupMarkdown(partialReport(), RENDER)
    expect(partial).toContain('\n> 范围：本次只体检 Claude Code、Codex（其余 12 个来源未选） · 用时：约 61 秒\n')
    expect(partial).not.toContain('本机现存的全部原始数据')
    expect(renderCheckupMarkdown(partialReport(['codex']), RENDER)).toContain('> 范围：本次只体检 Codex（其余 13 个来源未选） · ')
    // The inventory rows of unselected sources with data read 「本次未选」 (not 「还没有清点」).
    expect(partial).toContain('| OpenCode | ~/.local/share/opencode | —（这次没有选这个来源） | —（这次没有选这个来源） | — | 读 |')
    expect(partial).toContain('| Kimi 旧版目录 | ~/.kimi/sessions | —（这次没有选这个来源） | —（这次没有选这个来源） | — | 不读 |')
    expect(scanMarkdownForPrivacy(partial)).toEqual({ ok: true, hits: [] })
    // A full report keeps its head.
    expect(renderCheckupMarkdown(passReport(), RENDER)).toContain('\n> 范围：本机现存的全部原始数据 · 用时：约 61 秒\n')
  })

  it('renders the owner layout of design §五 (headings two levels up)', async () => {
    const markdown = renderCheckupMarkdown(mixedReport(), RENDER)
    await expect(markdown).toMatchFileSnapshot('./__fixtures__/snapshots/mixed-owner.md')
    const lines = markdown.split('\n')
    expect(lines[0]).toBe(MARKDOWN_MARKER)
    expect(lines[1]).toBe('# Swob 内核体检报告 · 2026-09-27')
    const headings = lines.filter((line) => line.startsWith('## '))
    expect(headings.slice(0, 2)).toEqual(['## 总评：不通过', '## 各来源一览'])
    expect(headings.slice(2, 8).map((line) => line.slice(3, 9))).toEqual(CHECK_ORDER.map((id) => CHECK_LABELS[id].slice(0, 6)))
    expect(headings.slice(8)).toEqual(['## 附：原始数据盘点', '## 附：已知副作用', '## 附：本次用到的标准答案'])
    expect(markdown).toContain('和上次比：没有找到可比的上次报告。')
    expect(markdown).not.toContain('## 和上次比')
    expect(markdown).toContain('> 生成于 2026-09-27 09:02（UTC+08:00） · 机器：Mac16,10 · 机器标签：a1b2c3')
    expect(markdown).toContain('内核：swob 1.4.0 @e51a952')
    // Every number carries a label; unavailable values are 「—（原因）」, never 0.
    expect(markdown).toContain('| Codex | 9,000[R] | 0[R] | 9,000[R] | —（Swob 没有按文件给出读入数） | 0[D] | — | 100%[D] |')
    expect(markdown).toContain('| OpenCode | 无法判定（未检查） | 无法判定（未检查） | 无法判定（未检查） | 无法判定（未实现） | 无法判定（未实现） | 无法判定（未实现） | 0[R]（注意） |')
    expect(markdown).toContain('| ZCode | 无法判定（未检查） | 无法判定（未检查） | 无法判定（未检查） | 无法判定（未实现） | 无法判定（未实现） | 无法判定（未实现） | 0[R] |')
    expect(markdown).toContain('- 注意 · OpenCode：本机有这个来源的数据，但 Swob 这次一场会话都没读到\n')
    expect(markdown).toContain('| ② 内容完整 | 不通过 | 有 3 条记录没读进来，其中 2 条是对话内容[D] | 转给开发；修好之前别信这一项的数字 |')
    expect(markdown).toContain('| ④ 血统与分支 | 无法判定（本版未实现） | 本版体检还没有实现这一项 | 暂时无需处理，等体检补齐 |')
    expect(markdown).not.toMatch(/lostByType|0a0a0a0a|src\/main/)
  })

  it('omits the machine model when absent or malformed, and never shows the salt fingerprint itself', () => {
    const report = mixedReport()
    for (const machineModel of [undefined, null, 'my laptop', 'Mac16,10; rm']) {
      const markdown = renderCheckupMarkdown(report, { ...RENDER, machineModel })
      expect(markdown).not.toContain('机器：')
      expect(markdown).toContain('机器标签：a1b2c3')
      expect(markdown).not.toContain(report.saltFingerprint!)
    }
  })

  it('adds locators, samples, raw keys, diagnostics and timings for engineers', async () => {
    const markdown = renderCheckupMarkdown(mixedReport(), { ...RENDER, audience: 'engineer' })
    await expect(markdown).toMatchFileSnapshot('./__fixtures__/snapshots/mixed-engineer.md')
    expect(markdown).toContain('  - src/main/session-loader.ts#loadAllSessions：')
    expect(markdown).toContain('  - 样本：0a0a0a0a 0b0b0b0b')
    expect(markdown).toContain('| lostByType:event_msg:token_count | Swob 侧 | 条记录 |')
    expect(markdown).toContain('## 附：运行诊断（工程）')
    expect(markdown).toContain('| readout.loadAllSessions | 36,000 |')
    expect(scanMarkdownForPrivacy(markdown).ok).toBe(false)
    expect(scanMarkdownForPrivacy(markdown, { engineer: true }).ok).toBe(true)
  })

  it('renders an all-undetermined report with its reason', async () => {
    const markdown = renderCheckupMarkdown(allUndeterminedReport(), RENDER)
    await expect(markdown).toMatchFileSnapshot('./__fixtures__/snapshots/all-undetermined-owner.md')
    expect(markdown).toContain('## 总评：无法判定')
    expect(markdown).toContain('无法判定（自检没有全部通过，这次不给结论）')
    expect(markdown).toContain('> 内核：swob 1.4.0 @e51a952 · 只读运行 · 体检程序：checkup 1.1.0 · 自检：5/6')
    expect(markdown).toContain('## ① 会话纳入 — 无法判定（Swob 侧读数没有在隔离环境里运行，为了安全没有读）')
    expect(markdown).toContain('—（Swob 侧读数没有在隔离环境里运行，为了安全没有读）')
    expect(markdown).not.toContain('建议先处理')
  })

  it('shows not-applicable sources and capability gaps with their reason', () => {
    const markdown = renderCheckupMarkdown(mixedReport(), RENDER)
    expect(markdown).toContain('| Cursor | 无法判定（未检查） | 无法判定（未检查） | 无法判定（未检查） | 无法判定（未实现） | 不适用（来源不提供） | 无法判定（未实现） | 7[R] |')
    expect(markdown).toContain('| CC-Mirror | 不适用（无数据） |')
    expect(markdown).toContain('| Antigravity · Grok Build · Pi · Hermes · Qoder · Trae | 不适用（无数据） |')
    expect(markdown).toContain('| Kimi Code | 注意（旧版目录） | 无法判定（未检查） |')
  })

  it('surfaces a source read as empty at the top: a line under the overall verdict and a flagged cell (acceptance P2-1)', () => {
    const markdown = renderCheckupMarkdown(mixedReport(), RENDER)
    const lines = markdown.split('\n')
    const counts = lines.findIndex((line) => line.startsWith('6 项检查里：'))
    expect(lines.slice(counts + 1, counts + 3)).toEqual(['', '注意：OpenCode 在本机有数据，但 Swob 这次一场会话都没读到。这不影响上面的结论，详见 ① 会话纳入。'])
    expect(markdown).toContain('| 0[R]（注意） |')
    // Also when nothing could be judged, and with several sources in source order.
    const report = allUndeterminedReport()
    report.checks[0].findings.push(
      finding('readout.source-empty', 'warn', 'zcode', u('units', 'census.not-implemented')),
      finding('readout.source-empty', 'warn', 'opencode', u('units', 'census.not-implemented'))
    )
    report.readoutBySource!.opencode = { sessions: r(0, 'sessions') }
    report.readoutBySource!.zcode = { sessions: r(0, 'sessions') }
    const undetermined = renderCheckupMarkdown(report, RENDER)
    expect(undetermined).toContain('\n注意：OpenCode、ZCode 在本机有数据，但 Swob 这次一场会话都没读到。这不影响上面的结论，详见 ① 会话纳入。\n')
    expect(undetermined).toContain('| OpenCode · ZCode | 无法判定（未检查） | 无法判定（未检查） | 无法判定（未检查） | 无法判定（未实现） | 无法判定（未实现） | 无法判定（未实现） | 0[R]（注意） |')
    // Even when every graded check passes (the finding never grades ①).
    const passing = passReport()
    passing.checks[0].findings.push(finding('readout.source-empty', 'warn', 'opencode', u('units', 'census.not-implemented')))
    const passingMarkdown = renderCheckupMarkdown(passing, RENDER)
    expect(passingMarkdown).toContain('## 总评：通过')
    expect(passingMarkdown).toContain('注意：OpenCode 在本机有数据')
    const clean = mixedReport()
    clean.checks[0].findings = clean.checks[0].findings.filter((entry) => entry.code !== 'readout.source-empty')
    const cleanMarkdown = renderCheckupMarkdown(clean, RENDER)
    expect(cleanMarkdown).not.toContain('一场会话都没读到')
    expect(cleanMarkdown).not.toContain('（注意） |')
  })

  it('marks a legacy-directory-only warning as 「注意（旧版目录）」 with its own legend line (acceptance P2-8)', () => {
    const legend = '旧版目录＝问题只出在这个工具的旧版目录里（Kimi 是 ~/.kimi/sessions），与新版本身无关。'
    const markdown = renderCheckupMarkdown(mixedReport(), RENDER)
    expect(markdown).toContain(`\n${legend}\n`)
    // The inventory appendix names the unscanned legacy directory by its own registered label.
    expect(markdown).toContain('| Kimi 旧版目录 | ~/.kimi/sessions | 3[R] |')
    expect(markdown).not.toContain('| Kimi Code | ~/.kimi/sessions |')
    // A second, different problem on the same source keeps the plain verdict (and no legend).
    const mixedProblems = mixedReport()
    mixedProblems.checks[0].findings.push(finding('inclusion.unexplained', 'warn', 'kimi', r(1, 'units')))
    const plain = renderCheckupMarkdown(mixedProblems, RENDER)
    expect(plain).toContain('| Kimi Code | 注意 | 无法判定（未检查） |')
    expect(plain).not.toContain(legend)
    expect(renderCheckupMarkdown(allUndeterminedReport(), RENDER)).not.toContain(legend)
  })

  it('renders 「和上次比」 only with a previous report, and refuses other machines', async () => {
    const previous = mixedReport()
    previous.generatedAt = '2026-09-26T01:00:00.000Z'
    previous.checks[1].findings[0].count = { value: 5, label: 'derived', unit: 'records' }
    previous.checks[2].findings = []
    previous.checks[2].bySource.codex.verdict = 'pass'
    const withPrevious = renderCheckupMarkdown(mixedReport(), { ...RENDER, previous })
    await expect(withPrevious).toMatchFileSnapshot('./__fixtures__/snapshots/mixed-with-previous-owner.md')
    expect(withPrevious).toContain('和上次比（上次 2026-09-26）：新增问题 1 项，已修复 0 项，未变 4 项，首次检查 0 项。')
    expect(withPrevious).toContain('## 和上次比')
    expect(withPrevious).toContain('| 未变 | ② 内容完整 | Claude Code | 带特殊行分隔符的记录没读全 | 5[D] | 3[D] | -2 |')
    expect(withPrevious).toContain('| 新增问题 | ③ 压缩识别 | Codex | 含旧格式压缩记录的会话，Swob 一次都没认出来 | — | 4[D] | — |')
    expect(withPrevious).not.toMatch(/\.json|a1b2c3d4/)

    const foreign = clone(previous)
    foreign.saltFingerprint = OTHER_FINGERPRINT
    const refused = renderCheckupMarkdown(mixedReport(), { ...RENDER, previous: foreign })
    expect(refused).toContain('和上次比：上次报告来自另一台机器（机器指纹不同），这次不比。')
    expect(refused).not.toContain('## 和上次比')
    const olderCheckup = clone(previous)
    olderCheckup.kernel.checkupVersion = '1.0.0'
    expect(renderCheckupMarkdown(mixedReport(), { ...RENDER, previous: olderCheckup }))
      .toContain('\n两次的体检程序版本不同（上次 1.0.0，这次 1.1.0），部分差异可能来自体检本身的改动。\n')
    expect(withPrevious).not.toContain('两次的体检程序版本不同')
    const legacy = clone(previous)
    delete legacy.saltFingerprint
    expect(renderCheckupMarkdown(mixedReport(), { ...RENDER, previous: legacy })).toContain('和上次比：上次报告没有机器指纹（旧版体检生成的），这次不比。')
  })

  it('C2a: names a check that went from 「未实现」to a real verdict since the previous report', () => {
    const previous = mixedReport()
    previous.generatedAt = '2026-09-26T01:00:00.000Z'
    const current = mixedReport()
    // ⑤ tokens landed; ④⑥ are still pending, unchanged from previous.
    current.checks[4] = {
      id: 'tokens', verdict: 'pass', headline: fillTemplate(HEADLINES['tokens.pass'], [2]), ownerAction: OWNER_ACTIONS.pass,
      bySource: previous.checks[4].bySource, findings: []
    }
    const withPrevious = renderCheckupMarkdown(current, { ...RENDER, previous })
    expect(withPrevious).toContain('本次新增了 ⑤ Token 的判定。')
    // Nothing changed for ④⑥: only ⑤ is named in that sentence (the sentence line itself, not the
    // document as a whole — ④'s own still-pending row is legitimately printed elsewhere).
    const [newlyDeterminedLine] = withPrevious.split('\n').filter((line) => line.includes('本次新增了'))
    expect(newlyDeterminedLine).toBe('本次新增了 ⑤ Token 的判定。')
    expect(withPrevious.match(/本次新增了/g)).toHaveLength(1)
    // No previous report, or nothing newly determined: no such line at all.
    expect(renderCheckupMarkdown(current, RENDER)).not.toContain('本次新增了')
    expect(renderCheckupMarkdown(mixedReport(), { ...RENDER, previous })).not.toContain('本次新增了')
  })

  it('refuses to render (PrivacyViolationError) when a report carries unregistered text', () => {
    const report = mixedReport()
    report.checks[0].headline = CANARY.userText
    expect(() => renderCheckupMarkdown(report, RENDER)).toThrow(PrivacyViolationError)
    try {
      renderCheckupMarkdown(report, RENDER)
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain(CANARY.userText)
      expect((error as Error).message).not.toContain(CANARY.userText)
    }
    const measureReport = mixedReport()
    measureReport.checks[0].bySource.codex.swob.becameSession = u('units', 'census.not-implemented')
    expect(renderCheckupMarkdown(measureReport, RENDER)).toContain('—（本版体检还没有清点这个来源）')
  })
})

describe('renderCheckupMarkdown on the sample HOME report (runKernelCheckup)', () => {
  it('renders owner and engineer versions without any canary', async () => {
    expect(validate(sampleReport), JSON.stringify(validate.errors)).toBe(true)
    // C2a: a literal here churns every time any package bumps CHECKUP_VERSION; assert against the constant.
    expect(sampleReport.kernel.checkupVersion).toBe(CHECKUP_VERSION)
    const owner = renderCheckupMarkdown(sampleReport, RENDER)
    const engineer = renderCheckupMarkdown(sampleReport, { ...RENDER, audience: 'engineer' })
    for (const canary of Object.values(CANARY)) {
      expect(owner.includes(canary), canary).toBe(false)
      expect(engineer.includes(canary), canary).toBe(false)
    }
    await expect(owner).toMatchFileSnapshot('./__fixtures__/snapshots/sample-home-owner.md')
    // Sample ids hash the sandbox path, which differs per run: mask them for the snapshot.
    await expect(engineer.replace(/\b[0-9a-f]{8}\b/g, 'xxxxxxxx')).toMatchFileSnapshot('./__fixtures__/snapshots/sample-home-engineer.md')
  })

  it('renders a C1a one-day report (not implemented yet: every check undetermined)', async () => {
    const stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'checkup-render-day-')))
    assertInsideTestSandbox(stateDir)
    let day: CheckupReport
    try {
      day = await runKernelCheckup({ homeDir: HOME, stateDir, privacySalt: 'render-test-salt', scope: { kind: 'day', day: '2026-09-26' } })
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true })
    }
    expect(validate(day), JSON.stringify(validate.errors)).toBe(true)
    const markdown = renderCheckupMarkdown(day, RENDER)
    expect(markdown).toContain('范围：2026-09-26 当天有新消息的会话')
    expect(markdown).toContain('## 总评：无法判定')
    expect(markdown).toContain('无法判定（没有能给出结论的检查项）')
    expect(markdown).toContain('| Claude Code · Codex · Cursor · OpenCode · ZCode · CC-Mirror · Antigravity · Grok Build · Pi · Kimi Code · Hermes · Qoder · Trae · Gemini CLI | 无法判定（范围未实现） |')
    expect(markdown).not.toContain('## 附：原始数据盘点')
    expect(markdown).toContain('没有记录到副作用。')
    expect(checkupDigest(day)).toBe('体检 · 无法判定（没有能给出结论的检查项）')
  })

  it('marks the sources a one-day --sources run did not select, as a full run does (C1d)', async () => {
    const stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'checkup-render-day-')))
    assertInsideTestSandbox(stateDir)
    const dayScope = { kind: 'day', day: '2026-09-26' } as const
    let everything: CheckupReport
    let day: CheckupReport
    try {
      everything = await runKernelCheckup({ homeDir: HOME, stateDir, privacySalt: 'render-test-salt', scope: dayScope })
      day = await runKernelCheckup({ homeDir: HOME, stateDir, privacySalt: 'render-test-salt', scope: dayScope, sources: ['claude-code', 'codex'] })
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true })
    }
    expect(validate(day), JSON.stringify(validate.errors)).toBe(true)
    for (const check of day.checks) {
      expect([check.verdict, check.reason], check.id).toEqual(['undetermined', 'checkup.scope-not-implemented'])
      for (const [source, entry] of Object.entries(check.bySource)) {
        expect([entry.verdict, entry.swob.status?.reason], `${check.id} ${source}`).toEqual(source === 'claude-code' || source === 'codex'
          ? ['undetermined', 'checkup.scope-not-implemented']
          : ['not-applicable', 'source.not-selected'])
      }
    }
    expect(sourcesSelected(day)).toEqual(['claude-code', 'codex'])
    expect(sourcesSelected(everything)).toBe('all')
    // Why (compare.ts compareIssues): once a day check can conclude, an earlier problem of a source this
    // run did not select is 「本次未检查」, never 「已修复」.
    const previous = clone(everything)
    previous.checks[0].findings.push(finding('unsupported.kimi-legacy-sessions', 'warn', 'kimi', r(3, 'sessions')))
    const concluded = clone(day)
    concluded.checks[0].verdict = 'pass'
    delete concluded.checks[0].reason
    const issues = compareIssues(previous, concluded)
    expect(issues.fixed).toEqual([])
    expect(issues.notChecked.map((issue) => [issue.code, issue.source])).toEqual([['unsupported.kimi-legacy-sessions', 'kimi']])
    const markdown = renderCheckupMarkdown(day, RENDER)
    expect(markdown).toContain('不适用（未选）')
    expect(scanMarkdownForPrivacy(markdown)).toEqual({ ok: true, hits: [] })
    expect(checkupDigest(day)).toBe('体检（部分来源） · 无法判定（没有能给出结论的检查项）')
  })

  it('shows the per-source readout sessions', () => {
    const owner = renderCheckupMarkdown(sampleReport, RENDER)
    expect(sampleReport.readoutBySource?.['claude-code']?.sessions).toMatchObject({ label: 'reported' })
    expect(owner).toContain('| Swob 读到的会话 |')
  })

  it('shows the Codex read count measured per file (C1c): the U+2028 record is read, nothing is lost', () => {
    const owner = renderCheckupMarkdown(sampleReport, RENDER)
    expect(owner).toContain('| Codex | 19[R] | 0[R] | 19[R] | 19[R] | 0[D] | — | 100%[D] |')
    expect(owner).not.toContain('Swob 没有按文件给出读入数')
  })
})

describe('report file names', () => {
  it('uses the local date and the machine tag (first six hex of saltFingerprint)', () => {
    const names = reportFileNames(mixedReport(), { utcOffsetMinutes: 480 })
    expect(names).toEqual({
      tag: 'a1b2c3', date: '2026-09-27', base: 'Swob内核体检-2026-09-27-a1b2c3',
      markdown: 'Swob内核体检-2026-09-27-a1b2c3.md', json: 'Swob内核体检-2026-09-27-a1b2c3.json', latest: '最新-a1b2c3.md'
    })
    expect(reportFileNames(mixedReport(), { utcOffsetMinutes: -600 }).date).toBe('2026-09-26')
    expect(names.markdown).toMatch(REPORT_FILE_PATTERN)
    expect(names.json).toMatch(REPORT_FILE_PATTERN)
    expect(names.base).toMatch(REPORT_BASENAME_PATTERN)
    expect(names.latest).toMatch(LATEST_FILE_PATTERN)
    expect(() => machineTag(undefined)).toThrow(/saltFingerprint/)
    expect(() => reportFileNames({ generatedAt: '2026-09-27T01:02:03.000Z' })).toThrow(/saltFingerprint/)
  })

  it('formats local time with its UTC offset', () => {
    expect(localTime('2026-09-26T16:30:00.000Z', 480)).toEqual({ date: '2026-09-27', time: '2026-09-27 00:30', offset: 'UTC+08:00' })
    expect(localTime('2026-09-26T16:30:00.000Z', -150)).toEqual({ date: '2026-09-26', time: '2026-09-26 14:00', offset: 'UTC-02:30' })
  })
})
