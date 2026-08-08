/**
 * Deterministic, identity-stable graph layout utilities.
 *
 * Design goals:
 * - No Math.random() anywhere — all placement is deterministic via FNV-1a hash
 * - Coordinate cache is the single source of truth for node positions
 * - Three revision types: presentation (redraw only), membership (incremental),
 *   topology (edge-only update)
 */

// ---------------------------------------------------------------------------
// Hash
// ---------------------------------------------------------------------------

/** FNV-1a 32-bit hash — deterministic, fast, good distribution. */
export function hashString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

// ---------------------------------------------------------------------------
// Stable session key
// ---------------------------------------------------------------------------

/** Canonical identity key for a session node — order-independent. */
export function stableSessionKey(
  source: string,
  id: string,
  sessionId: string
): string {
  return `${source}:${id}:${sessionId}`
}

// ---------------------------------------------------------------------------
// Membership key — changes only when nodes are added / removed
// ---------------------------------------------------------------------------

export interface MembershipSession {
  id: string
  sessionId: string
  source: string
}

/** Membership key: identity-only, sorted, no presentation data. */
export function computeMembershipKey(sessions: MembershipSession[]): string {
  return sessions
    .map((s) => stableSessionKey(s.source || 'claude-code', s.id, s.sessionId))
    .sort()
    .join('\0')
}

// ---------------------------------------------------------------------------
// Coordinate cache
// ---------------------------------------------------------------------------

export interface CachedPosition {
  x: number
  y: number
}

export type CoordinateCache = Map<string, CachedPosition>

// ---------------------------------------------------------------------------
// Deterministic new-node placement
// ---------------------------------------------------------------------------

const SOURCE_ORDER = ['claude-code', 'codex', 'cursor', 'opencode', 'zcode']

interface PlacementContext {
  /** Existing coordinate cache (already-placed nodes). */
  cache: CoordinateCache
  /** All nodes keyed by stable key, with source / project info. */
  nodeInfo: Map<string, { source: string; project: string; parentKey?: string }>
}

/**
 * Compute a deterministic position for a new node.
 *
 * Priority:
 * 1. Has lineage parent in cache → near parent, angle from hash(newKey)
 * 2. Same source+project cluster has nodes in cache → near cluster centroid
 * 3. Same source has nodes in cache → near source centroid
 * 4. Fallback → fixed sector angle from SOURCE_ORDER + hash jitter
 *
 * Tight fixed radius (15..50) ensures dense intra-cluster packing.
 * Fixed SOURCE_ORDER sectors guarantee stable inter-cluster separation.
 */
export function computeNewNodePosition(
  key: string,
  ctx: PlacementContext
): CachedPosition {
  const info = ctx.nodeInfo.get(key)
  const source = info?.source || 'claude-code'
  const project = info?.project || ''
  const h = hashString(key)

  const hAngle = ((h & 0xffff) / 0xffff) * Math.PI * 2
  const hRadius = 15 + ((h >>> 16) / 0xffff) * 35 // 15..50

  // 1. Near lineage parent
  if (info?.parentKey) {
    const parentPos = ctx.cache.get(info.parentKey)
    if (parentPos) {
      return {
        x: parentPos.x + Math.cos(hAngle) * hRadius,
        y: parentPos.y + Math.sin(hAngle) * hRadius
      }
    }
  }

  // 2. Near source+project cluster centroid (don't mix sources in same cluster)
  if (project) {
    const clusterPositions = collectGroupPositions(
      ctx,
      (_k, n) => n.source === source && n.project === project
    )
    if (clusterPositions.length > 0) {
      const centroid = computeCentroid(clusterPositions)
      return {
        x: centroid.x + Math.cos(hAngle) * hRadius,
        y: centroid.y + Math.sin(hAngle) * hRadius
      }
    }
  }

  // 3. Near source centroid
  const sourcePositions = collectGroupPositions(ctx, (_k, n) => n.source === source)
  if (sourcePositions.length > 0) {
    const centroid = computeCentroid(sourcePositions)
    return {
      x: centroid.x + Math.cos(hAngle) * hRadius,
      y: centroid.y + Math.sin(hAngle) * hRadius
    }
  }

  // 4. Fallback — fixed sector from SOURCE_ORDER + hash jitter
  const srcIdx = SOURCE_ORDER.indexOf(source)
  const sectorAngle =
    srcIdx >= 0
      ? (srcIdx / SOURCE_ORDER.length) * Math.PI * 2
      : ((h % 1000) / 1000) * Math.PI * 2
  const r = 20 + ((h >>> 8) / 0xffffff) * 60
  return {
    x: Math.cos(sectorAngle + hAngle * 0.3) * r,
    y: Math.sin(sectorAngle + hAngle * 0.3) * r
  }
}

function collectGroupPositions(
  ctx: PlacementContext,
  predicate: (key: string, info: { source: string; project: string }) => boolean
): CachedPosition[] {
  const result: CachedPosition[] = []
  for (const [k, info] of ctx.nodeInfo) {
    if (predicate(k, info)) {
      const pos = ctx.cache.get(k)
      if (pos) result.push(pos)
    }
  }
  return result
}

function computeCentroid(positions: CachedPosition[]): CachedPosition {
  let sx = 0
  let sy = 0
  for (const p of positions) {
    sx += p.x
    sy += p.y
  }
  return { x: sx / positions.length, y: sy / positions.length }
}

// ---------------------------------------------------------------------------
// Deterministic simulation (replaces Math.random sampling)
// ---------------------------------------------------------------------------

/**
 * Deterministic repulsion sampling: instead of Math.random() for indices,
 * use a hash-stepped walk through the node array.
 */
export function deterministicSampleIndex(
  nodeIndex: number,
  sampleOrd: number,
  nodeCount: number
): number {
  // For the first 10 samples, use sequential neighbors (same as original)
  if (sampleOrd < 10) {
    return (nodeIndex + sampleOrd + 1) % nodeCount
  }
  // Beyond that, use a hash-based stride instead of Math.random()
  const h = hashString(`${nodeIndex}:${sampleOrd}`)
  return h % nodeCount
}

// ---------------------------------------------------------------------------
// Collision nudge for new nodes only
// ---------------------------------------------------------------------------

/**
 * Nudge a single new node away from nearby existing nodes.
 * Does NOT move any existing nodes — only adjusts the new node's position.
 */
export function nudgeNewNode(
  pos: CachedPosition,
  existingPositions: CachedPosition[],
  minDist: number = 8
): CachedPosition {
  let { x, y } = pos
  for (let iter = 0; iter < 5; iter++) {
    let fx = 0
    let fy = 0
    let collisions = 0
    for (const other of existingPositions) {
      const dx = x - other.x
      const dy = y - other.y
      const dist = Math.sqrt(dx * dx + dy * dy) + 0.1
      if (dist < minDist) {
        fx += (dx / dist) * (minDist - dist)
        fy += (dy / dist) * (minDist - dist)
        collisions++
      }
    }
    if (collisions === 0) break
    x += fx
    y += fy
  }
  return { x, y }
}
