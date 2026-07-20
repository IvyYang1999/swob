import { describe, expect, it } from 'vitest'
import {
  REPAIRABLE_RAW_LF_JSONL,
  SINGLE_ID_OPTIONS,
  SIX_REPORTED_BACKUP_SHAPES
} from './__fixtures__/backup-validation-synthetic'
import { repairBackupJsonl } from './backup-repairer'

describe('lossless backup repairer', () => {
  it('只编码字符串内 raw LF，修复后通过严格校验并保留逐字节日志', () => {
    const input = Buffer.from(REPAIRABLE_RAW_LF_JSONL)
    const before = Buffer.from(input)
    const result = repairBackupJsonl(input, SINGLE_ID_OPTIONS)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.changed).toBe(true)
    expect(result.validation.ok).toBe(true)
    expect(result.log).toEqual([
      expect.objectContaining({ action: 'encode-raw-line-break', inputForm: 'lf', replacement: '\\n' })
    ])
    expect(result.content.toString('utf8')).toContain('synthetic first line\\nsynthetic second line')
    expect(input.equals(before)).toBe(true)
  })

  it('四类不可无损修形态逐类拒绝且不返回猜测内容', () => {
    const names = ['orphanTail', 'interleavedAssistantFragments', 'missingPrefix', 'separatedFragments'] as const
    for (const name of names) {
      const fixture = SIX_REPORTED_BACKUP_SHAPES[name]
      const input = Buffer.from(fixture.content)
      const before = Buffer.from(input)
      const result = repairBackupJsonl(input, SINGLE_ID_OPTIONS)

      expect(result.ok, name).toBe(false)
      if (result.ok) continue
      expect(result.reason, name).toBe('unsupported-damage')
      expect(input.equals(before), name).toBe(true)
      expect('content' in result, name).toBe(false)
    }
  })

  it('已经严格有效的两类当前样本原样返回副本', () => {
    for (const name of ['currentlyStrictValidShort', 'currentlyStrictValidLong'] as const) {
      const input = Buffer.from(SIX_REPORTED_BACKUP_SHAPES[name].content)
      const result = repairBackupJsonl(input, SINGLE_ID_OPTIONS)

      expect(result.ok).toBe(true)
      if (!result.ok) continue
      expect(result.changed).toBe(false)
      expect(result.log).toEqual([])
      expect(result.content.equals(input)).toBe(true)
      expect(result.content).not.toBe(input)
    }
  })

  it('raw LF 之外仍有坏片段时拒绝唯一候选，不做部分修复', () => {
    const mixed = REPAIRABLE_RAW_LF_JSONL + '"orphan":"tail"}\n'
    const result = repairBackupJsonl(mixed, SINGLE_ID_OPTIONS)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('candidate-invalid')
    expect(result.candidateValidation?.ok).toBe(false)
  })

  it('字符串内 raw CRLF 按同一唯一规则编码为 JSON newline', () => {
    const crlf = REPAIRABLE_RAW_LF_JSONL.replace(
      'synthetic first line\nsynthetic second line',
      'synthetic first line\r\nsynthetic second line'
    )
    const result = repairBackupJsonl(crlf, SINGLE_ID_OPTIONS)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.changed).toBe(true)
    expect(result.log).toEqual([expect.objectContaining({ inputForm: 'crlf', replacement: '\\n' })])
    expect(result.validation.ok).toBe(true)
  })

  it('raw CR 明确拒绝且不改写为 LF', () => {
    const rawCr = REPAIRABLE_RAW_LF_JSONL.replace(
      'synthetic first line\nsynthetic second line',
      'synthetic first line\rsynthetic second line'
    )
    const input = Buffer.from(rawCr)
    const before = Buffer.from(input)
    const result = repairBackupJsonl(input, SINGLE_ID_OPTIONS)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('unsupported-line-ending')
    expect(input).toEqual(before)
    expect('content' in result).toBe(false)
  })

  it('raw newline 前存在未完成 escape 时因语义歧义明确拒绝', () => {
    const ambiguous = REPAIRABLE_RAW_LF_JSONL.replace(
      'synthetic first line\nsynthetic second line',
      `synthetic first line\\${'\n'}synthetic second line`
    )
    const result = repairBackupJsonl(ambiguous, SINGLE_ID_OPTIONS)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('ambiguous-escaped-boundary')
  })
})
