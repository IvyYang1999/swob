import { translate } from '../i18n'
import { useEffect, useRef, useCallback, useMemo, useState } from 'react'
import { useStore } from '../store'
import { GitBranch, RotateCcw, Share2, Compass, Settings } from 'lucide-react'
import { GalaxySharePreview } from './share/GalaxySharePreview'
import {
  hashString,
  stableSessionKey,
  computeMembershipKey,
  computeNewNodePosition,
  nudgeNewNode,
  deterministicSampleIndex,
  type CoordinateCache,
  type CachedPosition
} from '../graph/stable-layout'

const SOURCE_COLORS: Record<string, string> = {
  'claude-code': '#f59e0b',
  codex: '#3b82f6',
  cursor: '#22c55e',
  opencode: '#06b6d4',
  zcode: '#ef4444',
  qoder: '#06b6d4',
  trae: '#c084fc'
}

const SOURCE_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  zcode: 'Zcode',
  qoder: 'Qoder',
  trae: 'Trae'
}

const SOURCE_ORDER = ['claude-code', 'codex', 'cursor', 'opencode', 'zcode', 'qoder', 'trae']

interface Node {
  id: string
  stableKey: string
  x: number
  y: number
  vx: number
  vy: number
  source: string
  project: string
  title: string
  turnCount: number
  totalTokens: number
  compactCount: number
  createdAt: number
  recency: number // 0..1, 1 = today
  cwds: string[]
  fileKeys: string[]
}

interface Edge {
  from: number
  to: number
  type: string // lineage | continuation | project | source | time | cwd | files
}

export interface LineageGraphSession {
  sessionId: string
  id: string
  source: string
  projectPath?: string
  firstUserMessage?: string
  turnCount: number
  createdAt: string
  tokenUsage?: { totalTokens: number }
  compactCount: number
  successor?: string
  cwds?: string[]
  referencedFiles?: Array<{ path: string }>
}

const LAYOUT_DEBOUNCE_MS = 500

// Re-export for backward compatibility with tests
export { computeMembershipKey }

/**
 * Legacy fingerprint — DEPRECATED, kept only for test compatibility.
 * The new architecture uses computeMembershipKey for layout invalidation
 * and a separate presentation-only update path.
 */
export function lineageGraphFingerprint(sessions: LineageGraphSession[]): string {
  return computeMembershipKey(sessions)
}

function dayKey(ts: number): number {
  return Math.floor(ts / 86400000)
}

/**
 * Build graph with coordinate cache: reuses old positions for existing nodes,
 * computes deterministic positions for new nodes, and sorts by stable key
 * for input-order independence.
 */
function buildGraph(
  sessions: LineageGraphSession[],
  registry: { relations: Array<{ parent: string; child: string; type: string }> } | null,
  coordCache: CoordinateCache
) {
  const now = Date.now()

  // Build a parent lookup from registry for deterministic placement
  const parentOf = new Map<string, string>()
  if (registry) {
    for (const r of registry.relations) {
      parentOf.set(r.child, r.parent)
    }
  }

  // Sort sessions by stable key for input-order independence
  const sorted = [...sessions].sort((a, b) => {
    const ka = stableSessionKey(a.source || 'claude-code', a.id, a.sessionId)
    const kb = stableSessionKey(b.source || 'claude-code', b.id, b.sessionId)
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })

  // Build node info map for placement context
  const nodeInfoMap = new Map<string, { source: string; project: string; parentKey?: string }>()
  const sessionKeyToSession = new Map<string, LineageGraphSession>()
  for (const s of sorted) {
    const key = stableSessionKey(s.source || 'claude-code', s.id, s.sessionId)
    sessionKeyToSession.set(key, s)

    // Find parent stable key if any
    let parentKey: string | undefined
    const parentId = parentOf.get(s.sessionId) || parentOf.get(s.id)
    if (parentId) {
      // Find the parent session to build its stable key
      for (const ps of sorted) {
        if (ps.sessionId === parentId || ps.id === parentId) {
          parentKey = stableSessionKey(ps.source || 'claude-code', ps.id, ps.sessionId)
          break
        }
      }
    }

    nodeInfoMap.set(key, {
      source: s.source || 'claude-code',
      project: s.projectPath || '',
      parentKey
    })
  }

  // Place nodes: reuse cached positions, compute deterministic positions for new ones
  const placementCtx = { cache: coordCache, nodeInfo: nodeInfoMap }
  const existingPositions: CachedPosition[] = []

  // Collect existing positions first (for collision nudging)
  for (const s of sorted) {
    const key = stableSessionKey(s.source || 'claude-code', s.id, s.sessionId)
    const cached = coordCache.get(key)
    if (cached) {
      existingPositions.push(cached)
    }
  }

  const idToIdx = new Map<string, number>()
  const nodes: Node[] = []

  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i]
    const src = s.source || 'claude-code'
    const key = stableSessionKey(src, s.id, s.sessionId)
    const created = new Date(s.createdAt).getTime() || now
    const ageDays = (now - created) / 86400000
    const recency = Math.max(0, Math.min(1, 1 - ageDays / 180))
    const totalTokens = s.tokenUsage?.totalTokens || 0
    const fileKeys = (s.referencedFiles || []).map(f => f.path).slice(0, 20)

    // Position: cached (old node) or deterministic (new node)
    let pos: CachedPosition
    const cached = coordCache.get(key)
    if (cached) {
      pos = cached
    } else {
      // New node: deterministic placement then collision nudge
      pos = computeNewNodePosition(key, placementCtx)
      pos = nudgeNewNode(pos, existingPositions)
      // Write to cache immediately so subsequent new nodes can reference it
      coordCache.set(key, { x: pos.x, y: pos.y })
      existingPositions.push(pos)
    }

    idToIdx.set(s.sessionId, i)
    idToIdx.set(s.id, i)
    nodes.push({
      id: s.sessionId,
      stableKey: key,
      x: pos.x,
      y: pos.y,
      vx: 0, vy: 0,
      source: src,
      project: s.projectPath || '',
      title: s.firstUserMessage?.slice(0, 80) || s.sessionId.slice(0, 12),
      turnCount: s.turnCount,
      totalTokens,
      compactCount: s.compactCount || 0,
      createdAt: created,
      recency,
      cwds: s.cwds || [],
      fileKeys
    })
  }

  const edges: Edge[] = []

  // 1. Lineage edges (strongest)
  if (registry) {
    for (const r of registry.relations) {
      const fi = idToIdx.get(r.parent)
      const ti = idToIdx.get(r.child)
      if (fi !== undefined && ti !== undefined) {
        edges.push({ from: fi, to: ti, type: 'lineage' })
      }
    }
  }

  // Explicit continuation/resume links are authoritative logical-thread
  // relationships even when the historical lineage registry is incomplete.
  const continuationPairs = new Set(edges.map((edge) => `${edge.from}:${edge.to}`))
  for (const session of sorted) {
    if (!session.successor) continue
    const from = idToIdx.get(session.id) ?? idToIdx.get(session.sessionId)
    const to = idToIdx.get(session.successor)
    if (from === undefined || to === undefined || from === to) continue
    const key = `${from}:${to}`
    if (continuationPairs.has(key)) continue
    continuationPairs.add(key)
    edges.push({ from, to, type: 'continuation' })
  }

  // 2. Same project chain — sorted by stable key within group
  const projectMap = new Map<string, number[]>()
  for (let i = 0; i < nodes.length; i++) {
    const p = nodes[i].project
    if (p) {
      if (!projectMap.has(p)) projectMap.set(p, [])
      projectMap.get(p)!.push(i)
    }
  }
  for (const [, indices] of projectMap) {
    indices.sort((a, b) => nodes[a].stableKey < nodes[b].stableKey ? -1 : 1)
    if (indices.length < 2) continue
    for (let i = 0; i < indices.length - 1; i++) {
      edges.push({ from: indices[i], to: indices[i + 1], type: 'project' })
    }
  }

  // 3. Same source chain — sorted by stable key within group
  const sourceMap = new Map<string, number[]>()
  for (let i = 0; i < nodes.length; i++) {
    if (!sourceMap.has(nodes[i].source)) sourceMap.set(nodes[i].source, [])
    sourceMap.get(nodes[i].source)!.push(i)
  }
  for (const [, indices] of sourceMap) {
    indices.sort((a, b) => nodes[a].stableKey < nodes[b].stableKey ? -1 : 1)
    for (let i = 0; i < indices.length - 1; i++) {
      edges.push({ from: indices[i], to: indices[i + 1], type: 'source' })
    }
  }

  // 4. Time proximity — same day sessions link
  const dayMap = new Map<number, number[]>()
  for (let i = 0; i < nodes.length; i++) {
    const dk = dayKey(nodes[i].createdAt)
    if (!dayMap.has(dk)) dayMap.set(dk, [])
    dayMap.get(dk)!.push(i)
  }
  for (const [, indices] of dayMap) {
    indices.sort((a, b) => nodes[a].stableKey < nodes[b].stableKey ? -1 : 1)
    if (indices.length < 2) continue
    for (let i = 0; i < Math.min(indices.length - 1, 30); i++) {
      edges.push({ from: indices[i], to: indices[i + 1], type: 'time' })
    }
  }

  // 5. Same working directory
  const cwdMap = new Map<string, number[]>()
  for (let i = 0; i < nodes.length; i++) {
    for (const cwd of nodes[i].cwds.slice(0, 3)) {
      if (!cwdMap.has(cwd)) cwdMap.set(cwd, [])
      cwdMap.get(cwd)!.push(i)
    }
  }
  for (const [, indices] of cwdMap) {
    indices.sort((a, b) => nodes[a].stableKey < nodes[b].stableKey ? -1 : 1)
    if (indices.length < 2 || indices.length > 300) continue
    for (let i = 0; i < Math.min(indices.length - 1, 20); i++) {
      edges.push({ from: indices[i], to: indices[i + 1], type: 'cwd' })
    }
  }

  // 6. File overlap — sessions sharing referenced files
  const fileMap = new Map<string, number[]>()
  for (let i = 0; i < nodes.length; i++) {
    for (const fk of nodes[i].fileKeys) {
      if (!fileMap.has(fk)) fileMap.set(fk, [])
      fileMap.get(fk)!.push(i)
    }
  }
  for (const [, indices] of fileMap) {
    indices.sort((a, b) => nodes[a].stableKey < nodes[b].stableKey ? -1 : 1)
    if (indices.length < 2 || indices.length > 100) continue
    for (let i = 0; i < Math.min(indices.length - 1, 10); i++) {
      edges.push({ from: indices[i], to: indices[i + 1], type: 'files' })
    }
  }

  return { nodes, edges }
}

/**
 * Deterministic force simulation — no Math.random().
 * Uses hash-based sampling for repulsion computation.
 */
function simulate(nodes: Node[], edges: Edge[], iterations: number) {
  const n = nodes.length
  const repulsion = 60
  const damping = 0.8
  const maxForce = 4

  const STRENGTH: Record<string, number> = {
    lineage: 0.1,
    continuation: 0.12,
    project: 0.012,
    source: 0.025,
    time: 0.008,
    cwd: 0.01,
    files: 0.006
  }

  for (let iter = 0; iter < iterations; iter++) {
    const temp = 1 - iter / iterations

    for (let i = 0; i < n; i++) {
      let fx = 0
      let fy = 0

      const sampleSize = Math.min(50, n)
      for (let s = 0; s < sampleSize; s++) {
        const j = deterministicSampleIndex(i, s, n)
        if (j === i) continue
        const dx = nodes[i].x - nodes[j].x
        const dy = nodes[i].y - nodes[j].y
        const dist = Math.sqrt(dx * dx + dy * dy) + 1
        const force = repulsion / (dist * dist) * (n / sampleSize)
        fx += (dx / dist) * force
        fy += (dy / dist) * force
      }

      // Per-source gravity well
      const srcIdx = SOURCE_ORDER.indexOf(nodes[i].source)
      const wellAngle = srcIdx >= 0 ? (srcIdx / SOURCE_ORDER.length) * Math.PI * 2 : 0
      const wellR = 80
      const wellX = Math.cos(wellAngle) * wellR
      const wellY = Math.sin(wellAngle) * wellR
      fx += -(nodes[i].x - wellX) * 0.04
      fy += -(nodes[i].y - wellY) * 0.04

      // Importance centrality: high-token sessions pulled slightly toward center
      const importance = Math.min(1, nodes[i].totalTokens / 500000)
      fx += -nodes[i].x * importance * 0.005
      fy += -nodes[i].y * importance * 0.005

      const fMag = Math.sqrt(fx * fx + fy * fy)
      if (fMag > maxForce) {
        fx = (fx / fMag) * maxForce
        fy = (fy / fMag) * maxForce
      }

      nodes[i].vx = (nodes[i].vx + fx * temp) * damping
      nodes[i].vy = (nodes[i].vy + fy * temp) * damping
    }

    for (const e of edges) {
      const a = nodes[e.from]
      const b = nodes[e.to]
      const dx = b.x - a.x
      const dy = b.y - a.y
      const dist = Math.sqrt(dx * dx + dy * dy) + 1
      const str = STRENGTH[e.type] || 0.01
      const force = dist * str * temp
      a.vx += (dx / dist) * force
      a.vy += (dy / dist) * force
      b.vx -= (dx / dist) * force
      b.vy -= (dy / dist) * force
    }

    for (let i = 0; i < n; i++) {
      nodes[i].x += nodes[i].vx
      nodes[i].y += nodes[i].vy
    }
  }

  return nodes
}

/**
 * Presentation-only update: patches mutable display properties on existing nodes
 * WITHOUT changing positions. Used when turnCount/tokens/title change but no
 * nodes were added or removed.
 */
function patchPresentationData(
  graph: { nodes: Node[]; edges: Edge[] },
  sessions: LineageGraphSession[]
) {
  const now = Date.now()
  const sessionByKey = new Map<string, LineageGraphSession>()
  for (const s of sessions) {
    const key = stableSessionKey(s.source || 'claude-code', s.id, s.sessionId)
    sessionByKey.set(key, s)
  }

  for (const node of graph.nodes) {
    const s = sessionByKey.get(node.stableKey)
    if (!s) continue
    node.turnCount = s.turnCount
    node.totalTokens = s.tokenUsage?.totalTokens || 0
    node.compactCount = s.compactCount || 0
    node.title = s.firstUserMessage?.slice(0, 80) || s.sessionId.slice(0, 12)
    const created = new Date(s.createdAt).getTime() || now
    const ageDays = (now - created) / 86400000
    node.recency = Math.max(0, Math.min(1, 1 - ageDays / 180))
  }
}

export function LineagePage() {
  const sessions = useStore((s) => s.sessions)
  const graphSessions = useMemo(
    () => sessions.filter((session) => session.turnCount > 0) as LineageGraphSession[],
    [sessions]
  )

  // Membership key: only changes when nodes are added/removed (not on presentation updates)
  const membershipKey = useMemo(
    () => computeMembershipKey(graphSessions),
    [graphSessions]
  )
  const openSession = useStore((s) => s.openSession)
  const locale = useStore((s) => s.locale)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [hoveredNode, setHoveredNode] = useState<Node | null>(null)
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 })
  const [showSharePreview, setShowSharePreview] = useState(false)
  const graphRef = useRef<{ nodes: Node[]; edges: Edge[] } | null>(null)
  const transformRef = useRef({ x: 0, y: 0, scale: 1 })
  const dragRef = useRef<{ dragging: boolean; lastX: number; lastY: number }>({ dragging: false, lastX: 0, lastY: 0 })
  const [ready, setReady] = useState(false)
  const userHasInteractedRef = useRef(false)
  const initialFitDoneRef = useRef(false)

  // Long-lived coordinate cache — survives across rebuilds
  const coordCacheRef = useRef<CoordinateCache>(new Map())

  // Track previous membership key to detect actual node changes
  const prevMembershipKeyRef = useRef<string>('')

  // Force re-layout counter (incremented by "Re-layout" button)
  const [forceLayoutCounter, setForceLayoutCounter] = useState(0)

  // ---- MEMBERSHIP CHANGE: full incremental rebuild ----
  useEffect(() => {
    if (graphSessions.length === 0) return
    let cancelled = false

    const commitLayout = (registry: { relations: Array<{ parent: string; child: string; type: string }> } | null) => {
      if (cancelled) return

      const cache = coordCacheRef.current
      const { nodes, edges } = buildGraph(graphSessions, registry, cache)

      // Only run full simulation on first build or manual re-layout
      const isFirstBuild = prevMembershipKeyRef.current === ''
      if (isFirstBuild || forceLayoutCounter > 0) {
        simulate(nodes, edges, 120)
      }

      // Write final positions back to cache
      for (const node of nodes) {
        cache.set(node.stableKey, { x: node.x, y: node.y })
      }

      // Prune deleted nodes from cache
      const currentKeys = new Set(nodes.map(n => n.stableKey))
      for (const key of cache.keys()) {
        if (!currentKeys.has(key)) cache.delete(key)
      }

      if (cancelled) return
      graphRef.current = { nodes, edges }
      prevMembershipKeyRef.current = membershipKey

      setReady(true)
    }

    const timer = window.setTimeout(() => {
      void window.api.getLineageRegistry()
        .then((registry: any) => commitLayout(registry))
        .catch(() => commitLayout(null))
    }, LAYOUT_DEBOUNCE_MS)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [membershipKey, forceLayoutCounter])

  // ---- PRESENTATION UPDATE: redraw only, no layout ----
  useEffect(() => {
    const graph = graphRef.current
    if (!graph || !ready) return
    // Only run presentation patch when membership hasn't changed
    // (if it changed, the membership effect above handles it)
    if (prevMembershipKeyRef.current === membershipKey) {
      patchPresentationData(graph, graphSessions)
      draw()
    }
  }, [graphSessions]) // intentionally depends on graphSessions (shallow ref), not membershipKey

  const handleRelayout = useCallback(() => {
    // Clear coordinate cache to force full recompute
    coordCacheRef.current = new Map()
    // Re-layout is the one explicit action allowed to reset the camera and fit
    // the recomputed graph. Toggling ready guarantees the fit effect runs even
    // when the page was already rendered.
    initialFitDoneRef.current = false
    setReady(false)
    setForceLayoutCounter(c => c + 1)
  }, [])

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const graph = graphRef.current
    if (!canvas || !graph) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    const newW = Math.round(rect.width * dpr)
    const newH = Math.round(rect.height * dpr)

    // Only reset backing store when size actually changed — avoids white-frame flicker
    if (canvas.width !== newW || canvas.height !== newH) {
      canvas.width = newW
      canvas.height = newH
    }
    // setTransform is absolute (not cumulative like ctx.scale), safe to call every frame
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const t = transformRef.current
    ctx.clearRect(0, 0, rect.width, rect.height)
    ctx.save()
    ctx.translate(rect.width / 2 + t.x, rect.height / 2 + t.y)
    ctx.scale(t.scale, t.scale)

    // Draw edges
    for (const e of graph.edges) {
      const a = graph.nodes[e.from]
      const b = graph.nodes[e.to]
      if (e.type === 'continuation') {
        ctx.globalAlpha = 0.65
        ctx.lineWidth = 1.6
        ctx.strokeStyle = '#34d399'
      } else if (e.type === 'lineage') {
        ctx.globalAlpha = 0.4
        ctx.lineWidth = 1.2
        ctx.strokeStyle = '#60a5fa'
      } else {
        ctx.globalAlpha = 0.04
        ctx.lineWidth = 0.3
        ctx.strokeStyle = getComputedStyle(canvas).color || '#888'
      }
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.stroke()
    }

    // Draw nodes with recency fade + size by importance
    for (const node of graph.nodes) {
      const color = SOURCE_COLORS[node.source] || '#94a3b8'
      // Size: base from turns, boost from tokens and compacts
      const turnSize = Math.sqrt(node.turnCount) * 0.25
      const tokenBoost = Math.min(1.5, node.totalTokens / 300000)
      const compactBoost = Math.min(1, node.compactCount * 0.3)
      const size = Math.max(1.2, Math.min(5, turnSize + tokenBoost + compactBoost))

      // Opacity: recent = bright, old = faded
      const baseAlpha = 0.3 + node.recency * 0.6 // 0.3 for 180d+ old, 0.9 for today
      ctx.fillStyle = color
      ctx.globalAlpha = node === hoveredNode ? 1 : baseAlpha
      ctx.beginPath()
      ctx.arc(node.x, node.y, size, 0, Math.PI * 2)
      ctx.fill()
    }

    // Hovered node glow + label
    if (hoveredNode) {
      const color = SOURCE_COLORS[hoveredNode.source] || '#94a3b8'
      ctx.globalAlpha = 0.2
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(hoveredNode.x, hoveredNode.y, 12, 0, Math.PI * 2)
      ctx.fill()
      ctx.globalAlpha = 1
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(hoveredNode.x, hoveredNode.y, 3.5, 0, Math.PI * 2)
      ctx.fill()
    }

    ctx.restore()
  }, [hoveredNode])

  // Keep a ref to the latest draw so stable effects can call it without re-subscribing
  const drawRef = useRef(draw)
  drawRef.current = draw

  // Compute bounding box of all nodes and set transform to fill the viewport
  const fitAll = useCallback(() => {
    const graph = graphRef.current
    const canvas = canvasRef.current
    if (!graph || !canvas || graph.nodes.length === 0) return

    const rect = canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const node of graph.nodes) {
      if (node.x < minX) minX = node.x
      if (node.x > maxX) maxX = node.x
      if (node.y < minY) minY = node.y
      if (node.y > maxY) maxY = node.y
    }

    const bboxW = maxX - minX || 1
    const bboxH = maxY - minY || 1
    const centerX = (minX + maxX) / 2
    const centerY = (minY + maxY) / 2

    // 0.85 factor leaves ~7.5% padding per edge (within the 5-8% spec)
    const scale = Math.min(1.5, rect.width * 0.85 / bboxW, rect.height * 0.85 / bboxH)

    transformRef.current = { x: -centerX * scale, y: -centerY * scale, scale }
  }, [])

  useEffect(() => {
    if (!ready) return
    if (!initialFitDoneRef.current) {
      initialFitDoneRef.current = true
      fitAll()
    }
    draw()
  }, [ready, draw, fitAll])

  useEffect(() => {
    const container = containerRef.current
    if (!container || !ready) return

    let timer: ReturnType<typeof setTimeout>
    const observer = new ResizeObserver(() => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (!userHasInteractedRef.current) {
          fitAll()
        }
        drawRef.current()
      }, 200)
    })
    observer.observe(container)
    return () => {
      clearTimeout(timer)
      observer.disconnect()
    }
  }, [ready, fitAll])

  const findNodeAt = useCallback((clientX: number, clientY: number): Node | null => {
    const canvas = canvasRef.current
    const graph = graphRef.current
    if (!canvas || !graph) return null
    const rect = canvas.getBoundingClientRect()
    const t = transformRef.current
    const mx = (clientX - rect.left - rect.width / 2 - t.x) / t.scale
    const my = (clientY - rect.top - rect.height / 2 - t.y) / t.scale
    let closest: Node | null = null
    let closestDist = 15 / t.scale
    for (const node of graph.nodes) {
      const dist = Math.sqrt((node.x - mx) ** 2 + (node.y - my) ** 2)
      if (dist < closestDist) { closestDist = dist; closest = node }
    }
    return closest
  }, [])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (dragRef.current.dragging) {
      userHasInteractedRef.current = true
      transformRef.current.x += e.clientX - dragRef.current.lastX
      transformRef.current.y += e.clientY - dragRef.current.lastY
      dragRef.current.lastX = e.clientX
      dragRef.current.lastY = e.clientY
      draw()
      return
    }
    const node = findNodeAt(e.clientX, e.clientY)
    setMousePos({ x: e.clientX, y: e.clientY })
    if (node !== hoveredNode) { setHoveredNode(node); draw() }
  }, [findNodeAt, hoveredNode, draw])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    dragRef.current = { dragging: true, lastX: e.clientX, lastY: e.clientY }
  }, [])

  const handleMouseUp = useCallback(() => {
    dragRef.current.dragging = false
  }, [])

  const handleClick = useCallback((e: React.MouseEvent) => {
    if (dragRef.current.dragging) return
    const node = findNodeAt(e.clientX, e.clientY)
    if (node) {
      openSession(node.id)
    }
  }, [findNodeAt, openSession])

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    userHasInteractedRef.current = true
    const delta = e.deltaY > 0 ? 0.9 : 1.1
    transformRef.current.scale = Math.max(0.1, Math.min(8, transformRef.current.scale * delta))
    draw()
  }, [draw])

  const sourceCounts = graphSessions.reduce((acc, s) => {
    const src = s.source || 'claude-code'
    acc[src] = (acc[src] || 0) + 1
    return acc
  }, {} as Record<string, number>)

  // Empty library: show friendly empty state instead of infinite spinner
  if (graphSessions.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted text-sm">
        <div className="text-center max-w-sm space-y-4">
          <Compass size={36} className="mx-auto text-faint" />
          <div className="text-base font-medium text-secondary">{translate(locale, 'galaxy.empty_title')}</div>
          <div className="text-xs text-muted leading-relaxed">{translate(locale, 'galaxy.empty_body')}</div>
          <div className="flex items-center justify-center gap-3 pt-2">
            <button
              onClick={() => useStore.getState().toggleSettings()}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs border border-edge hover:bg-surface text-secondary hover:text-primary transition-colors"
            >
              <Settings size={12} />
              {translate(locale, 'galaxy.check_sources')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (!ready) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted text-sm">
        <div className="animate-spin w-6 h-6 border-2 border-edge-strong border-t-body rounded-full mr-2" />
        {translate(locale, 'renderer.lineage_page.computing_graph_layout')}
      </div>
    )
  }

  const formatDate = (ts: number) => {
    const d = new Date(ts)
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
  }

  return (
    <div ref={containerRef} className="flex-1 flex flex-col overflow-hidden relative">
      <div className="flex items-center gap-4 px-4 py-2 border-b border-edge text-xs text-secondary shrink-0 flex-wrap">
        <span className="text-sm font-medium text-primary flex items-center gap-1.5">
          <GitBranch size={14} />
          {translate(locale, 'renderer.lineage_page.session_galaxy')}
        </span>
        {Object.entries(sourceCounts).map(([src, count]) => (
          <div key={src} className="flex items-center gap-1.5">
            <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: SOURCE_COLORS[src] || '#94a3b8' }} />
            <span>{SOURCE_LABELS[src] || src}</span>
            <span className="text-muted">{count}</span>
          </div>
        ))}
        <span className="text-muted ml-auto">{graphSessions.length} sessions</span>
        <button
          onClick={handleRelayout}
          className="flex items-center gap-1 px-2 py-0.5 rounded border border-edge hover:bg-base-hover text-secondary hover:text-primary transition-colors"
          title={translate(locale, 'renderer.lineage_page.relayout')}
        >
          <RotateCcw size={12} />
          <span>{translate(locale, 'renderer.lineage_page.relayout')}</span>
        </button>
        <button
          onClick={() => setShowSharePreview(true)}
          className="flex items-center gap-1 px-2 py-0.5 rounded border border-edge hover:bg-base-hover text-secondary hover:text-primary transition-colors"
          title={translate(locale, 'galaxy.share_button')}
        >
          <Share2 size={12} />
          <span>{translate(locale, 'galaxy.share_button')}</span>
        </button>
      </div>

      <canvas
        ref={canvasRef}
        className="flex-1"
        style={{ width: '100%', height: '100%', cursor: dragRef.current.dragging ? 'grabbing' : 'grab' }}
        onMouseMove={handleMouseMove}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onClick={handleClick}
        onWheel={handleWheel}
      />

      {hoveredNode && !dragRef.current.dragging && (
        <div
          className="fixed z-50 px-3 py-2 rounded-lg border border-edge bg-base shadow-lg text-xs max-w-[300px] pointer-events-none"
          style={{ left: mousePos.x + 12, top: mousePos.y - 10 }}
        >
          <div className="flex items-center gap-2 mb-1">
            <span className="inline-block w-2 h-2 rounded-full" style={{ background: SOURCE_COLORS[hoveredNode.source] || '#94a3b8' }} />
            <span className="font-medium text-body">{SOURCE_LABELS[hoveredNode.source] || hoveredNode.source}</span>
          </div>
          <div className="text-body truncate mb-1">{hoveredNode.title}</div>
          <div className="text-muted space-x-2">
            <span>{hoveredNode.turnCount} turns</span>
            {hoveredNode.totalTokens > 0 && <span>· {Math.round(hoveredNode.totalTokens / 1000)}k tok</span>}
            {hoveredNode.compactCount > 0 && <span>· {hoveredNode.compactCount}x compact</span>}
            <span>· {formatDate(hoveredNode.createdAt)}</span>
          </div>
          {hoveredNode.cwds.length > 0 && (
            <div className="text-muted truncate mt-0.5">{hoveredNode.cwds[0]}</div>
          )}
        </div>
      )}

      {showSharePreview && graphRef.current && (
        <GalaxySharePreview
          nodes={graphRef.current.nodes.map((n) => ({
            x: n.x,
            y: n.y,
            source: n.source,
            turnCount: n.turnCount,
            recency: n.recency,
            totalTokens: n.totalTokens,
            compactCount: n.compactCount,
          }))}
          sourceColors={SOURCE_COLORS}
          sourceLabels={SOURCE_LABELS}
          onClose={() => setShowSharePreview(false)}
        />
      )}
    </div>
  )
}
