import { describe, expect, it } from 'vitest'
import { duplicateRecoveryErrorCode } from './duplicate-recovery-failure-code'

describe('duplicate recovery error boundary', () => {
  it('never forwards native filesystem paths or private filenames', () => {
    const privatePath = '/private/Users/example/Library/private-session-name/.swob-session.json'
    const native = Object.assign(new Error(`EACCES: permission denied, open '${privatePath}'`), {
      code: 'EACCES'
    })
    expect(duplicateRecoveryErrorCode(native)).toBe('EACCES')
    expect(duplicateRecoveryErrorCode(new Error(`failed to read ${privatePath}`)))
      .toBe('DUPLICATE_RECOVERY_ANALYSIS_FAILED')
    expect(duplicateRecoveryErrorCode(new Error('duplicate-recovery-plan-expired')))
      .toBe('duplicate-recovery-plan-expired')
  })
})
