import { describe, expect, it } from 'vitest'
import {
  BUILTIN_PROVIDER_DEFINITIONS,
  LEGACY_SESSION_SOURCES,
  builtinProviderForId,
  builtinProviderForSource,
  currentProviderCapabilitySnapshot,
  providerCanParseTranscript,
  providerUsesCanonicalRuntime
} from './provider-capabilities'
import { validateProviderManifest } from './provider-protocol'

describe('current provider capability truth', () => {
  it('locks 11 native + 1 compatible and no detection-only sources', () => {
    expect(LEGACY_SESSION_SOURCES).toHaveLength(12)
    expect(BUILTIN_PROVIDER_DEFINITIONS.filter((entry) => entry.tier === 'native')).toHaveLength(11)
    expect(BUILTIN_PROVIDER_DEFINITIONS.filter((entry) => entry.tier === 'compatible')).toHaveLength(1)
    expect(BUILTIN_PROVIDER_DEFINITIONS.filter((entry) => entry.tier === 'detection-only')).toHaveLength(0)
    expect(new Set(BUILTIN_PROVIDER_DEFINITIONS.map((entry) => entry.manifest.providerId)).size).toBe(12)
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
      expect(capability.archive.status, definition.sourceId).toBe('unavailable')
      expect(definition.manifest.formatVersions, definition.sourceId).toEqual([])
    }
  })

  it('transcript-capable count comes from capabilities, not the source count', () => {
    expect(LEGACY_SESSION_SOURCES).toHaveLength(12)
    expect(LEGACY_SESSION_SOURCES.filter(providerCanParseTranscript)).toEqual([
      'claude-code', 'codex', 'cursor', 'opencode', 'zcode', 'cc-mirror',
      'antigravity', 'grok', 'pi', 'kimi', 'hermes', 'trae'
    ])
  })

  it('looks up built-ins by legacy source or namespaced ProviderId without a central source switch', () => {
    expect(builtinProviderForSource('codex')?.manifest.providerId).toBe('swob/codex')
    expect(builtinProviderForId('swob/codex')?.sourceId).toBe('codex')
    expect(builtinProviderForId('example/sqlite-agent')).toBeUndefined()
    expect(currentProviderCapabilitySnapshot()).toHaveLength(12)
    expect(providerUsesCanonicalRuntime('pi')).toBe(true)
    expect(providerUsesCanonicalRuntime('kimi')).toBe(true)
    expect(providerUsesCanonicalRuntime('grok')).toBe(true)
    expect(providerUsesCanonicalRuntime('antigravity')).toBe(true)
    expect(providerUsesCanonicalRuntime('hermes')).toBe(true)
    expect(providerUsesCanonicalRuntime('trae')).toBe(true)
    expect(providerUsesCanonicalRuntime('claude-code')).toBe(false)
  })
})
