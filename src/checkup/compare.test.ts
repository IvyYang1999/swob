import { describe, expect, it } from 'vitest'
import type { CheckupReport } from './contract'
import { compareCheckupReports, compareIssues, compareUnits, comparisonRefusal } from './compare'
import { OTHER_FINGERPRINT, clone, d, finding, mixedReport, r, unit } from './__fixtures__/checkup-reports'

function pair(): { previous: CheckupReport; current: CheckupReport } {
  const previous = mixedReport()
  previous.generatedAt = '2026-09-26T01:00:00.000Z'
  return { previous, current: mixedReport() }
}

describe('when two reports are comparable', () => {
  it('requires schema v1, the same saltFingerprint on both and the same scope kind', () => {
    const { previous, current } = pair()
    expect(comparisonRefusal(previous, current)).toBeNull()
    const legacy = clone(previous)
    delete legacy.saltFingerprint
    expect(comparisonRefusal(legacy, current)).toBe('compare.previous-no-fingerprint')
    const unstamped = clone(current)
    delete unstamped.saltFingerprint
    expect(comparisonRefusal(previous, unstamped)).toBe('compare.current-no-fingerprint')
    expect(comparisonRefusal({ ...previous, saltFingerprint: OTHER_FINGERPRINT }, current)).toBe('compare.fingerprint-mismatch')
    expect(comparisonRefusal({ ...previous, scope: { kind: 'day', day: '2026-09-26' } }, current)).toBe('compare.scope-mismatch')
    expect(comparisonRefusal({ ...previous, schemaVersion: 2 } as unknown as CheckupReport, current)).toBe('compare.schema-mismatch')
    expect(comparisonRefusal({ ...previous, generatedAt: 'yesterday' }, current)).toBe('compare.schema-mismatch')
    expect(comparisonRefusal({ schemaVersion: 1 } as unknown as CheckupReport, current)).toBe('compare.schema-mismatch')
  })

  it('a refused comparison compares nothing at either level', () => {
    const { previous, current } = pair()
    const result = compareCheckupReports({ ...previous, saltFingerprint: OTHER_FINGERPRINT }, current)
    expect(result).toMatchObject({ comparable: false, refusal: 'compare.fingerprint-mismatch', issues: null, units: null, checks: [] })
  })
})

describe('issue level (all six checks, keyed by check + code + source)', () => {
  it('an unchanged report has only unchanged issues, with count deltas', () => {
    const { previous, current } = pair()
    const issues = compareIssues(previous, current)
    expect(issues.added).toEqual([])
    expect(issues.fixed).toEqual([])
    expect(issues.unchanged.map((issue) => [issue.check, issue.code, issue.source, issue.delta])).toEqual([
      ['inclusion', 'codex.nested-subagent-orphan', 'codex', 0],
      ['inclusion', 'readout.source-empty', 'opencode', null],
      ['inclusion', 'unsupported.kimi-legacy-sessions', 'kimi', 0],
      ['content', 'content.line-separator-split', 'claude-code', 0],
      ['compaction', 'codex.legacy-compacted-unrecognized', 'codex', 0]
    ])
    // not-applicable (tool-side) and undetermined findings are not problems.
    expect(issues.unchanged.some((issue) => issue.code === 'content.tool-bad-line' || issue.code === 'census.file-changed-during-run')).toBe(false)
  })

  it('splits new, fixed and changed-count issues', () => {
    const { previous, current } = pair()
    previous.checks[2].findings = []
    previous.checks[1].findings[0] = finding('content.line-separator-split', 'fail', 'claude-code', d(5, 'records'), [5, 2])
    current.checks[0].findings = current.checks[0].findings.filter((entry) => entry.code !== 'unsupported.kimi-legacy-sessions')
    const issues = compareIssues(previous, current)
    expect(issues.added.map((issue) => [issue.check, issue.code, issue.current?.value])).toEqual([['compaction', 'codex.legacy-compacted-unrecognized', 4]])
    expect(issues.fixed.map((issue) => [issue.code, issue.previous?.value, issue.current])).toEqual([['unsupported.kimi-legacy-sessions', 3, null]])
    expect(issues.unchanged.find((issue) => issue.code === 'content.line-separator-split')).toMatchObject({ delta: -2, previous: { value: 5 }, current: { value: 3 } })
  })

  it('an issue where the previous report could not look is a first check, not a new issue', () => {
    const { previous, current } = pair()
    current.checks[3].findings.push(finding('codex.nested-subagent-orphan', 'warn', 'codex', d(1, 'units')))
    // The previous report predates readoutBySource: it could not have found an empty source.
    delete previous.readoutBySource
    previous.checks[0].findings = previous.checks[0].findings.filter((entry) => entry.code !== 'readout.source-empty')
    // The previous ③ was undetermined as a whole.
    previous.checks[2].verdict = 'undetermined'
    previous.checks[2].findings = []
    const issues = compareIssues(previous, current)
    expect(issues.firstCheck.map((issue) => [issue.check, issue.code])).toEqual([
      ['inclusion', 'readout.source-empty'],
      ['compaction', 'codex.legacy-compacted-unrecognized'],
      ['lineage', 'codex.nested-subagent-orphan']
    ])
    expect(issues.added).toEqual([])
  })

  it('an issue whose check is undetermined now was not checked, not fixed', () => {
    const { previous, current } = pair()
    current.checks[2].verdict = 'undetermined'
    current.checks[2].findings = []
    const issues = compareIssues(previous, current)
    expect(issues.notChecked.map((issue) => issue.code)).toEqual(['codex.legacy-compacted-unrecognized'])
    expect(issues.fixed).toEqual([])
  })
})

describe('unit level (① ②, same id and unitSig only)', () => {
  it('counts compared, new or changed, gone and changed-during-run units', () => {
    const { previous, current } = pair()
    current.units = [
      ...current.units!.filter((entry) => entry.id !== '10000001'),
      unit('10000001', { unitSig: '6ffffff1' }),
      unit('40000001')
    ]
    previous.units = [...previous.units!, unit('50000001')]
    const units = compareUnits(previous, current)!
    expect(units).toMatchObject({ compared: 5, newOrChanged: 2, gone: 1, changedDuringRun: 1 })
  })

  it('classifies inclusion and content problems per unit', () => {
    const { previous, current } = pair()
    const set = (report: CheckupReport, id: string, patch: Parameters<typeof unit>[1]): void => {
      report.units = report.units!.map((entry) => entry.id === id ? { ...entry, ...patch } : entry)
    }
    // Content: fixed (9 → 10 read), newly broken, and first checked (swobRead was null before).
    set(current, '10000002', { swobRead: 10 })
    set(current, '10000001', { swobRead: 8 })
    set(previous, '10000003', { swobRead: null })
    set(current, '10000003', { swobRead: 4 })
    // Inclusion: one orphan got attached, one orphan remains.
    set(current, '20000002', { bucket: 'merged', reason: 'codex.child-attached' })
    const units = compareUnits(previous, current)!
    const summary = units.groups.map((group) => [group.outcome, group.source, group.problem, group.reason, group.units])
    expect(summary).toEqual([
      ['added', 'claude-code', 'content', null, 1],
      ['fixed', 'claude-code', 'content', null, 1],
      ['fixed', 'codex', 'inclusion', 'codex.nested-subagent-orphan', 1],
      ['unchanged', 'codex', 'inclusion', 'codex.nested-subagent-orphan', 1],
      ['firstCheck', 'claude-code', 'content', null, 1]
    ])
    expect(units.groups[0].samples).toEqual(['10000001'])
  })

  it('bad or truncated tool lines are not Swob problems (read equals the parseable records)', () => {
    const { previous, current } = pair()
    const damaged = { nonBlank: 12, bad: 1, parseable: 10, lineSeparator: 0, truncatedTail: 1 }
    current.units = current.units!.map((entry) => entry.id === '10000001' ? { ...entry, records: damaged } : entry)
    previous.units = previous.units!.map((entry) => entry.id === '10000001' ? { ...entry, records: damaged } : entry)
    expect(compareUnits(previous, current)!.groups.some((group) => group.samples.includes('10000001'))).toBe(false)
  })

  it('is skipped when a report carries no units', () => {
    const { previous, current } = pair()
    delete previous.units
    expect(compareUnits(previous, current)).toBeNull()
    expect(compareCheckupReports(previous, current)).toMatchObject({ comparable: true, units: null })
  })

  it('reports the six check verdicts side by side', () => {
    const { previous, current } = pair()
    previous.checks[0].bySource.codex.swob.notIncluded = r(0, 'units')
    previous.checks[0].verdict = 'pass'
    const result = compareCheckupReports(previous, current)
    expect(result.checks[0]).toEqual({ id: 'inclusion', previous: 'pass', current: 'warn' })
    expect(result.checks).toHaveLength(6)
  })
})
