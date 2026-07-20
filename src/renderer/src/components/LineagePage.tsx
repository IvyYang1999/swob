import { useState, useEffect, useMemo, useCallback } from 'react'
import { useStore } from '../store'
import { GitBranch } from 'lucide-react'

interface LineageSession {
  sessionId: string
  rootSessionId: string
  latestResumeId: string
  isAlias: boolean
  source: string
  createdAt: string
  updatedAt: string
}

interface LineageRelation {
  child: string
  parent: string
  type: 'fork' | 'continuation'
}

interface LineageRegistry {
  sessions: Record<string, LineageSession>
  relations: LineageRelation[]
}

interface LayoutNode {
  id: string
  x: number
  y: number
}

const NODE_W = 200
const NODE_H = 48
const GAP_X = 40
const GAP_Y = 80
const PAD = 40

const EDGE_STYLE: Record<string, { color: string; dash?: string }> = {
  continuation: { color: '#60a5fa' },
  fork: { color: '#a78bfa', dash: '6 4' }
}

const SOURCE_STYLE: Record<string, { bg: string; fg: string; label: string }> = {
  'claude-code': { bg: '#78350f', fg: '#fbbf24', label: 'CC' },
  codex: { bg: '#1e3a5f', fg: '#60a5fa', label: 'CDX' },
  cursor: { bg: '#14532d', fg: '#4ade80', label: 'CUR' },
  opencode: { bg: '#164e63', fg: '#22d3ee', label: 'OC' },
  zcode: { bg: '#7f1d1d', fg: '#f87171', label: 'ZC' }
}

function shortDate(iso: string): string {
  try {
    const d = new Date(iso)
    return `${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')}`
  } catch {
    return ''
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

function computeLayout(
  sessions: Record<string, LineageSession>,
  relations: LineageRelation[]
): { nodes: LayoutNode[]; edges: LineageRelation[]; width: number; height: number } {
  const connectedIds = new Set<string>()
  for (const r of relations) {
    connectedIds.add(r.parent)
    connectedIds.add(r.child)
  }

  const nodeIds = Object.keys(sessions).filter(
    (id) => connectedIds.has(id) && !sessions[id].isAlias
  )

  if (connectedIds.size > 0 && nodeIds.length === 0) {
    const allConnected = [...connectedIds].filter((id) => sessions[id])
    nodeIds.push(...allConnected)
  }

  if (nodeIds.length === 0) return { nodes: [], edges: [], width: 0, height: 0 }

  const nodeSet = new Set(nodeIds)
  const validRelations = relations.filter((r) => nodeSet.has(r.parent) && nodeSet.has(r.child))

  const childrenMap = new Map<string, string[]>()
  const parentMap = new Map<string, string[]>()
  for (const r of validRelations) {
    ;(childrenMap.get(r.parent) || (childrenMap.set(r.parent, []), childrenMap.get(r.parent)!)).push(r.child)
    ;(parentMap.get(r.child) || (parentMap.set(r.child, []), parentMap.get(r.child)!)).push(r.parent)
  }

  const roots = nodeIds.filter((id) => !parentMap.has(id))
  if (roots.length === 0) roots.push(nodeIds[0])

  const layers = new Map<string, number>()
  const queue: string[] = []
  for (const r of roots) {
    layers.set(r, 0)
    queue.push(r)
  }
  while (queue.length > 0) {
    const id = queue.shift()!
    const layer = layers.get(id)!
    for (const cid of childrenMap.get(id) || []) {
      const existing = layers.get(cid)
      if (existing === undefined || existing < layer + 1) {
        layers.set(cid, layer + 1)
        queue.push(cid)
      }
    }
  }
  for (const id of nodeIds) {
    if (!layers.has(id)) layers.set(id, 0)
  }

  const layerGroups = new Map<number, string[]>()
  for (const id of nodeIds) {
    const l = layers.get(id)!
    ;(layerGroups.get(l) || (layerGroups.set(l, []), layerGroups.get(l)!)).push(id)
  }
  const maxLayer = Math.max(0, ...layerGroups.keys())

  // Barycenter heuristic to reduce edge crossings
  const nodeOrder = new Map<string, number>()
  const layer0 = layerGroups.get(0) || []
  layer0.sort((a, b) => (sessions[a]?.createdAt || '').localeCompare(sessions[b]?.createdAt || ''))
  layer0.forEach((id, i) => nodeOrder.set(id, i))

  for (let l = 1; l <= maxLayer; l++) {
    const ids = layerGroups.get(l) || []
    const scored = ids.map((id) => {
      const parents = parentMap.get(id) || []
      const xs = parents.map((p) => nodeOrder.get(p) ?? 0)
      const avg = xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
      return { id, score: avg }
    })
    scored.sort((a, b) => a.score - b.score)
    scored.forEach(({ id }, i) => nodeOrder.set(id, i))
    layerGroups.set(
      l,
      scored.map((s) => s.id)
    )
  }

  const layout: LayoutNode[] = []
  let maxX = 0
  for (const [layer, ids] of layerGroups) {
    for (let i = 0; i < ids.length; i++) {
      const x = PAD + i * (NODE_W + GAP_X)
      const y = PAD + layer * (NODE_H + GAP_Y)
      layout.push({ id: ids[i], x, y })
      maxX = Math.max(maxX, x + NODE_W)
    }
  }

  return {
    nodes: layout,
    edges: validRelations,
    width: Math.max(maxX + PAD, NODE_W + PAD * 2),
    height: PAD * 2 + (maxLayer + 1) * NODE_H + maxLayer * GAP_Y
  }
}

export function LineagePage() {
  const storeSessions = useStore((s) => s.sessions)
  const config = useStore((s) => s.config)
  const selectSession = useStore((s) => s.selectSession)
  const activeSessionIds = useStore((s) => s.activeSessionIds)
  const setLineageOpen = useStore((s) => s.toggleLineage)

  const [registry, setRegistry] = useState<LineageRegistry | null>(null)
  const [loading, setLoading] = useState(true)
  const [hoveredNode, setHoveredNode] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api.getLineageRegistry().then((data: LineageRegistry | null) => {
      if (!cancelled) {
        setRegistry(data)
        setLoading(false)
      }
    }).catch(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  const { nodes, edges, width, height } = useMemo(() => {
    if (!registry) return { nodes: [], edges: [] as LineageRelation[], width: 0, height: 0 }
    return computeLayout(registry.sessions, registry.relations)
  }, [registry])

  const posMap = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>()
    for (const n of nodes) m.set(n.id, { x: n.x, y: n.y })
    return m
  }, [nodes])

  const getTitle = useCallback(
    (sessionId: string): string => {
      const meta = config?.sessionMeta?.[sessionId]
      if (meta?.customTitle) return meta.customTitle
      const s = storeSessions.find((ss) => ss.sessionId === sessionId)
      if (s) {
        const sMeta = config?.sessionMeta?.[s.id]
        if (sMeta?.customTitle) return sMeta.customTitle
        if (s.firstUserMessage) return s.firstUserMessage.slice(0, 60)
      }
      return sessionId.slice(0, 12)
    },
    [storeSessions, config]
  )

  const getSource = useCallback(
    (sessionId: string): string => {
      const s = storeSessions.find((ss) => ss.sessionId === sessionId)
      return s?.source || 'claude-code'
    },
    [storeSessions]
  )

  const handleNodeClick = useCallback(
    (sessionId: string) => {
      let session = storeSessions.find((s) => s.sessionId === sessionId)
      if (!session && registry) {
        const entry = registry.sessions[sessionId]
        if (entry?.latestResumeId) {
          session = storeSessions.find((s) => s.sessionId === entry.latestResumeId)
        }
      }
      if (session) {
        setLineageOpen()
        selectSession(session.filePath, session.allFilePaths, session.id)
      }
    },
    [storeSessions, selectSession, setLineageOpen, registry]
  )

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted text-sm">
        <div className="animate-spin w-6 h-6 border-2 border-edge-strong border-t-body rounded-full" />
      </div>
    )
  }

  if (!registry || nodes.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted text-sm">
        <div className="text-center">
          <GitBranch size={32} className="mx-auto mb-3 text-faint" />
          <div className="text-sm">暂无会话血统关系</div>
          <div className="text-xs text-faint mt-1">
            当会话被 resume 或 fork 时，血统关系会自动建立
          </div>
        </div>
      </div>
    )
  }

  const sessionCount = Object.values(registry.sessions).filter((s) => !s.isAlias).length
  const relationCount = registry.relations.length

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Legend */}
      <div className="flex items-center gap-4 px-4 py-2 border-b border-edge text-xs text-secondary shrink-0">
        <span className="text-sm font-medium text-primary flex items-center gap-1.5">
          <GitBranch size={14} />
          血统图
        </span>
        <div className="flex items-center gap-1.5">
          <svg width="20" height="2">
            <line x1="0" y1="1" x2="20" y2="1" stroke="#60a5fa" strokeWidth="2" />
          </svg>
          <span>Continuation</span>
        </div>
        <div className="flex items-center gap-1.5">
          <svg width="20" height="2">
            <line
              x1="0"
              y1="1"
              x2="20"
              y2="1"
              stroke="#a78bfa"
              strokeWidth="2"
              strokeDasharray="4 3"
            />
          </svg>
          <span>Fork</span>
        </div>
        <div className="ml-auto text-faint">
          {sessionCount} 个会话 · {relationCount} 条关系
        </div>
      </div>

      {/* Graph */}
      <div className="flex-1 overflow-auto">
        <svg width={width} height={height} className="select-none">
          <defs>
            <marker
              id="arr-cont"
              viewBox="0 0 10 7"
              refX="10"
              refY="3.5"
              markerWidth="7"
              markerHeight="5"
              orient="auto"
            >
              <path d="M0 0 L10 3.5 L0 7z" fill="#60a5fa" />
            </marker>
            <marker
              id="arr-fork"
              viewBox="0 0 10 7"
              refX="10"
              refY="3.5"
              markerWidth="7"
              markerHeight="5"
              orient="auto"
            >
              <path d="M0 0 L10 3.5 L0 7z" fill="#a78bfa" />
            </marker>
          </defs>

          {/* Edges */}
          {edges.map((edge, i) => {
            const from = posMap.get(edge.parent)
            const to = posMap.get(edge.child)
            if (!from || !to) return null
            const x1 = from.x + NODE_W / 2
            const y1 = from.y + NODE_H
            const x2 = to.x + NODE_W / 2
            const y2 = to.y
            const midY = (y1 + y2) / 2
            const style = EDGE_STYLE[edge.type] || EDGE_STYLE.continuation
            return (
              <path
                key={i}
                d={`M${x1} ${y1} C${x1} ${midY},${x2} ${midY},${x2} ${y2}`}
                fill="none"
                stroke={style.color}
                strokeWidth={1.5}
                strokeDasharray={style.dash}
                markerEnd={`url(#arr-${edge.type === 'fork' ? 'fork' : 'cont'})`}
                opacity={0.7}
              />
            )
          })}

          {/* Nodes */}
          {nodes.map((node) => {
            const title = truncate(getTitle(node.id), 25)
            const source = getSource(node.id)
            const isActive = activeSessionIds.has(node.id)
            const isHovered = hoveredNode === node.id
            const ss = SOURCE_STYLE[source] || SOURCE_STYLE['claude-code']
            const entry = registry.sessions[node.id]
            const date = entry ? shortDate(entry.updatedAt || entry.createdAt) : ''
            const shortId = node.id.slice(0, 8)

            return (
              <g
                key={node.id}
                transform={`translate(${node.x},${node.y})`}
                onClick={() => handleNodeClick(node.id)}
                onMouseEnter={() => setHoveredNode(node.id)}
                onMouseLeave={() => setHoveredNode(null)}
                className="cursor-pointer"
              >
                <title>
                  {getTitle(node.id)} ({node.id})
                </title>
                <rect
                  width={NODE_W}
                  height={NODE_H}
                  rx={6}
                  fill={isHovered ? '#3f3f46' : '#27272a'}
                  stroke={isActive ? '#4ade80' : '#3f3f46'}
                  strokeWidth={isActive ? 1.5 : 1}
                />
                {/* Title */}
                <text x={10} y={19} fill="#e4e4e7" fontSize={12} fontFamily="system-ui, sans-serif">
                  {title}
                </text>
                {/* Source badge */}
                <rect
                  x={10}
                  y={27}
                  width={ss.label.length * 7 + 8}
                  height={14}
                  rx={3}
                  fill={ss.bg}
                />
                <text
                  x={10 + (ss.label.length * 7 + 8) / 2}
                  y={37}
                  fill={ss.fg}
                  fontSize={9}
                  fontFamily="system-ui, sans-serif"
                  textAnchor="middle"
                >
                  {ss.label}
                </text>
                {/* Short ID + date */}
                <text
                  x={10 + ss.label.length * 7 + 16}
                  y={37}
                  fill="#71717a"
                  fontSize={9}
                  fontFamily="ui-monospace, monospace"
                >
                  {shortId}
                  {date ? ` · ${date}` : ''}
                </text>
                {/* Active dot */}
                {isActive && <circle cx={NODE_W - 12} cy={12} r={3.5} fill="#4ade80" />}
              </g>
            )
          })}
        </svg>
      </div>
    </div>
  )
}
