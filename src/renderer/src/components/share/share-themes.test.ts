import { describe, expect, it } from 'vitest'
import { SHARE_THEMES, getThemeById } from './share-themes'

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
