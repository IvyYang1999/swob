import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  getRecoveryMetricsPath,
  readRecoveryAttempts,
  recordRecoveryAttempt,
  summarizeRecoveryAttempts
} from './recovery-metrics'

const roots: string[] = []

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-recovery-metrics-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('recovery metrics', () => {
  it('durably appends privacy-minimal success and failure attempts and computes a real rate', () => {
    const root = makeRoot()
    recordRecoveryAttempt(root, {
      sessionId: 'session-a',
      physicalSessionId: 'physical-a',
      attemptedAt: '2026-07-21T10:00:00.000Z',
      durationMs: 125,
      result: { ok: true, state: 'restored' }
    })
    recordRecoveryAttempt(root, {
      sessionId: 'session-b',
      attemptedAt: '2026-07-21T10:01:00.000Z',
      durationMs: 20,
      result: { ok: false, reason: 'target-conflict' }
    })

    const attempts = readRecoveryAttempts(root)
    expect(attempts).toHaveLength(2)
    expect(attempts[0]).toMatchObject({
      version: 1,
      sessionId: 'session-a',
      outcome: 'restored',
      ok: true,
      durationMs: 125
    })
    expect(attempts[1]).toMatchObject({
      sessionId: 'session-b',
      outcome: 'failed',
      ok: false,
      failureCode: 'target-conflict'
    })
    expect(JSON.stringify(attempts)).not.toContain(root)
    expect(summarizeRecoveryAttempts(attempts)).toEqual({
      attempts: 2,
      successes: 1,
      failures: 1,
      successRate: 0.5,
      byFailureCode: { 'target-conflict': 1 }
    })
    expect(fs.statSync(getRecoveryMetricsPath(root)).mode & 0o777).toBe(0o600)
  })

  it('isolates malformed lines so one partial write cannot erase valid history', () => {
    const root = makeRoot()
    const filePath = getRecoveryMetricsPath(root)
    fs.writeFileSync(filePath, [
      JSON.stringify({
        version: 1,
        attemptId: 'valid',
        attemptedAt: '2026-07-21T10:00:00.000Z',
        sessionId: 'session-a',
        durationMs: 10,
        ok: true,
        outcome: 'already-present'
      }),
      '{partial'
    ].join('\n') + '\n', { mode: 0o600 })

    expect(readRecoveryAttempts(root)).toEqual([
      expect.objectContaining({ attemptId: 'valid', outcome: 'already-present' })
    ])
  })

  it('refuses a symlinked metrics file instead of appending outside the Library boundary', () => {
    const root = makeRoot()
    const outsideTarget = path.join(root, 'must-not-change.txt')
    fs.writeFileSync(outsideTarget, 'original', { mode: 0o600 })
    fs.symlinkSync(outsideTarget, getRecoveryMetricsPath(root))

    expect(() => recordRecoveryAttempt(root, {
      sessionId: 'session-a',
      attemptedAt: '2026-07-21T10:00:00.000Z',
      durationMs: 10,
      result: { ok: true, state: 'restored' }
    })).toThrow(/regular file/i)
    expect(readRecoveryAttempts(root)).toEqual([])
    expect(fs.readFileSync(outsideTarget, 'utf8')).toBe('original')
  })
})
