import { translate } from '../i18n'
import { useState, useEffect, useMemo, useCallback } from 'react'
import { useStore } from '../store'
import { GitBranch } from 'lucide-react'

interface Relation {
  parent: string
  child: string
  type: string
}

interface RegistrySession {
  sessionId: string
  rootSessionId: string
  latestResumeId: string
  isAlias: boolean
  source: string
}

interface Registry {
  sessions: Record<string, RegistrySession>
  relations: Relation[]
}

const NODE_W = 160
const NODE_H = 36
const GAP_X = 16
const GAP_Y = 48
const PAD = 16

const SOURCE_COLORS: Record<string, string> = {
  'claude-code': '#fbbf24',
  codex: '#60a5fa',
  cursor: '#4ade80',
  opencode: '#22d3ee',
  zcode: '#f87171'
}

const SOURCE_LABELS: Record<string, string> = {
  'claude-code': 'CC',
  codex: 'CDX',
  cursor: 'CUR',
  opencode: 'OC',
  zcode: 'ZC'
}

function findFamily(sessionId: string, registry: Registry): { ids: Set<string>; relations: Relation[] } {
  const visited = new Set<string>()
  const adj = new Map<string, Set<string>>()
  for (const r of registry.relations) {
    if (!adj.has(r.parent)) adj.set(r.parent, new Set())
    if (!adj.has(r.child)) adj.set(r.child, new Set())
    adj.get(r.parent)!.add(r.child)
    adj.get(r.child)!.add(r.parent)
  }

  const queue = [sessionId]
  visited.add(sessionId)
  while (queue.length > 0) {
    const id = queue.shift()!
    for (const neighbor of adj.get(id) || []) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor)
        queue.push(neighbor)
      }
    }
  }

  const familyRelations = registry.relations.filter(
    (r) => visited.has(r.parent) && visited.has(r.child)
  )
  return { ids: visited, relations: familyRelations }
}

function layoutTree(
  ids: Set<string>,
  relations: Relation[],
  sessions: Record<string, RegistrySession>
) {
  const validIds = [...ids].filter((id) => sessions[id])
  if (validIds.length === 0) return { nodes: [], edges: relations, width: 0, height: 0 }

  const childrenMap = new Map<string, string[]>()
  const parentMap = new Map<string, string[]>()
  for (const r of relations) {
    if (!childrenMap.has(r.parent)) childrenMap.set(r.parent, [])
    if (!parentMap.has(r.child)) parentMap.set(r.child, [])
    childrenMap.get(r.parent)!.push(r.child)
    parentMap.get(r.child)!.push(r.parent)
  }

  const roots = validIds.filter((id) => !parentMap.has(id))
  if (roots.length === 0) roots.push(validIds[0])

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
  for (const id of validIds) {
    if (!layers.has(id)) layers.set(id, 0)
  }

  const layerGroups = new Map<number, string[]>()
  for (const id of validIds) {
    const l = layers.get(id)!
    if (!layerGroups.has(l)) layerGroups.set(l, [])
    layerGroups.get(l)!.push(id)
  }
  const maxLayer = Math.max(0, ...layerGroups.keys())

  const nodeOrder = new Map<string, number>()
  const layer0 = layerGroups.get(0) || []
  layer0.sort((a, b) => (sessions[a]?.sessionId || '').localeCompare(sessions[b]?.sessionId || ''))
  layer0.forEach((id, i) => nodeOrder.set(id, i))

  for (let l = 1; l <= maxLayer; l++) {
    const layerIds = layerGroups.get(l) || []
    const scored = layerIds.map((id) => {
      const parents = parentMap.get(id) || []
      const xs = parents.map((p) => nodeOrder.get(p) ?? 0)
      const avg = xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
      return { id, score: avg }
    })
    scored.sort((a, b) => a.score - b.score)
    scored.forEach(({ id }, i) => nodeOrder.set(id, i))
    layerGroups.set(l, scored.map((s) => s.id))
  }

  const nodes: Array<{ id: string; x: number; y: number }> = []
  let maxX = 0
  for (const [layer, layerIds] of layerGroups) {
    for (let i = 0; i < layerIds.length; i++) {
      const x = PAD + i * (NODE_W + GAP_X)
      const y = PAD + layer * (NODE_H + GAP_Y)
      nodes.push({ id: layerIds[i], x, y })
      maxX = Math.max(maxX, x + NODE_W)
    }
  }

  return {
    nodes,
    edges: relations,
    width: Math.max(maxX + PAD, NODE_W + PAD * 2),
    height: PAD * 2 + (maxLayer + 1) * NODE_H + maxLayer * GAP_Y
  }
}

export function SessionFamilyTree({ sessionId }: { sessionId: string }) {
  const storeSessions = useStore((s) => s.sessions)
  const config = useStore((s) => s.config)
  const selectSession = useStore((s) => s.selectSession)
  const locale = useStore((s) => s.locale)

  const [registry, setRegistry] = useState<Registry | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api.getLineageRegistry().then((data: Registry | null) => {
      if (!cancelled) setRegistry(data)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  const family = useMemo(() => {
    if (!registry) return null
    const { ids, relations } = findFamily(sessionId, registry)
    if (relations.length === 0) return null
    return layoutTree(ids, relations, registry.sessions)
  }, [registry, sessionId])

  const posMap = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>()
    if (family) for (const n of family.nodes) m.set(n.id, { x: n.x, y: n.y })
    return m
  }, [family])

  const getTitle = useCallback(
    (sid: string): string => {
      const meta = config?.sessionMeta?.[sid]
      if (meta?.customTitle) return meta.customTitle
      const s = storeSessions.find((ss) => ss.sessionId === sid)
      if (s?.firstUserMessage) return s.firstUserMessage.slice(0, 50)
      return sid.slice(0, 10)
    },
    [storeSessions, config]
  )

  const getSource = useCallback(
    (sid: string): string => {
      if (registry?.sessions[sid]) return registry.sessions[sid].source
      const s = storeSessions.find((ss) => ss.sessionId === sid)
      return s?.source || 'claude-code'
    },
    [storeSessions, registry]
  )

  const handleClick = useCallback(
    (sid: string) => {
      const session = storeSessions.find((s) => s.sessionId === sid)
      if (session) {
        selectSession(session.filePath, session.allFilePaths, session.id)
      }
    },
    [storeSessions, selectSession]
  )

  if (!family || family.nodes.length === 0) return null

  return (
    <section>
      <div className="flex items-center gap-2 text-xs font-medium text-soft-purple mb-2">
        <GitBranch size={12} />
        <span>{translate(locale, 'renderer.session_family_tree.session_lineage')}</span>
        <span className="text-muted text-[10px]">
          {family.nodes.length} {translate(locale, 'renderer.session_family_tree.nodes')} · {family.edges.length} {translate(locale, 'renderer.session_family_tree.edges')}
        </span>
      </div>
      <div className="overflow-x-auto rounded border border-edge bg-surface/30" style={{ maxHeight: 320 }}>
        <svg width={family.width} height={family.height} className="block">
          <defs>
            <marker id="ft-arrow" markerWidth="6" markerHeight="6" refX="6" refY="3" orient="auto">
              <path d="M0,0 L6,3 L0,6" fill="none" stroke="#60a5fa" strokeWidth="1" />
            </marker>
            <marker id="ft-arrow-fork" markerWidth="6" markerHeight="6" refX="6" refY="3" orient="auto">
              <path d="M0,0 L6,3 L0,6" fill="none" stroke="#a78bfa" strokeWidth="1" />
            </marker>
          </defs>
          {family.edges.map((edge, i) => {
            const from = posMap.get(edge.parent)
            const to = posMap.get(edge.child)
            if (!from || !to) return null
            const x1 = from.x + NODE_W / 2
            const y1 = from.y + NODE_H
            const x2 = to.x + NODE_W / 2
            const y2 = to.y
            const isFork = edge.type === 'fork'
            return (
              <path
                key={i}
                d={`M${x1},${y1} C${x1},${y1 + GAP_Y / 2} ${x2},${y2 - GAP_Y / 2} ${x2},${y2}`}
                fill="none"
                stroke={isFork ? '#a78bfa' : '#60a5fa'}
                strokeWidth={1.5}
                strokeDasharray={isFork ? '4 3' : undefined}
                markerEnd={isFork ? 'url(#ft-arrow-fork)' : 'url(#ft-arrow)'}
                opacity={0.7}
              />
            )
          })}
          {family.nodes.map((node) => {
            const isCurrent = node.id === sessionId
            const source = getSource(node.id)
            const color = SOURCE_COLORS[source] || '#94a3b8'
            return (
              <g
                key={node.id}
                onClick={() => handleClick(node.id)}
                style={{ cursor: 'pointer' }}
              >
                <rect
                  x={node.x}
                  y={node.y}
                  width={NODE_W}
                  height={NODE_H}
                  rx={4}
                  fill={isCurrent ? 'rgba(96,165,250,0.15)' : 'rgba(255,255,255,0.05)'}
                  stroke={isCurrent ? '#60a5fa' : 'rgba(255,255,255,0.1)'}
                  strokeWidth={isCurrent ? 2 : 1}
                />
                <rect
                  x={node.x + 6}
                  y={node.y + 10}
                  width={28}
                  height={16}
                  rx={3}
                  fill={color}
                  opacity={0.2}
                />
                <text
                  x={node.x + 20}
                  y={node.y + 22}
                  textAnchor="middle"
                  fontSize={9}
                  fontWeight={600}
                  fill={color}
                >
                  {SOURCE_LABELS[source] || '?'}
                </text>
                <text
                  x={node.x + 40}
                  y={node.y + 23}
                  fontSize={11}
                  fill={isCurrent ? '#60a5fa' : '#e2e8f0'}
                  fontWeight={isCurrent ? 600 : 400}
                >
                  {getTitle(node.id).slice(0, 14)}
                  {getTitle(node.id).length > 14 ? '…' : ''}
                </text>
              </g>
            )
          })}
        </svg>
      </div>
    </section>
  )
}
