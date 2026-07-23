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

interface PlacementContext {
  /** Existing coordinate cache (already-placed nodes). */
  cache: CoordinateCache
  /** All nodes keyed by stable key, with source / project info. */
  nodeInfo: Map<string, { source: string; project: string; parentKey?: string }>
}

// ---------------------------------------------------------------------------
// Source / project statistics for two-level sector layout
// ---------------------------------------------------------------------------

interface SourceStats {
  /** Total node count per source */
  sourceCounts: Map<string, number>
  /** Sorted list of unique sources (deterministic order) */
  sources: string[]
  /** Sorted list of unique projects per source */
  projectsBySource: Map<string, string[]>
  /** Total node count across all sources */
  totalCount: number
}

function computeSourceStats(
  nodeInfo: PlacementContext['nodeInfo']
): SourceStats {
  const sourceCounts = new Map<string, number>()
  const projectSets = new Map<string, Set<string>>()

  for (const [, info] of nodeInfo) {
    const src = info.source
    const proj = info.project
    sourceCounts.set(src, (sourceCounts.get(src) || 0) + 1)
    if (!projectSets.has(src)) projectSets.set(src, new Set())
    projectSets.get(src)!.add(proj)
  }

  const sources = [...sourceCounts.keys()].sort()
  const projectsBySource = new Map<string, string[]>()
  for (const [src, projSet] of projectSets) {
    projectsBySource.set(src, [...projSet].sort())
  }

  return {
    sourceCounts,
    sources,
    projectsBySource,
    totalCount: nodeInfo.size
  }
}

interface SectorInfo {
  /** Center angle of this source's sector */
  sourceAngle: number
  /** Angular width of source sector */
  sourceSectorWidth: number
  /** Offset angle within source sector for this project sub-cluster */
  projectSubAngle: number
}

function computeSectorInfo(
  stats: SourceStats,
  source: string,
  project: string
): SectorInfo {
  const { sources, sourceCounts, projectsBySource, totalCount } = stats

  // Source sectors: angular width proportional to node count
  let angleOffset = 0
  let sourceAngle = 0
  let sourceSectorWidth = Math.PI * 2 / Math.max(1, sources.length)

  const total = Math.max(1, totalCount)
  for (const src of sources) {
    const count = sourceCounts.get(src) || 1
    const sectorWidth = (count / total) * Math.PI * 2
    if (src === source) {
      sourceAngle = angleOffset + sectorWidth / 2
      sourceSectorWidth = sectorWidth
      break
    }
    angleOffset += sectorWidth
  }

  // Project sub-sectors within the source sector
  const projects = projectsBySource.get(source) || [project]
  const projIdx = projects.indexOf(project)
  const projCount = projects.length
  let projectSubAngle = 0
  if (projCount > 1 && projIdx >= 0) {
    const step = sourceSectorWidth / projCount
    projectSubAngle = -sourceSectorWidth / 2 + step * projIdx + step / 2
  }

  return { sourceAngle, sourceSectorWidth, projectSubAngle }
}

/** Radius scales dynamically with source node count instead of fixed 15..50 */
function dynamicRadius(h: number, sourceNodeCount: number): number {
  const base = Math.max(8, Math.sqrt(sourceNodeCount) * 6)
  const jitter = ((h >>> 16) / 0xffff) * base * 0.5
  return base + jitter
}

/** Cluster center distance from origin, based on expected cluster size */
function clusterRadius(sourceNodeCount: number): number {
  return Math.max(30, Math.sqrt(sourceNodeCount) * 12)
}

/**
 * Compute a deterministic position for a new node.
 *
 * Two-level sector layout:
 *   Level 1 — sources get angular sectors proportional to their node count
 *   Level 2 — projects within a source get sub-sectors within the source range
 *
 * Priority:
 * 1. Has lineage parent in cache → near parent, angle from hash(newKey)
 * 2. Same source+project composite cluster has nodes in cache → near cluster centroid
 * 3. Same source has nodes in cache → near source centroid, offset toward project sub-sector
 * 4. Fallback → two-level sector coordinates from source + project stats
 */
export function computeNewNodePosition(
  key: string,
  ctx: PlacementContext
): CachedPosition {
  const info = ctx.nodeInfo.get(key)
  const source = info?.source || 'claude-code'
  const project = info?.project || ''
  const h = hashString(key)

  // Deterministic angle from hash
  const hAngle = ((h & 0xffff) / 0xffff) * Math.PI * 2

  // Source/project statistics for sector allocation
  const stats = computeSourceStats(ctx.nodeInfo)
  const sector = computeSectorInfo(stats, source, project)
  const sourceCount = stats.sourceCounts.get(source) || 1
  const hRadius = dynamicRadius(h, sourceCount)

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

  // 2. Near composite cluster centroid (source + project)
  if (project) {
    const clusterPositions = collectGroupPositions(
      ctx,
      (_k, n) => n.source === source && n.project === project
    )
    if (clusterPositions.length > 0) {
      const centroid = computeCentroid(clusterPositions)
      // For large sub-clusters, spread using project sub-angle
      const spread = clusterPositions.length > 100
        ? hAngle + sector.projectSubAngle * 0.3
        : hAngle
      return {
        x: centroid.x + Math.cos(spread) * hRadius,
        y: centroid.y + Math.sin(spread) * hRadius
      }
    }
  }

  // 3. Near source centroid, offset toward project sub-sector
  const sourcePositions = collectGroupPositions(ctx, (_k, n) => n.source === source)
  if (sourcePositions.length > 0) {
    const centroid = computeCentroid(sourcePositions)
    const subAngle = sector.projectSubAngle
    return {
      x: centroid.x + Math.cos(subAngle + hAngle * 0.3) * hRadius,
      y: centroid.y + Math.sin(subAngle + hAngle * 0.3) * hRadius
    }
  }

  // 4. Fallback — two-level sector placement
  const totalAngle = sector.sourceAngle + sector.projectSubAngle
  const r = clusterRadius(sourceCount) + hRadius * 0.5
  return {
    x: Math.cos(totalAngle + hAngle * 0.2) * r,
    y: Math.sin(totalAngle + hAngle * 0.2) * r
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
