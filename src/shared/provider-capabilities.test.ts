import { describe, expect, it } from 'vitest'
import {
  BUILTIN_PROVIDER_DEFINITIONS,
  LEGACY_SESSION_SOURCES,
  VALUATION_CAPABILITIES,
  builtinProviderForId,
  builtinProviderForSource,
  currentProviderCapabilitySnapshot,
  providerCanParseTranscript,
  providerUsesCanonicalRuntime,
  valuationCapabilityForSource
} from './provider-capabilities'
import { validateProviderManifest } from './provider-protocol'

describe('current provider capability truth', () => {
  it('locks 13 native + 1 compatible and no detection-only sources', () => {
    expect(LEGACY_SESSION_SOURCES).toHaveLength(14)
    expect(BUILTIN_PROVIDER_DEFINITIONS.filter((entry) => entry.tier === 'native')).toHaveLength(13)
    expect(BUILTIN_PROVIDER_DEFINITIONS.filter((entry) => entry.tier === 'compatible')).toHaveLength(1)
    expect(BUILTIN_PROVIDER_DEFINITIONS.filter((entry) => entry.tier === 'detection-only')).toHaveLength(0)
    expect(new Set(BUILTIN_PROVIDER_DEFINITIONS.map((entry) => entry.manifest.providerId)).size).toBe(14)
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
    expect(LEGACY_SESSION_SOURCES).toHaveLength(14)
    expect(LEGACY_SESSION_SOURCES.filter(providerCanParseTranscript)).toEqual([
      'claude-code', 'codex', 'cursor', 'opencode', 'zcode', 'cc-mirror',
      'antigravity', 'grok', 'pi', 'kimi', 'hermes', 'qoder', 'trae', 'gemini'
    ])
  })

  it('looks up built-ins by legacy source or namespaced ProviderId without a central source switch', () => {
    expect(builtinProviderForSource('codex')?.manifest.providerId).toBe('swob/codex')
    expect(builtinProviderForId('swob/codex')?.sourceId).toBe('codex')
    expect(builtinProviderForId('example/sqlite-agent')).toBeUndefined()
    expect(currentProviderCapabilitySnapshot()).toHaveLength(14)
    expect(providerUsesCanonicalRuntime('pi')).toBe(true)
    expect(providerUsesCanonicalRuntime('kimi')).toBe(true)
    expect(providerUsesCanonicalRuntime('grok')).toBe(true)
    expect(providerUsesCanonicalRuntime('antigravity')).toBe(true)
    expect(providerUsesCanonicalRuntime('hermes')).toBe(true)
    expect(providerUsesCanonicalRuntime('qoder')).toBe(true)
    expect(providerUsesCanonicalRuntime('trae')).toBe(true)
    expect(providerUsesCanonicalRuntime('gemini')).toBe(true)
    expect(providerUsesCanonicalRuntime('claude-code')).toBe(false)
  })

  it('declares one honest valuation capability for all 14 sources', () => {
    expect(Object.keys(VALUATION_CAPABILITIES)).toEqual([...LEGACY_SESSION_SOURCES])
    expect(BUILTIN_PROVIDER_DEFINITIONS.map((entry) => [entry.sourceId, entry.valuation.status])).toEqual([
      ['claude-code', 'billable-exact'],
      ['codex', 'billable-exact'],
      ['cursor', 'unavailable'],
      ['opencode', 'billable-exact'],
      ['zcode', 'billable-exact'],
      ['cc-mirror', 'billable-exact'],
      ['antigravity', 'estimate-only'],
      ['grok', 'billable-exact'],
      ['pi', 'billable-exact'],
      ['kimi', 'estimate-only'],
      ['hermes', 'estimate-only'],
      ['qoder', 'estimate-only'],
      ['trae', 'unavailable'],
      ['gemini', 'estimate-only']
    ])
    for (const definition of BUILTIN_PROVIDER_DEFINITIONS) {
      expect(definition.valuation.reason.length, definition.sourceId).toBeGreaterThan(20)
      expect(definition.valuation.evidence.length, definition.sourceId).toBeGreaterThan(0)
      if (definition.valuation.status === 'billable-exact') {
        expect(definition.valuation.evidence.some((entry) =>
          entry.kind === 'test' &&
          entry.locator === `testdata/valuation/per-call-pricing-evidence.json#${definition.sourceId}` &&
          entry.note?.includes('Per-call pricing evidence fixture')
        ), definition.sourceId).toBe(true)
      }
    }
    expect(valuationCapabilityForSource('future-source')).toMatchObject({
      status: 'unavailable',
      evidence: []
    })
    expect(currentProviderCapabilitySnapshot()[0].valuation).toBe(VALUATION_CAPABILITIES['claude-code'])
  })

  it('keeps Antigravity terminal Resume explicitly experimental until post-launch anchors are observed', () => {
    const resume = builtinProviderForSource('antigravity')?.manifest.capabilities['terminal-resume']
    expect(resume?.status).toBe('experimental')
    expect(resume?.reason).toContain('post-launch source/message anchor')
    expect(resume?.reason).not.toContain('This machine')
  })
})
