import { afterEach, describe, expect, it } from 'vitest'
import type { InstalledSwobLensPackage } from '../../../../shared/swoblens-manifest'
import { SHARE_THEMES, getThemeById, replaceDeclarativeShareThemes } from './share-themes'

afterEach(() => replaceDeclarativeShareThemes([], 'en'))

describe('SHARE_THEMES', () => {
  it('has exactly three themes', () => {
    expect(SHARE_THEMES).toHaveLength(3)
  })

  it('includes light, dark, and minimal', () => {
    const ids = SHARE_THEMES.map((t) => t.id)
    expect(ids).toContain('light')
    expect(ids).toContain('dark')
    expect(ids).toContain('minimal')
  })

  it('each theme has all required CSS variable keys', () => {
    const requiredKeys = [
      'bg', 'cardBg', 'text', 'textSecondary', 'textMuted',
      'userAccent', 'assistantAccent', 'border', 'watermark', 'roleBg',
    ]
    for (const theme of SHARE_THEMES) {
      for (const key of requiredKeys) {
        expect(theme.vars).toHaveProperty(key)
        expect(typeof theme.vars[key as keyof typeof theme.vars]).toBe('string')
        expect(theme.vars[key as keyof typeof theme.vars].length).toBeGreaterThan(0)
      }
    }
  })

  it('each theme has a non-empty label', () => {
    for (const theme of SHARE_THEMES) {
      expect(theme.label.length).toBeGreaterThan(0)
    }
  })
})

describe('declarative share templates', () => {
  it('adds only enabled, main-process-validated templates and resolves color references', () => {
    const installed = {
      enabled: true,
      digest: 'a'.repeat(64),
      installedAt: '2026-08-03T00:00:00.000Z',
      manifest: {
        schemaVersion: 1,
        id: 'org.example.field-notes',
        name: { 'zh-CN': '田野笔记', en: 'Field Notes' },
        version: '1.0.0',
        type: 'share-template',
        author: 'Example',
        minSwobVersion: '1.3.1',
        declaration: 'share-template.json',
        files: [{ path: 'share-template.json', sha256: 'b'.repeat(64), bytes: 1 }]
      },
      declaration: {
        schemaVersion: 1,
        label: { 'zh-CN': '田野笔记', en: 'Field Notes' },
        layout: 'compact',
        watermark: 'Captured with Swob',
        colors: {
          bg: 'base', cardBg: 'surface', text: 'primary', textSecondary: 'secondary',
          textMuted: 'muted', userAccent: 'soft-blue', assistantAccent: 'soft-orange', border: 'edge'
        }
      }
    } satisfies InstalledSwobLensPackage
    replaceDeclarativeShareThemes([installed], 'en')
    expect(SHARE_THEMES).toHaveLength(4)
    expect(getThemeById('swoblens:org.example.field-notes')).toMatchObject({
      label: 'Field Notes',
      layout: 'compact',
      watermark: 'Captured with Swob',
      vars: { bg: 'var(--color-base)', userAccent: 'var(--color-soft-blue)' }
    })
  })
})

describe('getThemeById', () => {
  it('returns the correct theme by id', () => {
    expect(getThemeById('light').id).toBe('light')
    expect(getThemeById('dark').id).toBe('dark')
    expect(getThemeById('minimal').id).toBe('minimal')
  })

  it('returns light theme as fallback for unknown id', () => {
    const result = getThemeById('nonexistent')
    expect(result.id).toBe('light')
  })

  it('returns light theme for empty string', () => {
    const result = getThemeById('')
    expect(result.id).toBe('light')
  })
})
