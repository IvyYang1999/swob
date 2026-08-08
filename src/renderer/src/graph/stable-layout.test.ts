import { describe, expect, it } from 'vitest'
import {
  CachedPosition,
  CoordinateCache,
  computeNewNodePosition,
  hashString,
  nudgeNewNode
} from './stable-layout'

function buildCtx(
  nodes: Array<{ key: string; source: string; project: string; parentKey?: string }>
) {
  const cache: CoordinateCache = new Map()
  const nodeInfo = new Map<string, { source: string; project: string; parentKey?: string }>()
  for (const n of nodes) {
    nodeInfo.set(n.key, { source: n.source, project: n.project, parentKey: n.parentKey })
  }
  return { cache, nodeInfo }
}

function placeAll(
  nodes: Array<{ key: string; source: string; project: string; parentKey?: string }>
): Map<string, CachedPosition> {
  const ctx = buildCtx(nodes)
  const positions = new Map<string, CachedPosition>()
  for (const n of nodes) {
    const pos = computeNewNodePosition(n.key, ctx)
    ctx.cache.set(n.key, pos)
    positions.set(n.key, pos)
  }
  return positions
}

function dist(a: CachedPosition, b: CachedPosition): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2)
}

function centroid(positions: CachedPosition[]): CachedPosition {
  const sx = positions.reduce((s, p) => s + p.x, 0)
  const sy = positions.reduce((s, p) => s + p.y, 0)
  return { x: sx / positions.length, y: sy / positions.length }
}

function avgDistFromCentroid(positions: CachedPosition[]): number {
  const c = centroid(positions)
  return positions.reduce((s, p) => s + dist(p, c), 0) / positions.length
}

function generateNodes(
  source: string,
  project: string,
  count: number,
  prefix: string = ''
): Array<{ key: string; source: string; project: string }> {
  return Array.from({ length: count }, (_, i) => ({
    key: `${source}:${prefix}id-${i}:session-${i}`,
    source,
    project
  }))
}

describe('stable-layout cluster characteristics', () => {
  it('intra-cluster tightness: same-source nodes stay within radius ≤ 100', () => {
    const nodes = [
      ...generateNodes('claude-code', 'projA', 50, 'cc-'),
      ...generateNodes('codex', 'projB', 50, 'cx-')
    ]
    const positions = placeAll(nodes)

    const ccPositions = nodes
      .filter((n) => n.source === 'claude-code')
      .map((n) => positions.get(n.key)!)
    const cxPositions = nodes
      .filter((n) => n.source === 'codex')
      .map((n) => positions.get(n.key)!)

    const ccSpread = avgDistFromCentroid(ccPositions)
    const cxSpread = avgDistFromCentroid(cxPositions)

    expect(ccSpread).toBeLessThan(100)
    expect(cxSpread).toBeLessThan(100)
  })

  it('inter-cluster separation: different source centroids are well-separated', () => {
    const nodes = [
      ...generateNodes('claude-code', 'projA', 80, 'cc-'),
      ...generateNodes('codex', 'projB', 80, 'cx-'),
      ...generateNodes('cursor', 'projC', 80, 'cu-')
    ]
    const positions = placeAll(nodes)

    const groups = ['claude-code', 'codex', 'cursor'].map((src) => {
      const ps = nodes.filter((n) => n.source === src).map((n) => positions.get(n.key)!)
      return centroid(ps)
    })

    const d01 = dist(groups[0], groups[1])
    const d02 = dist(groups[0], groups[2])
    const d12 = dist(groups[1], groups[2])
    const minSep = Math.min(d01, d02, d12)

    const avgSpread = ['claude-code', 'codex', 'cursor']
      .map((src) => {
        const ps = nodes.filter((n) => n.source === src).map((n) => positions.get(n.key)!)
        return avgDistFromCentroid(ps)
      })
      .reduce((s, v) => s + v, 0) / 3

    expect(minSep).toBeGreaterThan(avgSpread * 0.5)
  })

  it('separation ratio: inter-cluster distance / intra-cluster spread > 1.0', () => {
    const nodes = [
      ...generateNodes('claude-code', 'projA', 100, 'cc-'),
      ...generateNodes('codex', 'projB', 100, 'cx-')
    ]
    const positions = placeAll(nodes)

    const ccPs = nodes.filter((n) => n.source === 'claude-code').map((n) => positions.get(n.key)!)
    const cxPs = nodes.filter((n) => n.source === 'codex').map((n) => positions.get(n.key)!)

    const interDist = dist(centroid(ccPs), centroid(cxPs))
    const maxSpread = Math.max(avgDistFromCentroid(ccPs), avgDistFromCentroid(cxPs))

    expect(interDist / maxSpread).toBeGreaterThan(1.0)
  })

  it('determinism: same input produces identical layout', () => {
    const nodes = [
      ...generateNodes('claude-code', 'projA', 30, 'cc-'),
      ...generateNodes('codex', 'projB', 30, 'cx-')
    ]

    const pos1 = placeAll(nodes)
    const pos2 = placeAll(nodes)

    for (const n of nodes) {
      const p1 = pos1.get(n.key)!
      const p2 = pos2.get(n.key)!
      expect(p1.x).toBe(p2.x)
      expect(p1.y).toBe(p2.y)
    }
  })

  it('large graph (1000 nodes): cluster tightness holds and placement is fast', () => {
    const nodes = [
      ...generateNodes('claude-code', 'projA', 300, 'cc-'),
      ...generateNodes('codex', 'projB', 300, 'cx-'),
      ...generateNodes('zcode', 'projC', 200, 'zc-'),
      ...generateNodes('cursor', 'projD', 200, 'cu-')
    ]

    const t0 = performance.now()
    const positions = placeAll(nodes)
    const elapsed = performance.now() - t0

    expect(elapsed).toBeLessThan(2000)

    for (const src of ['claude-code', 'codex', 'zcode', 'cursor']) {
      const ps = nodes.filter((n) => n.source === src).map((n) => positions.get(n.key)!)
      const spread = avgDistFromCentroid(ps)
      expect(spread).toBeLessThan(100)
    }
  })

  it('source+project isolation: same project different source stays separated', () => {
    const nodes = [
      ...generateNodes('claude-code', 'shared-proj', 40, 'cc-'),
      ...generateNodes('codex', 'shared-proj', 40, 'cx-')
    ]
    const positions = placeAll(nodes)

    const ccPs = nodes.filter((n) => n.source === 'claude-code').map((n) => positions.get(n.key)!)
    const cxPs = nodes.filter((n) => n.source === 'codex').map((n) => positions.get(n.key)!)

    const interDist = dist(centroid(ccPs), centroid(cxPs))
    expect(interDist).toBeGreaterThan(10)
  })
})

describe('nudgeNewNode', () => {
  it('moves away from collisions', () => {
    const pos = { x: 0, y: 0 }
    const existing = [{ x: 3, y: 0 }]
    const nudged = nudgeNewNode(pos, existing, 8)
    expect(nudged.x).toBeLessThan(0)
  })

  it('does not move when no collisions', () => {
    const pos = { x: 0, y: 0 }
    const existing = [{ x: 100, y: 100 }]
    const nudged = nudgeNewNode(pos, existing, 8)
    expect(nudged.x).toBe(0)
    expect(nudged.y).toBe(0)
  })
})
