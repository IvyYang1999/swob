import { describe, expect, it } from 'vitest'
import { BUILTIN_PROVIDER_DEFINITIONS } from '../../../../shared/provider-capabilities'
import {
  productionProviderParityFixtures,
  PROVIDER_DOCTOR_CAPABILITIES,
  sanitizeProviderDiagnosticText
} from './provider-parity'

describe('production Provider Registry parity', () => {
  it('dynamically projects every production provider and every required Doctor row', () => {
    const fixtures = productionProviderParityFixtures()
    expect(fixtures.map((fixture) => fixture.providerId)).toEqual(
      BUILTIN_PROVIDER_DEFINITIONS.map((definition) => definition.manifest.providerId)
    )
    expect(fixtures).toHaveLength(14)
    for (const fixture of fixtures) {
      expect(Object.keys(fixture.capabilities).sort()).toEqual([...PROVIDER_DOCTOR_CAPABILITIES].sort())
      expect(fixture.formatVersions.length).toBeGreaterThan(0)
      expect(fixture.fixturePaths.length, fixture.providerId).toBeGreaterThan(0)
      expect(fixture.capabilities['wsl-path'].truth).toBe('unavailable')
      expect(fixture.capabilities['execution-domain'].truth).toBe('unavailable')
    }
  })

  it('labels protocol-v1 historical event migration as derived rather than exact', () => {
    for (const fixture of productionProviderParityFixtures()) {
      expect(fixture.capabilities.compact.truth).toBe('derived')
      expect(fixture.capabilities.context.truth).toBe('derived')
      expect(fixture.capabilities.interaction.truth).toBe('derived')
      expect(fixture.capabilities.permission.truth).toBe('derived')
    }
  })

  it('redacts private paths and email addresses from diagnostic text', () => {
    const dirty = '/Users/alice/private/session.json user@example.com'
    expect(sanitizeProviderDiagnosticText(dirty)).toBe('<private-path> <private-email>')
  })
})
