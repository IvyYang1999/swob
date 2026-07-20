import { describe, expect, it } from 'vitest'
import { SYNTHETIC_LOGICAL_ID } from './__fixtures__/backup-validation-synthetic'
import { verifyClaudeResumeTarget } from './resume-verifier'

const options = {
  expectedLogicalSessionId: SYNTHETIC_LOGICAL_ID,
  expectedPhysicalSessionId: SYNTHETIC_LOGICAL_ID
}

function row(
  uuid: string,
  parentUuid: string | null,
  type: 'user' | 'assistant',
  content: string
): Record<string, unknown> {
  return {
    sessionId: SYNTHETIC_LOGICAL_ID,
    uuid,
    parentUuid,
    isSidechain: false,
    type,
    timestamp: '2026-07-19T00:00:00.000Z',
    message: { role: type, content }
  }
}

function transcript(middleContent: string): Buffer {
  return Buffer.from([
    row('verify-user-start', null, 'user', 'synthetic opening user'),
    row('verify-assistant-middle', 'verify-user-start', 'assistant', middleContent),
    row('verify-user-tail', 'verify-assistant-middle', 'user', 'synthetic tail user anchor'),
    row('verify-assistant-tail', 'verify-user-tail', 'assistant', 'synthetic tail assistant anchor')
  ].map((value) => JSON.stringify(value)).join('\n') + '\n')
}

describe('shared recovery verifier', () => {
  it('源与目标逐字节和全文 hash 一致时双校验通过', () => {
    const source = transcript('synthetic middle unchanged')
    const result = verifyClaudeResumeTarget(source, Buffer.from(source), options)

    expect(result.status).toBe('match')
    expect(result.l3.status).toBe('match')
    expect(result.integrity).toMatchObject({
      algorithm: 'sha256',
      byteEqual: true,
      hashEqual: true,
      matches: true,
      sourceHash: result.integrity.targetHash
    })
  })

  it('【验收点名】锚点相同但中间行被篡改时由全文双校验抓住', () => {
    const source = transcript('synthetic original middle')
    const target = transcript('synthetic tampered middle')
    const result = verifyClaudeResumeTarget(source, target, options)

    expect(result.sourceValidation.ok).toBe(true)
    expect(result.targetValidation.ok).toBe(true)
    expect(result.l3.status).toBe('match')
    expect(result.integrity).toMatchObject({ byteEqual: false, hashEqual: false, matches: false })
    expect(result.status).toBe('mismatch')
  })

  it('目标不是严格 JSONL 时在比较锚点之前也不能通过', () => {
    const source = transcript('synthetic valid middle')
    const target = Buffer.concat([source, Buffer.from('"orphan":"tail"}\n')])
    const result = verifyClaudeResumeTarget(source, target, options)

    expect(result.status).toBe('invalid-target')
    expect(result.targetValidation.ok).toBe(false)
    expect(result.integrity.matches).toBe(false)
  })
})
