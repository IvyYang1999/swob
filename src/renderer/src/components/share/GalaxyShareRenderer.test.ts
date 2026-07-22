import { describe, it, expect } from 'vitest'
import type { GalaxyNode, GalaxyShareOptions } from './GalaxyShareRenderer'

// Note: renderGalaxyShareImage relies on DOM APIs (document.createElement, Canvas, Image)
// and cannot run in a pure Node environment. We test the type contracts and option shapes here;
// the renderer itself is verified via the type check and manual/E2E testing.

describe('GalaxyShareRenderer types', () => {
  it('GalaxyNode satisfies the interface shape', () => {
    const node: GalaxyNode = {
      x: 10,
      y: 20,
      source: 'claude-code',
      turnCount: 15,
      recency: 0.8,
      totalTokens: 50000,
      compactCount: 1,
    }
    expect(node.source).toBe('claude-code')
    expect(node.turnCount).toBe(15)
    expect(node.recency).toBe(0.8)
  })

  it('GalaxyShareOptions satisfies the interface shape', () => {
    const options: GalaxyShareOptions = {
      nodes: [
        { x: 0, y: 0, source: 'codex', turnCount: 5, recency: 0.5, totalTokens: 10000, compactCount: 0 },
      ],
      sourceColors: { codex: '#3b82f6' },
      sourceLabels: { codex: 'Codex' },
      locale: 'en',
      isDark: true,
    }
    expect(options.nodes).toHaveLength(1)
    expect(options.isDark).toBe(true)
    expect(options.locale).toBe('en')
  })

  it('accepts zh-CN locale', () => {
    const options: GalaxyShareOptions = {
      nodes: [],
      sourceColors: {},
      sourceLabels: {},
      locale: 'zh-CN',
      isDark: false,
    }
    expect(options.locale).toBe('zh-CN')
  })

  it('GalaxyNode handles edge values', () => {
    const node: GalaxyNode = {
      x: -999,
      y: 999,
      source: 'unknown-tool',
      turnCount: 0,
      recency: 0,
      totalTokens: 0,
      compactCount: 0,
    }
    expect(node.turnCount).toBe(0)
    expect(node.recency).toBe(0)
  })
})
