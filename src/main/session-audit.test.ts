import { describe, expect, it } from 'vitest'
import { auditSession } from './session-audit'

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
    ], 'audit-1')

    expect(audit.visibleFrameworkMarkers.provenance).toBe('estimated')
    expect(audit.visibleFrameworkMarkers.value.estimatedMarkerTokens).toBeGreaterThan(0)
    expect(audit.visibleFrameworkMarkers.value.estimatedMarkerTokens)
      .toBeLessThan(audit.visibleFrameworkMarkers.value.estimatedVisibleUserTokens)
    expect(audit.findings.some((finding) => finding.toLowerCase().includes('framework overhead'))).toBe(false)
    expect(audit.healthScore).toBe(80)
    expect('frameworkOverhead' in audit).toBe(false)
  })
})
