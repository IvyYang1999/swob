import { useEffect, useRef, useCallback, useMemo, useState } from 'react'
import { useStore } from '../store'
import { GitBranch } from 'lucide-react'

const SOURCE_COLORS: Record<string, string> = {
  'claude-code': '#f59e0b',
  codex: '#3b82f6',
  cursor: '#22c55e',
  opencode: '#06b6d4',
  zcode: '#ef4444'
}

const SOURCE_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  zcode: 'Zcode'
}

const SOURCE_ORDER = ['claude-code', 'codex', 'cursor', 'opencode', 'zcode']

interface Node {
  id: string
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
  type: string // lineage | project | source | time | cwd | files
}

interface LineageGraphSession {
  sessionId: string
  id: string
  source: string
  projectPath?: string
  firstUserMessage?: string
  turnCount: number
  createdAt: string
  tokenUsage?: { totalTokens: number }
  compactCount: number
  cwds?: string[]
  referencedFiles?: Array<{ path: string }>
}

const LAYOUT_DEBOUNCE_MS = 500

/**
 * Library hydration replaces session object/array identities in small batches.
 * The graph must only rebuild when data consumed by buildGraph changes, otherwise
 * an unrelated metadata patch turns the O(sessions * iterations) simulation into
 * a renderer event-loop hot spin.
 */
export function lineageGraphFingerprint(sessions: LineageGraphSession[]): string {
  return JSON.stringify(sessions.map((session) => [
    session.id,
    session.sessionId,
    session.source || 'claude-code',
    session.projectPath || '',
    session.firstUserMessage || '',
    session.turnCount,
    session.createdAt,
    session.tokenUsage?.totalTokens ?? null,
    session.compactCount || 0,
    session.cwds || [],
    (session.referencedFiles || []).map((file) => file.path)
  ]))
}

function dayKey(ts: number): number {
  return Math.floor(ts / 86400000)
}

function buildGraph(
  sessions: LineageGraphSession[],
  registry: { relations: Array<{ parent: string; child: string; type: string }> } | null
) {
  const idToIdx = new Map<string, number>()
  const nodes: Node[] = []
  const now = Date.now()

  const sourceAngleBase = new Map<string, number>()
  SOURCE_ORDER.forEach((src, idx) => sourceAngleBase.set(src, (idx / SOURCE_ORDER.length) * Math.PI * 2))
  const sourceCounters = new Map<string, number>()
  const srcTotals = new Map<string, number>()
  for (const s of sessions) {
    const src = s.source || 'claude-code'
    srcTotals.set(src, (srcTotals.get(src) || 0) + 1)
  }

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i]
    const src = s.source || 'claude-code'
    const base = sourceAngleBase.get(src) || 0
    const count = sourceCounters.get(src) || 0
    sourceCounters.set(src, count + 1)
    const srcTotal = srcTotals.get(src) || 1
    const sectorWidth = (2 * Math.PI) / SOURCE_ORDER.length * 0.8
    const angle = base + (count / Math.max(srcTotal, 1)) * sectorWidth - sectorWidth / 2
    const r = 20 + Math.random() * 60
    const created = new Date(s.createdAt).getTime() || now
    const ageDays = (now - created) / 86400000
    const recency = Math.max(0, Math.min(1, 1 - ageDays / 180))
    const totalTokens = s.tokenUsage?.totalTokens || 0
    const fileKeys = (s.referencedFiles || []).map(f => f.path).slice(0, 20)

    idToIdx.set(s.sessionId, i)
    idToIdx.set(s.id, i)
    nodes.push({
      id: s.sessionId,
      x: Math.cos(angle) * r + (Math.random() - 0.5) * 20,
      y: Math.sin(angle) * r + (Math.random() - 0.5) * 20,
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

  // 2. Same project chain
  const projectMap = new Map<string, number[]>()
  for (let i = 0; i < nodes.length; i++) {
    const p = nodes[i].project
    if (p) {
      if (!projectMap.has(p)) projectMap.set(p, [])
      projectMap.get(p)!.push(i)
    }
  }
  for (const [, indices] of projectMap) {
    if (indices.length < 2) continue
    for (let i = 0; i < indices.length - 1; i++) {
      edges.push({ from: indices[i], to: indices[i + 1], type: 'project' })
    }
  }

  // 3. Same source chain (harness clustering)
  const sourceMap = new Map<string, number[]>()
  for (let i = 0; i < nodes.length; i++) {
    if (!sourceMap.has(nodes[i].source)) sourceMap.set(nodes[i].source, [])
    sourceMap.get(nodes[i].source)!.push(i)
  }
  for (const [, indices] of sourceMap) {
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
    if (indices.length < 2 || indices.length > 100) continue
    for (let i = 0; i < Math.min(indices.length - 1, 10); i++) {
      edges.push({ from: indices[i], to: indices[i + 1], type: 'files' })
    }
  }

  return { nodes, edges }
}

function simulate(nodes: Node[], edges: Edge[], iterations: number) {
  const n = nodes.length
  const repulsion = 60
  const damping = 0.8
  const maxForce = 4

  const STRENGTH: Record<string, number> = {
    lineage: 0.1,
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
        const j = s < 10 ? (i + s + 1) % n : Math.floor(Math.random() * n)
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

export function LineagePage() {
  const sessions = useStore((s) => s.sessions)
  const graphSessions = useMemo(
    () => sessions.filter((session) => session.turnCount > 0) as LineageGraphSession[],
    [sessions]
  )
  const graphFingerprint = useMemo(
    () => lineageGraphFingerprint(graphSessions),
    [graphSessions]
  )
  const openSession = useStore((s) => s.openSession)
  const locale = useStore((s) => s.locale)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [hoveredNode, setHoveredNode] = useState<Node | null>(null)
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 })
  const graphRef = useRef<{ nodes: Node[]; edges: Edge[] } | null>(null)
  const transformRef = useRef({ x: 0, y: 0, scale: 1 })
  const dragRef = useRef<{ dragging: boolean; lastX: number; lastY: number }>({ dragging: false, lastX: 0, lastY: 0 })
  const [ready, setReady] = useState(false)
  const userHasInteractedRef = useRef(false)
  const initialFitDoneRef = useRef(false)

  useEffect(() => {
    if (graphSessions.length === 0) return
    let cancelled = false
    const commitLayout = (registry: { relations: Array<{ parent: string; child: string; type: string }> } | null) => {
      if (cancelled) return
      const { nodes, edges } = buildGraph(graphSessions, registry)
      simulate(nodes, edges, 120)
      if (cancelled) return
      graphRef.current = { nodes, edges }
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
  }, [graphFingerprint])

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const graph = graphRef.current
    if (!canvas || !graph) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    canvas.width = rect.width * dpr
    canvas.height = rect.height * dpr
    ctx.scale(dpr, dpr)

    const t = transformRef.current
    ctx.clearRect(0, 0, rect.width, rect.height)
    ctx.save()
    ctx.translate(rect.width / 2 + t.x, rect.height / 2 + t.y)
    ctx.scale(t.scale, t.scale)

    // Draw edges
    for (const e of graph.edges) {
      const a = graph.nodes[e.from]
      const b = graph.nodes[e.to]
      if (e.type === 'lineage') {
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

  if (!ready) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted text-sm">
        <div className="animate-spin w-6 h-6 border-2 border-edge-strong border-t-body rounded-full mr-2" />
        {locale === 'zh-CN' ? '正在计算图谱布局…' : 'Computing graph layout…'}
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
          {locale === 'zh-CN' ? '会话图谱' : 'Session Galaxy'}
        </span>
        {Object.entries(sourceCounts).map(([src, count]) => (
          <div key={src} className="flex items-center gap-1.5">
            <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: SOURCE_COLORS[src] || '#94a3b8' }} />
            <span>{SOURCE_LABELS[src] || src}</span>
            <span className="text-muted">{count}</span>
          </div>
        ))}
        <span className="text-muted ml-auto">{graphSessions.length} sessions</span>
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
    </div>
  )
}
