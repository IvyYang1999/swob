import { describe, expect, it } from 'vitest'
import { MULTICA_ORCHESTRATION_DESCRIPTOR } from './multica'
import { ORCHESTRATION_REGISTRATIONS, orchestrationRegistration } from './registry'

describe('t211I orchestration registry', () => {
  it('registers the accepted Multica descriptor exactly once', () => {
    expect(ORCHESTRATION_REGISTRATIONS).toEqual([MULTICA_ORCHESTRATION_DESCRIPTOR])
    expect(orchestrationRegistration('multica')).toBe(MULTICA_ORCHESTRATION_DESCRIPTOR)
    expect(new Set(ORCHESTRATION_REGISTRATIONS.map((entry) => entry.orchestratorId)).size)
      .toBe(ORCHESTRATION_REGISTRATIONS.length)
  })
})
