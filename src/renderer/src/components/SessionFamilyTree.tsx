import { translate } from '../i18n'
import { useState, useEffect, useMemo, useCallback } from 'react'
import { useStore } from '../store'
import { GitBranch } from 'lucide-react'
import { DisclosureSection } from './inspector'

/* ------------------------------------------------------------------ */
/*  Data types (unchanged from original)                               */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/*  Layout constants — line + circle model                             */
/* ------------------------------------------------------------------ */

const DOT_R = 3          // dot radius
const DOT_GAP = 11       // vertical spacing between dots
const COL_W = 36          // horizontal spacing between session columns
const PAD_X = 14          // left/right padding
const PAD_Y = 10          // top/bottom padding
const MAX_DOTS = 8        // max dots shown per session (vertically compact)
const FORK_CURVE_R = 6    // radius for the fork connector curve
const LABEL_OFFSET_Y = 10 // gap below last dot for source label

/* ------------------------------------------------------------------ */
/*  Source labels (kept from original)                                  */
/* ------------------------------------------------------------------ */

const SOURCE_LABELS: Record<string, string> = {
  'claude-code': 'CC',
  codex: 'CDX',
  cursor: 'CUR',
  opencode: 'OC',
  zcode: 'ZC'
}

/* ------------------------------------------------------------------ */
/*  findFamily — BFS to find all connected sessions (unchanged logic)  */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/*  Line layout — assign columns and dot positions                     */
/* ------------------------------------------------------------------ */

interface LineNode {
  id: string
  col: number            // horizontal column index
  startY: number         // top of the line (first dot center Y)
  dots: number           // number of dots to render
  totalTurns: number     // actual turn count (may exceed dots)
  truncated: boolean     // whether dots < totalTurns
}

interface LineEdge {
  parentId: string
  childId: string
  type: string
  /** Dot index on the parent where the fork/continue happens */
  parentDotIdx: number
}

interface LineLayout {
  nodes: LineNode[]
  edges: LineEdge[]
  width: number
  height: number
}

function layoutLines(
  ids: Set<string>,
  relations: Relation[],
  sessions: Record<string, RegistrySession>,
  getTurnCount: (sid: string) => number
): LineLayout | null {
  const validIds = [...ids].filter((id) => sessions[id])
  if (validIds.length === 0) return null

  // Build adjacency
  const childrenMap = new Map<string, Array<{ childId: string; type: string }>>()
  const parentSet = new Set<string>()
  for (const r of relations) {
    if (!childrenMap.has(r.parent)) childrenMap.set(r.parent, [])
    childrenMap.get(r.parent)!.push({ childId: r.child, type: r.type })
    parentSet.add(r.child)
  }

  // Find root(s) — sessions with no parent
  const roots = validIds.filter((id) => !parentSet.has(id))
  if (roots.length === 0) roots.push(validIds[0])

  // DFS to assign columns and compute vertical positions
  const nodes: LineNode[] = []
  const edges: LineEdge[] = []
  let nextCol = 0
  const visited = new Set<string>()

  function dfs(sid: string, startY: number): void {
    if (visited.has(sid)) return
    visited.add(sid)

    const col = nextCol
    const totalTurns = Math.max(getTurnCount(sid), 1)
    const dots = Math.min(totalTurns, MAX_DOTS)
    const truncated = totalTurns > MAX_DOTS

    nodes.push({ id: sid, col, startY, dots, totalTurns, truncated })

    const children = childrenMap.get(sid) || []
    // Sort: continuations first (they stay in the same column conceptually),
    // then forks (branch to the right)
    const continuations = children.filter((c) => c.type === 'continuation')
    const forks = children.filter((c) => c.type !== 'continuation')

    // Continuations extend below this session
    const lineEndY = startY + (dots - 1) * DOT_GAP
    for (const cont of continuations) {
      if (visited.has(cont.childId)) continue
      const parentDotIdx = dots - 1 // continue from the last dot
      edges.push({ parentId: sid, childId: cont.childId, type: cont.type, parentDotIdx })
      dfs(cont.childId, lineEndY + DOT_GAP * 2) // gap then continue
    }

    // Forks branch to a new column
    for (const fork of forks) {
      if (visited.has(fork.childId)) continue
      // Estimate fork point: middle of the parent session
      const parentDotIdx = Math.max(0, Math.floor(dots / 2) - 1)
      const forkY = startY + parentDotIdx * DOT_GAP
      nextCol++
      edges.push({ parentId: sid, childId: fork.childId, type: fork.type, parentDotIdx })
      dfs(fork.childId, forkY)
    }
  }

  // Layout each root tree
  let globalStartY = PAD_Y
  for (const root of roots) {
    if (visited.has(root)) continue
    nextCol = 0
    dfs(root, globalStartY)
  }

  // Any unvisited sessions (cycles or disconnected) — add them
  for (const id of validIds) {
    if (!visited.has(id)) {
      nextCol++
      const totalTurns = Math.max(getTurnCount(id), 1)
      const dots = Math.min(totalTurns, MAX_DOTS)
      nodes.push({ id, col: nextCol, startY: PAD_Y, dots, totalTurns, truncated: totalTurns > MAX_DOTS })
    }
  }

  // Compute final dimensions
  const maxCol = Math.max(0, ...nodes.map((n) => n.col))
  const maxBottom = Math.max(
    0,
    ...nodes.map((n) => n.startY + (n.dots - 1) * DOT_GAP + LABEL_OFFSET_Y + 12)
  )

  return {
    nodes,
    edges,
    width: PAD_X * 2 + (maxCol + 1) * COL_W,
    height: maxBottom + PAD_Y
  }
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

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

  const getTurnCount = useCallback(
    (sid: string): number => {
      const s = storeSessions.find((ss) => ss.sessionId === sid)
      return s?.turnCount ?? 1
    },
    [storeSessions]
  )

  const layout = useMemo(() => {
    if (!registry) return null
    const { ids, relations } = findFamily(sessionId, registry)
    if (relations.length === 0) return null
    return layoutLines(ids, relations, registry.sessions, getTurnCount)
  }, [registry, sessionId, getTurnCount])

  const nodeMap = useMemo(() => {
    const m = new Map<string, LineNode>()
    if (layout) for (const n of layout.nodes) m.set(n.id, n)
    return m
  }, [layout])

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

  if (!layout || layout.nodes.length === 0) return null

  /** Convert column index to X center coordinate */
  const colX = (col: number) => PAD_X + col * COL_W + COL_W / 2

  /** Convert node + dot index to Y coordinate */
  const dotY = (node: LineNode, dotIdx: number) => node.startY + dotIdx * DOT_GAP

  const badge = `${layout.nodes.length} ${locale === 'zh-CN' ? '个会话' : 'sessions'}`

  return (
<<<<<<< HEAD
    <DisclosureSection
      title={locale === 'zh-CN' ? '关联会话' : 'Related Sessions'}
      icon={<GitBranch size={12} />}
      badge={badge}
      defaultOpen
    >
      <div
        className="overflow-x-auto overflow-y-auto rounded border border-edge bg-surface/30"
        style={{ maxHeight: 320 }}
      >
        <svg
          width={Math.max(layout.width, 80)}
          height={layout.height}
          className="block"
          style={{ minWidth: '100%' }}
        >
          {/* Edge connectors */}
          {layout.edges.map((edge, i) => {
            const parentNode = nodeMap.get(edge.parentId)
            const childNode = nodeMap.get(edge.childId)
            if (!parentNode || !childNode) return null

            const px = colX(parentNode.col)
            const py = dotY(parentNode, edge.parentDotIdx)
            const cx = colX(childNode.col)
            const cy = childNode.startY
=======
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
>>>>>>> fix/tf19-i18n-production-completion
            const isFork = edge.type === 'fork'

            if (parentNode.col === childNode.col) {
              // Same column — vertical connector (continuation)
              return (
                <line
                  key={i}
                  x1={px}
                  y1={py}
                  x2={cx}
                  y2={cy}
                  className="stroke-muted"
                  strokeWidth={1}
                  strokeDasharray="3 3"
                  opacity={0.5}
                />
              )
            }

            // Fork — horizontal then vertical with a curve
            const midX = cx
            const r = Math.min(FORK_CURVE_R, Math.abs(cx - px) / 2, Math.abs(cy - py) / 2 || FORK_CURVE_R)
            const dir = cx > px ? 1 : -1

            return (
              <path
                key={i}
                d={
                  isFork
                    ? `M${px},${py} L${midX - dir * r},${py} Q${midX},${py} ${midX},${py + r} L${midX},${cy}`
                    : `M${px},${py} C${px},${(py + cy) / 2} ${cx},${(py + cy) / 2} ${cx},${cy}`
                }
                fill="none"
                className={isFork ? 'stroke-soft-purple' : 'stroke-muted'}
                strokeWidth={1}
                strokeDasharray={isFork ? '4 2' : undefined}
                opacity={0.5}
              />
            )
          })}

          {/* Session lines and dots */}
          {layout.nodes.map((node) => {
            const isCurrent = node.id === sessionId
            const x = colX(node.col)
            const firstDotY = node.startY
            const lastDotY = dotY(node, node.dots - 1)
            const source = getSource(node.id)
            const title = getTitle(node.id)

            return (
              <g
                key={node.id}
                onClick={() => handleClick(node.id)}
                style={{ cursor: 'pointer' }}
                opacity={isCurrent ? 1 : 0.6}
              >
                {/* Vertical line through dots */}
                {node.dots > 1 && (
                  <line
                    x1={x}
                    y1={firstDotY}
                    x2={x}
                    y2={lastDotY}
                    className={isCurrent ? 'stroke-accent' : 'stroke-faint'}
                    strokeWidth={isCurrent ? 2 : 1}
                  />
                )}

                {/* Truncation indicator (dashed extension) */}
                {node.truncated && (
                  <line
                    x1={x}
                    y1={lastDotY}
                    x2={x}
                    y2={lastDotY + 8}
                    className={isCurrent ? 'stroke-accent' : 'stroke-faint'}
                    strokeWidth={1}
                    strokeDasharray="2 2"
                    opacity={0.5}
                  />
                )}

                {/* Dots */}
                {Array.from({ length: node.dots }, (_, di) => {
                  const dy = dotY(node, di)
                  return (
                    <circle
                      key={di}
                      cx={x}
                      cy={dy}
                      r={isCurrent ? DOT_R + 0.5 : DOT_R}
                      className={isCurrent ? 'fill-accent' : 'fill-faint'}
                    />
                  )
                })}

                {/* Source label below the line */}
                <text
                  x={x}
                  y={(node.truncated ? lastDotY + 8 : lastDotY) + LABEL_OFFSET_Y}
                  textAnchor="middle"
                  className={`text-[10px] font-semibold ${isCurrent ? 'fill-accent' : 'fill-muted'}`}
                >
                  {SOURCE_LABELS[source] || '?'}
                </text>

                {/* Hover title — rendered as SVG title for tooltip */}
                <title>
                  {title} ({node.totalTurns} {locale === 'zh-CN' ? '轮' : 'turns'})
                </title>
              </g>
            )
          })}
        </svg>
      </div>
    </DisclosureSection>
  )
}
