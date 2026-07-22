import { describe, expect, it } from 'vitest'
import {
  BUILTIN_PROVIDER_DEFINITIONS,
  LEGACY_SESSION_SOURCES,
  builtinProviderForId,
  builtinProviderForSource,
  currentProviderCapabilitySnapshot,
  providerCanParseTranscript
} from './provider-capabilities'
import { validateProviderManifest } from './provider-protocol'

describe('current provider capability truth', () => {
  it('locks 5 native + 1 compatible + 5 detection-only sources', () => {
    expect(LEGACY_SESSION_SOURCES).toHaveLength(11)
    expect(BUILTIN_PROVIDER_DEFINITIONS.filter((entry) => entry.tier === 'native')).toHaveLength(5)
    expect(BUILTIN_PROVIDER_DEFINITIONS.filter((entry) => entry.tier === 'compatible')).toHaveLength(1)
    expect(BUILTIN_PROVIDER_DEFINITIONS.filter((entry) => entry.tier === 'detection-only')).toHaveLength(5)
    expect(new Set(BUILTIN_PROVIDER_DEFINITIONS.map((entry) => entry.manifest.providerId)).size).toBe(11)
  })

  it('every built-in manifest conforms to the language-neutral schema', () => {
    for (const definition of BUILTIN_PROVIDER_DEFINITIONS) {
      expect(validateProviderManifest(definition.manifest), definition.sourceId).toEqual({
        ok: true,
        value: definition.manifest,
        issues: []
      })
      expect(definition.manifest.providerId).toBe(`swob/${definition.sourceId}`)
    }
  })

  it('detection-only sources never claim stable transcript/search/usage/resume', () => {
    for (const definition of BUILTIN_PROVIDER_DEFINITIONS.filter((entry) => entry.tier === 'detection-only')) {
      const capability = definition.manifest.capabilities
      expect(capability.transcript.status, definition.sourceId).toBe('unavailable')
      expect(capability.search.status, definition.sourceId).toBe('unavailable')
      expect(capability.usage.status, definition.sourceId).toBe('unavailable')
      expect(capability['terminal-resume'].status, definition.sourceId).not.toBe('available')
      expect(capability['native-resume'].status, definition.sourceId).not.toBe('available')
    }
  })

  it('transcript-capable count comes from capabilities, not the 11-source discovery count', () => {
    expect(LEGACY_SESSION_SOURCES).toHaveLength(11)
    expect(LEGACY_SESSION_SOURCES.filter(providerCanParseTranscript)).toEqual([
      'claude-code', 'codex', 'cursor', 'opencode', 'zcode', 'cc-mirror'
    ])
  })

  it('looks up built-ins by legacy source or namespaced ProviderId without a central source switch', () => {
    expect(builtinProviderForSource('codex')?.manifest.providerId).toBe('swob/codex')
    expect(builtinProviderForId('swob/codex')?.sourceId).toBe('codex')
    expect(builtinProviderForId('example/sqlite-agent')).toBeUndefined()
    expect(currentProviderCapabilitySnapshot()).toHaveLength(11)
  })
})
