import { describe, expect, it } from 'vitest'
import { auditSession } from './session-audit'

function assistant(
  uuid: string,
  timestamp: string,
  content: Array<Record<string, unknown>>,
  usage?: { input_tokens?: number; output_tokens?: number }
): Record<string, unknown> {
  return {
    uuid,
    type: 'assistant',
    timestamp,
    message: { role: 'assistant', content, usage, model: 'claude-sonnet-4-20250514' }
  }
}

function user(
  uuid: string,
  timestamp: string,
  content: string | Array<Record<string, unknown>>
): Record<string, unknown> {
  return { uuid, type: 'user', timestamp, message: { role: 'user', content } }
}

describe('session audit evidence and accuracy', () => {
  it('correlates tool_result errors and latency by tool_use_id instead of inventing a tool name', () => {
    const audit = auditSession([
      assistant('a1', '2026-07-21T10:00:00.000Z', [
        { type: 'tool_use', id: 'toolu_bash_1', name: 'Bash', input: { command: 'false' } }
      ]),
      user('u1', '2026-07-21T10:00:02.000Z', [
        { type: 'tool_result', tool_use_id: 'toolu_bash_1', is_error: true, content: 'exit 1' }
      ]),
      assistant('a2', '2026-07-21T10:00:03.000Z', [
        { type: 'tool_use', id: 'toolu_bash_2', name: 'Bash', input: { command: 'true' } }
      ]),
      user('u2', '2026-07-21T10:00:04.000Z', [
        { type: 'tool_result', tool_use_id: 'toolu_bash_2', content: 'ok' }
      ])
    ] as never[], 'session-1')

    expect(audit.toolEfficiency).toContainEqual(expect.objectContaining({
      name: 'Bash',
      count: 2,
      errorCount: 1,
      errorRate: 0.5,
      avgLatencyMs: 1500
    }))
    expect(audit.toolEfficiency[0].evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ line: 1, messageUuid: 'a1', kind: 'tool-use' }),
      expect.objectContaining({ line: 2, messageUuid: 'u1', kind: 'tool-result' })
    ]))
    expect(audit.toolEfficiency.some((tool) => tool.name.startsWith('toolu_'))).toBe(false)
  })

  it('labels the Read/Edit health threshold as heuristic and excludes it from score penalties', () => {
    const audit = auditSession([
      assistant('a1', '2026-07-21T10:00:00.000Z', [
        { type: 'tool_use', id: 'edit-1', name: 'Edit', input: { file_path: '/tmp/a.ts' } }
      ])
    ] as never[], 'session-2')

    expect(audit.experimental).toBe(true)
    expect(audit.readEditRatio.provenance).toBe('reported')
    expect(audit.readEditHealthBasis).toBe('heuristic-unvalidated')
    expect(audit.readEditRatio.caveat).toMatch(/heuristic|经验|unvalidated/i)
    expect(audit.scoreFactors.some((factor) => factor.key === 'read-edit-ratio')).toBe(false)
    expect(audit.healthScore).toBe(80)
  })

  it('attaches line-addressable raw evidence and explicit caveats to every displayed metric', () => {
    const audit = auditSession([
      user('u1', '2026-07-21T10:00:00.000Z', '<system-reminder>fixture</system-reminder>'),
      assistant('a1', '2026-07-21T10:00:01.000Z', [
        { type: 'thinking', thinking: 'reasoning', signature: 'sig' },
        { type: 'text', text: 'answer' }
      ], { input_tokens: 100, output_tokens: 20 })
    ] as never[], 'session-3')

    for (const metric of [
      audit.readEditRatio,
      audit.thinkingDepth,
      audit.latencyStats,
      audit.valuation,
      audit.visibleFrameworkMarkers
    ]) {
      expect(metric).toHaveProperty('evidence')
      expect(metric).toHaveProperty('caveat')
    }
    expect(audit.thinkingDepth.evidence).toContainEqual(
      expect.objectContaining({ line: 2, messageUuid: 'a1', kind: 'thinking' })
    )
    expect(audit.valuation.evidence).toContainEqual(
      expect.objectContaining({ line: 2, messageUuid: 'a1', kind: 'usage' })
    )
    expect(audit.visibleFrameworkMarkers.evidence).toContainEqual(
      expect.objectContaining({ line: 1, messageUuid: 'u1', kind: 'framework' })
    )
    expect(audit.valuation.caveat).toMatch(/API 等价值|provider|cash/i)
    expect(audit.limitations.join(' ')).toMatch(/Context Inspector.*estimated/i)
    expect(audit.limitations.join(' ')).toMatch(/sidechain|child transcript/i)
  })

  it('explains every health-score deduction with evidence instead of a black-box number', () => {
    const messages = [
      user('u1', '2026-07-21T10:00:00.000Z', '不对，重来'),
      user('u2', '2026-07-21T10:00:01.000Z', '不对，重来'),
      user('u3', '2026-07-21T10:00:02.000Z', '错了'),
      user('u4', '2026-07-21T10:00:03.000Z', '撤销')
    ]
    const audit = auditSession(messages as never[], 'session-4')

    const deductions = audit.scoreFactors.filter((factor) => factor.impact < 0)
    expect(deductions.length).toBeGreaterThan(0)
    for (const factor of deductions) {
      expect(factor.evidence.length).toBeGreaterThan(0)
      expect(factor.evidence[0].line).toBeGreaterThan(0)
    }
    expect(80 + deductions.reduce((total, factor) => total + factor.impact, 0)).toBe(audit.healthScore)
  })
})

describe('session audit token semantics', () => {
  it('【回归】XML 只能标为可见标记估算，不能冒充 API framework/context 开销百分比', () => {
    const audit = auditSession([
      {
        uuid: 'u1',
        type: 'user',
        timestamp: '2026-07-22T00:00:00Z',
        message: {
          role: 'user',
          content: '<system-reminder>visible injected note</system-reminder>\n这是用户自己的正文，不能算进标记。'
        }
      },
      {
        uuid: 'a1',
        type: 'assistant',
        timestamp: '2026-07-22T00:00:01Z',
        message: { role: 'assistant', content: '收到' }
      }
    ] as never[], 'audit-1')

    expect(audit.visibleFrameworkMarkers.provenance).toBe('estimated')
    expect(audit.visibleFrameworkMarkers.value.estimatedMarkerTokens).toBeGreaterThan(0)
    expect(audit.visibleFrameworkMarkers.value.estimatedMarkerTokens)
      .toBeLessThan(audit.visibleFrameworkMarkers.value.estimatedVisibleUserTokens)
    expect(audit.findings.some((finding) => finding.toLowerCase().includes('framework overhead'))).toBe(false)
    expect(audit.healthScore).toBe(80)
    expect('frameworkOverhead' in audit).toBe(false)
  })
})
