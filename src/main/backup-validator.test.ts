import { describe, expect, it } from 'vitest'
import {
  DOUBLE_ID_OPTIONS,
  LEGAL_DOUBLE_ID_JSONL,
  REPAIRABLE_RAW_LF_JSONL,
  SINGLE_ID_OPTIONS,
  SIX_REPORTED_BACKUP_SHAPES,
  THIRD_CONFLICTING_ID_JSONL,
  UNRELATED_DOUBLE_ID_JSONL
} from './__fixtures__/backup-validation-synthetic'
import { RECOVERY_SYNTHETIC_FIXTURES } from './__fixtures__/resume-recovery-synthetic'
import { validateBackupJsonl } from './backup-validator'
import { planSessionRecovery } from './resume-recovery-planner'

describe('strict backup validator', () => {
  it('逐一判定六个实看形态的脱敏 fixture', () => {
    expect(Object.keys(SIX_REPORTED_BACKUP_SHAPES)).toHaveLength(6)
    for (const [name, fixture] of Object.entries(SIX_REPORTED_BACKUP_SHAPES)) {
      const result = validateBackupJsonl(fixture.content, SINGLE_ID_OPTIONS)
      expect(result.ok, name).toBe(fixture.expectedOk)
      expect(result.parseableLineCount, name).toBe(fixture.expectedParseableLines)
      if ('expectedShape' in fixture && fixture.expectedShape) {
        expect(result.fragments.map((fragment) => fragment.shape), name).toContain(fixture.expectedShape)
      } else {
        expect(result.fragments, name).toEqual([])
      }
    }
  })

  it('识别 quoted string 内物理换行并给出字节和物理行位置', () => {
    const result = validateBackupJsonl(REPAIRABLE_RAW_LF_JSONL, SINGLE_ID_OPTIONS)

    expect(result.ok).toBe(false)
    expect(result.physicalNewlineBreaks).toEqual([
      expect.objectContaining({ lineStart: 2, lineEnd: 3, form: 'lf', escapedBefore: false })
    ])
    expect(result.fragments).toEqual([
      expect.objectContaining({ shape: 'physical-newline-in-string', lineStart: 2, lineEnd: 3 })
    ])
  })

  it('逻辑 ID 到物理 ID 有主链父锚点时形式化为合法 continuation', () => {
    const result = validateBackupJsonl(LEGAL_DOUBLE_ID_JSONL, DOUBLE_ID_OPTIONS)

    expect(result.ok).toBe(true)
    expect(result.sessionIds).toEqual([
      DOUBLE_ID_OPTIONS.expectedLogicalSessionId,
      DOUBLE_ID_OPTIONS.expectedPhysicalSessionId
    ])
    expect(result.mainChain).toMatchObject({
      kind: 'continuation',
      mainChainSessionIds: [
        DOUBLE_ID_OPTIONS.expectedLogicalSessionId,
        DOUBLE_ID_OPTIONS.expectedPhysicalSessionId
      ],
      transitions: [{
        from: DOUBLE_ID_OPTIONS.expectedLogicalSessionId,
        to: DOUBLE_ID_OPTIONS.expectedPhysicalSessionId,
        evidence: 'direct-parent'
      }]
    })
  })

  it('正式 type:summary + leafUuid continuation 正例与 t089a fixture 同判通过', () => {
    const fixture = RECOVERY_SYNTHETIC_FIXTURES.logicalPhysicalDoubleId
    const validation = validateBackupJsonl(fixture.evidence.jsonl, {
      expectedLogicalSessionId: fixture.sessionId,
      expectedPhysicalSessionId: fixture.backup.physicalSessionId
    })
    const planning = planSessionRecovery(structuredClone(fixture))

    expect(validation.ok).toBe(true)
    expect(validation.mainChain).toMatchObject({
      kind: 'continuation',
      transitions: [{
        from: fixture.sessionId,
        to: fixture.backup.physicalSessionId,
        evidence: 'summary-leaf'
      }]
    })
    expect(planning.ok).toBe(validation.ok)
  })

  it('【验收点名原样】只有 sessionId 的空壳 object 不能通过严格门槛', () => {
    const shell = '{"sessionId":"71000000-0000-4000-8000-000000000001"}'
    const result = validateBackupJsonl(shell, SINGLE_ID_OPTIONS)

    expect(result.ok).toBe(false)
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'missing-claude-message' }),
      expect.objectContaining({ code: 'missing-resume-evidence' })
    ]))
  })

  it('两个无结构关系的目标 ID 明确拒绝', () => {
    const result = validateBackupJsonl(UNRELATED_DOUBLE_ID_JSONL, DOUBLE_ID_OPTIONS)

    expect(result.ok).toBe(false)
    expect(result.mainChain.kind).toBe('conflict')
    expect(result.errors).toContainEqual(expect.objectContaining({ code: 'session-id-conflict' }))
  })

  it('第三个目标 ID 即使在同一父链也明确拒绝', () => {
    const result = validateBackupJsonl(THIRD_CONFLICTING_ID_JSONL, DOUBLE_ID_OPTIONS)

    expect(result.ok).toBe(false)
    expect(result.sessionIds).toHaveLength(3)
    expect(result.mainChain.reason).toContain('exactly the distinct expected logical and physical IDs')
  })

  it('带 forkedFrom 的跨 ID 父链是分支而不是 continuation', () => {
    const rows = LEGAL_DOUBLE_ID_JSONL.trim().split('\n').map((line) => JSON.parse(line))
    rows[1].forkedFrom = {
      sessionId: DOUBLE_ID_OPTIONS.expectedLogicalSessionId,
      messageUuid: 'logical-user'
    }
    const result = validateBackupJsonl(rows.map((row) => JSON.stringify(row)).join('\n') + '\n', DOUBLE_ID_OPTIONS)

    expect(result.ok).toBe(false)
    expect(result.mainChain).toMatchObject({
      kind: 'conflict',
      reason: 'forkedFrom identifies a fork, not a legal continuation'
    })
  })

  it('空文件、空物理行、非 object 行均不属于严格 JSONL', () => {
    expect(validateBackupJsonl('', SINGLE_ID_OPTIONS).errors[0].code).toBe('empty-backup')
    expect(validateBackupJsonl('\n', SINGLE_ID_OPTIONS).fragments[0].shape).toBe('blank-line')
    expect(validateBackupJsonl('[]\n', SINGLE_ID_OPTIONS).fragments[0].shape).toBe('non-object')
  })

  it('检测器把 quoted string 内 raw CR 标为不支持的行尾形态', () => {
    const rawCr = REPAIRABLE_RAW_LF_JSONL.replace(
      'synthetic first line\nsynthetic second line',
      'synthetic first line\rsynthetic second line'
    )
    const result = validateBackupJsonl(rawCr, SINGLE_ID_OPTIONS)

    expect(result.ok).toBe(false)
    expect(result.physicalNewlineBreaks).toContainEqual(expect.objectContaining({ form: 'cr' }))
    expect(result.fragments).toContainEqual(expect.objectContaining({ shape: 'unsupported-line-ending' }))
  })
})
