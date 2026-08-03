import { describe, it, expect } from 'vitest'
import {
  BUILTIN_LENSES,
  getEnabledLenses,
  isLensEnabled,
  lensIdsForScene,
  preferencesForLensPreset
} from './lens-registry'

describe('lens-registry', () => {
  describe('BUILTIN_LENSES', () => {
    it('has 7 built-in lenses', () => {
      expect(BUILTIN_LENSES).toHaveLength(7)
    })

    it('all lenses have builtIn: true', () => {
      for (const lens of BUILTIN_LENSES) {
        expect(lens.builtIn).toBe(true)
      }
    })

    it('all lenses have unique ids', () => {
      const ids = BUILTIN_LENSES.map((l) => l.id)
      expect(new Set(ids).size).toBe(ids.length)
    })

    it('all lenses have bilingual name and description', () => {
      for (const lens of BUILTIN_LENSES) {
        expect(lens.name['zh-CN']).toBeTruthy()
        expect(lens.name.en).toBeTruthy()
        expect(lens.description['zh-CN']).toBeTruthy()
        expect(lens.description.en).toBeTruthy()
      }
    })
  })

  describe('isLensEnabled', () => {
    it('returns true when enabledLenses is null (backwards compat)', () => {
      expect(isLensEnabled('highlights', { enabledLenses: null })).toBe(true)
      expect(isLensEnabled('galaxy', { enabledLenses: null })).toBe(true)
    })

    it('returns true when enabledLenses is undefined', () => {
      expect(isLensEnabled('highlights', {})).toBe(true)
    })

    it('returns true when lens is in enabledLenses', () => {
      expect(isLensEnabled('highlights', { enabledLenses: ['highlights', 'galaxy'] })).toBe(true)
    })

    it('returns false when lens is not in enabledLenses', () => {
      expect(isLensEnabled('audit', { enabledLenses: ['highlights'] })).toBe(false)
    })
  })

  describe('getEnabledLenses', () => {
    it('returns all lenses when enabledLenses is null', () => {
      const result = getEnabledLenses({ enabledLenses: null })
      expect(result).toHaveLength(7)
    })

    it('returns all lenses when enabledLenses is undefined', () => {
      const result = getEnabledLenses({})
      expect(result).toHaveLength(7)
    })

    it('filters by enabledLenses', () => {
      const result = getEnabledLenses({ enabledLenses: ['highlights', 'galaxy'] })
      expect(result).toHaveLength(2)
      expect(result.map((l) => l.id)).toEqual(['highlights', 'galaxy'])
    })

    it('respects custom lensOrder', () => {
      const result = getEnabledLenses({
        enabledLenses: null,
        lensOrder: ['galaxy', 'highlights', 'audit', 'outputs', 'image-index', 'token-insights', 'share-templates']
      })
      expect(result[0].id).toBe('galaxy')
      expect(result[1].id).toBe('highlights')
      expect(result[2].id).toBe('audit')
    })

    it('puts unordered lenses at the end', () => {
      const result = getEnabledLenses({
        enabledLenses: null,
        lensOrder: ['galaxy']
      })
      expect(result[0].id).toBe('galaxy')
      // Others follow in original order after the ordered ones
      expect(result.length).toBe(7)
    })
  })

  describe('lensIdsForScene', () => {
    it('returns knowledge scene lenses', () => {
      const ids = lensIdsForScene('knowledge')
      expect(ids).toContain('highlights')
      expect(ids).toContain('image-index')
      expect(ids).toContain('share-templates')
      expect(ids).not.toContain('galaxy')
      expect(ids).not.toContain('token-insights')
    })

    it('returns developer scene lenses', () => {
      const ids = lensIdsForScene('developer')
      expect(ids).toContain('outputs')
      expect(ids).toContain('token-insights')
      expect(ids).toContain('galaxy')
      expect(ids).toContain('audit')
      expect(ids).toContain('share-templates')
      expect(ids).not.toContain('highlights')
    })

    it('returns all lenses for "both"', () => {
      const ids = lensIdsForScene('both')
      expect(ids).toHaveLength(7)
    })
  })

  describe('preferencesForLensPreset', () => {
    it('projects a validated preset into existing preference fields', () => {
      expect(preferencesForLensPreset({
        schemaVersion: 1,
        label: { 'zh-CN': '研究', en: 'Research' },
        enabledLenses: ['highlights', 'share-templates'],
        order: ['share-templates', 'highlights', 'image-index', 'outputs', 'token-insights', 'galaxy', 'audit'],
        sceneTags: ['knowledge']
      })).toEqual({
        enabledLenses: ['highlights', 'share-templates'],
        lensOrder: ['share-templates', 'highlights', 'image-index', 'outputs', 'token-insights', 'galaxy', 'audit']
      })
    })
  })
})
