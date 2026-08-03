import { describe, expect, it } from 'vitest'
import { SWOB_PLUGIN_EXECUTION_ENABLED } from './registry/plugin-manifest'
import {
  compareSwobLensVersions,
  validateSwobLensDeclaration,
  validateSwobLensManifest
} from './swoblens-validator'

const manifest = {
  schemaVersion: 1,
  id: 'org.example.theme',
  name: { 'zh-CN': '示例', en: 'Example' },
  version: '1.2.3',
  type: 'theme',
  author: 'Example',
  minSwobVersion: '1.3.1',
  declaration: 'theme.json',
  files: [{ path: 'theme.json', sha256: 'a'.repeat(64), bytes: 42 }]
}

describe('.swoblens schema v1', () => {
  it('accepts a minimal manifest without any executable entry field', () => {
    expect(validateSwobLensManifest(manifest)).toMatchObject({
      id: 'org.example.theme',
      type: 'theme',
      declaration: 'theme.json'
    })
    expect(SWOB_PLUGIN_EXECUTION_ENABLED).toBe(false)
  })

  it('fails closed on unknown fields', () => {
    expect(() => validateSwobLensManifest({ ...manifest, entry: 'payload.js' })).toThrow(/unknown field: entry/)
    expect(() => validateSwobLensManifest({ ...manifest, permissions: [] })).toThrow(/unknown field: permissions/)
  })

  it('allows only whitelisted theme tokens and literal hex colors', () => {
    expect(validateSwobLensDeclaration('theme', {
      schemaVersion: 1,
      label: { 'zh-CN': '安全主题', en: 'Safe theme' },
      mode: 'both',
      tokens: { base: '#111111', surface: '#222222', primary: '#eeeeee', accent: '#8888ff' }
    })).toMatchObject({ mode: 'both' })
    expect(() => validateSwobLensDeclaration('theme', {
      schemaVersion: 1,
      label: { 'zh-CN': '网络主题', en: 'Network theme' },
      mode: 'both',
      tokens: { base: 'url(https://example.com/x)', surface: '#222222', primary: '#eeeeee', accent: '#8888ff' }
    })).toThrow(/six- or eight-digit hex color/)
    expect(() => validateSwobLensDeclaration('theme', {
      schemaVersion: 1,
      label: { 'zh-CN': '注入主题', en: 'Injected theme' },
      mode: 'both',
      tokens: { base: '#111111', surface: '#222222', primary: '#eeeeee', arbitrary: '#8888ff' }
    })).toThrow(/not allowed/)
  })

  it('requires a complete, unique ordering for Lens presets', () => {
    expect(() => validateSwobLensDeclaration('lens-preset', {
      schemaVersion: 1,
      label: { 'zh-CN': '不完整', en: 'Incomplete' },
      enabledLenses: ['highlights'],
      order: ['highlights'],
      sceneTags: ['knowledge']
    })).toThrow(/must list every built-in Lens/)
  })

  it('restricts share templates to layout enums, plain copy, and color references', () => {
    const base = {
      schemaVersion: 1,
      label: { 'zh-CN': '卡片', en: 'Card' },
      layout: 'compact',
      watermark: 'via Swob',
      colors: {
        bg: 'base', cardBg: 'surface', text: 'primary', textSecondary: 'secondary',
        textMuted: 'muted', userAccent: 'soft-blue', assistantAccent: 'soft-orange', border: 'edge'
      }
    }
    expect(validateSwobLensDeclaration('share-template', base)).toMatchObject({ layout: 'compact' })
    expect(() => validateSwobLensDeclaration('share-template', {
      ...base,
      colors: { ...base.colors, bg: 'url(https://example.com)' }
    })).toThrow(/unsupported/)
    expect(() => validateSwobLensDeclaration('share-template', { ...base, watermark: '<script>' })).toThrow(/plain text/)
  })

  it('compares stable and prerelease SemVer values', () => {
    expect(compareSwobLensVersions('1.4.0', '1.3.9')).toBeGreaterThan(0)
    expect(compareSwobLensVersions('1.4.0-beta.2', '1.4.0-beta.1')).toBeGreaterThan(0)
    expect(compareSwobLensVersions('1.4.0-beta.1', '1.4.0')).toBeLessThan(0)
  })
})
