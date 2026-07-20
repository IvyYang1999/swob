import { useEffect, useRef, useCallback, useState } from 'react'
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
}

interface Edge {
  from: number
  to: number
  type: string
}

function buildGraph(
  sessions: Array<{ sessionId: string; id: string; source: string; projectPath?: string; firstUserMessage?: string; turnCount: number }>,
  registry: { relations: Array<{ parent: string; child: string; type: string }> } | null
) {
  const idToIdx = new Map<string, number>()
  const nodes: Node[] = []
  const cx = 0
  const cy = 0

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i]
    const angle = (i / sessions.length) * Math.PI * 2
    const r = 30 + Math.random() * 80
    idToIdx.set(s.sessionId, i)
    idToIdx.set(s.id, i)
    nodes.push({
      id: s.sessionId,
      x: cx + Math.cos(angle) * r + (Math.random() - 0.5) * 20,
      y: cy + Math.sin(angle) * r + (Math.random() - 0.5) * 20,
      vx: 0,
      vy: 0,
      source: s.source || 'claude-code',
      project: s.projectPath || '',
      title: s.firstUserMessage?.slice(0, 80) || s.sessionId.slice(0, 12),
      turnCount: s.turnCount
    })
  }

  const edges: Edge[] = []
  if (registry) {
    for (const r of registry.relations) {
      const fi = idToIdx.get(r.parent)
      const ti = idToIdx.get(r.child)
      if (fi !== undefined && ti !== undefined) {
        edges.push({ from: fi, to: ti, type: r.type })
      }
    }
  }

  // Add weak edges: same project (chain neighbors for visual density)
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

  // Add weak edges: same source (connect a sparse chain for clustering)
  const sourceMap = new Map<string, number[]>()
  for (let i = 0; i < nodes.length; i++) {
    const src = nodes[i].source
    if (!sourceMap.has(src)) sourceMap.set(src, [])
    sourceMap.get(src)!.push(i)
  }
  for (const [, indices] of sourceMap) {
    for (let i = 0; i < indices.length - 1; i += 5) {
      edges.push({ from: indices[i], to: indices[Math.min(i + 5, indices.length - 1)], type: 'source' })
    }
  }

  return { nodes, edges }
}

function simulate(nodes: Node[], edges: Edge[], iterations: number) {
  const n = nodes.length
  const repulsion = 60
  const attraction = 0.08
  const projectAttraction = 0.01
  const damping = 0.8
  const maxForce = 4

  const projectMap = new Map<string, number[]>()
  for (let i = 0; i < n; i++) {
    const p = nodes[i].project
    if (p) {
      if (!projectMap.has(p)) projectMap.set(p, [])
      projectMap.get(p)!.push(i)
    }
  }

  for (let iter = 0; iter < iterations; iter++) {
    const temp = 1 - iter / iterations

    for (let i = 0; i < n; i++) {
      let fx = 0
      let fy = 0

      // Sample-based repulsion (avoid O(n²) for large graphs)
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

      // Strong center gravity — pull into tight ball
      const cx = -nodes[i].x * 0.03
      const cy = -nodes[i].y * 0.03
      fx += cx
      fy += cy

      const fMag = Math.sqrt(fx * fx + fy * fy)
      if (fMag > maxForce) {
        fx = (fx / fMag) * maxForce
        fy = (fy / fMag) * maxForce
      }

      nodes[i].vx = (nodes[i].vx + fx * temp) * damping
      nodes[i].vy = (nodes[i].vy + fy * temp) * damping
    }

    // Edge attraction — strong for lineage, weak for project/source
    for (const e of edges) {
      const a = nodes[e.from]
      const b = nodes[e.to]
      const dx = b.x - a.x
      const dy = b.y - a.y
      const dist = Math.sqrt(dx * dx + dy * dy) + 1
      const str = e.type === 'project' ? projectAttraction
                : e.type === 'source' ? projectAttraction * 0.5
                : attraction
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
  const selectSession = useStore((s) => s.selectSession)
  const toggleLineage = useStore((s) => s.toggleLineage)
  const locale = useStore((s) => s.locale)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [hoveredNode, setHoveredNode] = useState<Node | null>(null)
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 })
  const graphRef = useRef<{ nodes: Node[]; edges: Edge[] } | null>(null)
  const transformRef = useRef({ x: 0, y: 0, scale: 1 })
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (sessions.length === 0) return

    window.api.getLineageRegistry().then((registry: any) => {
      const { nodes, edges } = buildGraph(sessions as any, registry)
      simulate(nodes, edges, 120)
      graphRef.current = { nodes, edges }
      setReady(true)
    }).catch(() => {
      const { nodes, edges } = buildGraph(sessions as any, null)
      simulate(nodes, edges, 120)
      graphRef.current = { nodes, edges }
      setReady(true)
    })
  }, [sessions])

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

    // Draw edges — weak ones first, then strong
    for (const e of graph.edges) {
      const a = graph.nodes[e.from]
      const b = graph.nodes[e.to]
      if (e.type === 'project' || e.type === 'source') {
        ctx.globalAlpha = 0.06
        ctx.lineWidth = 0.3
        ctx.strokeStyle = getComputedStyle(canvas).color || '#888'
      } else {
        ctx.globalAlpha = 0.35
        ctx.lineWidth = 1
        ctx.strokeStyle = e.type === 'fork' ? '#a78bfa' : '#60a5fa'
      }
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.stroke()
    }

    // Draw nodes — small dots, tight ball
    for (const node of graph.nodes) {
      const color = SOURCE_COLORS[node.source] || '#94a3b8'
      const size = Math.max(1.5, Math.min(4, Math.sqrt(node.turnCount) * 0.3))
      ctx.fillStyle = color
      ctx.globalAlpha = node === hoveredNode ? 1 : 0.75
      ctx.beginPath()
      ctx.arc(node.x, node.y, size, 0, Math.PI * 2)
      ctx.fill()
    }

    // Hovered node glow
    if (hoveredNode) {
      const color = SOURCE_COLORS[hoveredNode.source] || '#94a3b8'
      ctx.globalAlpha = 0.25
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(hoveredNode.x, hoveredNode.y, 10, 0, Math.PI * 2)
      ctx.fill()
      ctx.globalAlpha = 1
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(hoveredNode.x, hoveredNode.y, 3, 0, Math.PI * 2)
      ctx.fill()
    }

    ctx.restore()
  }, [hoveredNode])

  useEffect(() => {
    if (ready) {
      draw()
    }
  }, [ready, draw])

  useEffect(() => {
    const handleResize = () => draw()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [draw])

  const findNodeAt = useCallback((clientX: number, clientY: number): Node | null => {
    const canvas = canvasRef.current
    const graph = graphRef.current
    if (!canvas || !graph) return null

    const rect = canvas.getBoundingClientRect()
    const t = transformRef.current
    const mx = (clientX - rect.left - rect.width / 2 - t.x) / t.scale
    const my = (clientY - rect.top - rect.height / 2 - t.y) / t.scale

    let closest: Node | null = null
    let closestDist = 15

    for (const node of graph.nodes) {
      const dx = node.x - mx
      const dy = node.y - my
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist < closestDist) {
        closestDist = dist
        closest = node
      }
    }
    return closest
  }, [])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const node = findNodeAt(e.clientX, e.clientY)
    setMousePos({ x: e.clientX, y: e.clientY })
    if (node !== hoveredNode) {
      setHoveredNode(node)
      draw()
    }
  }, [findNodeAt, hoveredNode, draw])

  const handleClick = useCallback((e: React.MouseEvent) => {
    const node = findNodeAt(e.clientX, e.clientY)
    if (node) {
      const session = sessions.find((s) => s.sessionId === node.id)
      if (session) {
        toggleLineage()
        selectSession(session.filePath, session.allFilePaths, session.id)
      }
    }
  }, [findNodeAt, sessions, selectSession, toggleLineage])

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    const delta = e.deltaY > 0 ? 0.9 : 1.1
    transformRef.current.scale *= delta
    transformRef.current.scale = Math.max(0.1, Math.min(5, transformRef.current.scale))
    draw()
  }, [draw])

  // Source legend stats
  const sourceCounts = sessions.reduce((acc, s) => {
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

  return (
    <div ref={containerRef} className="flex-1 flex flex-col overflow-hidden relative">
      {/* Legend bar */}
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
        <span className="text-muted ml-auto">{sessions.length} sessions</span>
      </div>

      {/* Canvas */}
      <canvas
        ref={canvasRef}
        className="flex-1 cursor-crosshair"
        onMouseMove={handleMouseMove}
        onClick={handleClick}
        onWheel={handleWheel}
        style={{ width: '100%', height: '100%' }}
      />

      {/* Tooltip */}
      {hoveredNode && (
        <div
          className="fixed z-50 px-3 py-2 rounded-lg border border-edge bg-base shadow-lg text-xs max-w-[280px] pointer-events-none"
          style={{ left: mousePos.x + 12, top: mousePos.y - 10 }}
        >
          <div className="flex items-center gap-2 mb-1">
            <span className="inline-block w-2 h-2 rounded-full" style={{ background: SOURCE_COLORS[hoveredNode.source] || '#94a3b8' }} />
            <span className="font-medium text-body">{SOURCE_LABELS[hoveredNode.source] || hoveredNode.source}</span>
            <span className="text-muted">{hoveredNode.turnCount} turns</span>
          </div>
          <div className="text-body truncate">{hoveredNode.title}</div>
          {hoveredNode.project && (
            <div className="text-muted truncate mt-0.5">{hoveredNode.project}</div>
          )}
        </div>
      )}
    </div>
  )
}
