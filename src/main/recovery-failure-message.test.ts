import { describe, expect, it } from 'vitest'
import type { ClaudeResumeRecoveryFailureReason } from './resume-recovery-service'
import { recoveryFailureMessage } from './recovery-failure-message'

const reasons: ClaudeResumeRecoveryFailureReason[] = [
  'session-id-mismatch',
  'missing-source-path',
  'invalid-source-path',
  'missing-backup',
  'invalid-backup',
  'remote-source-requires-explicit-target',
  'non-standard-source-requires-explicit-target',
  'target-instance-not-found',
  'target-instance-unavailable',
  'target-instance-untrusted',
  'missing-target-inventory',
  'target-inventory-incomplete',
  'target-instance-missing-config-dir',
  'missing-local-device-id',
  'missing-local-username',
  'non-standard-target-refused',
  'target-conflict',
  'source-not-claude',
  'unverified-backup',
  'materialization-failed',
  'recovery-locked',
  'post-publish-verification-failed',
  'io-error'
]

describe('recovery failure messages', () => {
  it('gives every machine failure code a readable reason instead of exposing the raw code', () => {
    for (const reason of reasons) {
      const message = recoveryFailureMessage(reason)
      expect(message.length).toBeGreaterThan(8)
      expect(message).not.toContain(reason)
    }
  })
})
