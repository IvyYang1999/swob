import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GitBranch, MousePointer2 } from 'lucide-react'
import { useStore } from '../store'
import {
  buildSessionGraph,
  GRAPH_SOURCES,
  SOURCE_LABELS,
  resolveSessionForGraphNode,
  type GraphSessionInput,
  type GraphSource,
  type LineageRegistryInput,
  type SessionGraphNode
} from '../graph/graph-model'
import {
  graphThemeFromCss,
  SessionGraphRenderer,
  type HoverPoint
} from '../graph/SessionGraphRenderer'
import { CanvasSessionGraphFallback } from '../graph/CanvasSessionGraphFallback'

interface HoverState {
  node: SessionGraphNode
  point: HoverPoint
}

function formatDate(timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1)}m`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
  return String(tokens)
}

function sourceCssColor(source: GraphSource): string {
  const variable = source === 'claude-code' ? '--color-soft-amber'
    : source === 'codex' ? '--color-soft-blue'
      : source === 'cursor' ? '--color-soft-green'
        : source === 'opencode' ? '--color-soft-cyan'
          : '--color-soft-red'
  return `var(${variable})`
}

export function LineagePage() {
  const sessions = useStore((state) => state.sessions)
  const theme = useStore((state) => state.theme)
  const locale = useStore((state) => state.locale)
  const selectSession = useStore((state) => state.selectSession)
  const toggleLineage = useStore((state) => state.toggleLineage)
  const hostRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<SessionGraphRenderer | null>(null)
  const sessionsRef = useRef(sessions)
  const selectSessionRef = useRef(selectSession)
  const toggleLineageRef = useRef(toggleLineage)
  const [registry, setRegistry] = useState<LineageRegistryInput | null>(null)
  const [hover, setHover] = useState<HoverState | null>(null)
  const [fallbackReason, setFallbackReason] = useState<string | null>(null)
  const [reducedMotion, setReducedMotion] = useState(false)
  const [pixiReady, setPixiReady] = useState(false)

  const baseGraph = useMemo(
    () => buildSessionGraph(sessions as unknown as GraphSessionInput[], null),
    [sessions]
  )
  const graph = useMemo(
    () => buildSessionGraph(sessions as unknown as GraphSessionInput[], registry),
    [registry, sessions]
  )
  const graphRef = useRef(graph)
  graphRef.current = graph
  sessionsRef.current = sessions
  selectSessionRef.current = selectSession
  toggleLineageRef.current = toggleLineage

  const sourceCounts = useMemo(() => {
    const counts = new Map<GraphSource, number>(GRAPH_SOURCES.map((source) => [source, 0]))
    for (const node of baseGraph.nodes) counts.set(node.source, (counts.get(node.source) || 0) + 1)
    return counts
  }, [baseGraph.nodes])

  const handleHover = useCallback((node: SessionGraphNode | null, point: HoverPoint) => {
    setHover(node ? { node, point } : null)
  }, [])

  const handleNodeClick = useCallback((node: SessionGraphNode) => {
    const session = resolveSessionForGraphNode(sessionsRef.current, node)
    if (!session) return
    toggleLineageRef.current()
    void selectSessionRef.current(
      session.filePath,
      session.allFilePaths,
      session.id,
      session.branchParentFilePaths,
      session.branchPointUuid,
      session.branchLeafUuid
    )
  }, [])

  useEffect(() => {
    let active = true
    window.api.getLineageRegistry()
      .then((result) => { if (active) setRegistry(result as LineageRegistryInput | null) })
      .catch(() => { if (active) setRegistry(null) })
    return () => { active = false }
  }, [])

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReducedMotion(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    const host = hostRef.current
    if (!host || fallbackReason) return
    let launchFrame = 0
    let secondLaunchFrame = 0
    setPixiReady(false)
    const renderer = new SessionGraphRenderer({
      host,
      graph: graphRef.current,
      theme: graphThemeFromCss(),
      reducedMotion,
      onHover: handleHover,
      onNodeClick: handleNodeClick,
      onFallback: (reason) => setFallbackReason(reason),
      onReady: () => setPixiReady(true)
    })
    rendererRef.current = renderer
    // Canvas owns the first paint; initialize WebGL only after that frame is safely visible.
    launchFrame = requestAnimationFrame(() => {
      secondLaunchFrame = requestAnimationFrame(() => { void renderer.init() })
    })
    return () => {
      cancelAnimationFrame(launchFrame)
      cancelAnimationFrame(secondLaunchFrame)
      renderer.destroy()
      rendererRef.current = null
    }
  }, [fallbackReason, handleHover, handleNodeClick, reducedMotion])

  useEffect(() => {
    rendererRef.current?.updateGraph(graph)
  }, [graph])

  useEffect(() => {
    rendererRef.current?.setTheme(graphThemeFromCss())
  }, [theme])

  const tooltipLeft = hover ? Math.min(hover.point.clientX + 14, window.innerWidth - 330) : 0
  const tooltipTop = hover ? Math.min(Math.max(8, hover.point.clientY - 12), window.innerHeight - 150) : 0

  return (
    <section className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden relative bg-base" aria-label={locale === 'zh-CN' ? '会话图谱' : 'Session Galaxy'}>
      <header className="flex items-center gap-x-4 gap-y-2 px-4 py-2 border-b border-edge text-xs text-secondary shrink-0 flex-wrap">
        <h1 className="text-sm font-medium text-primary flex items-center gap-1.5">
          <GitBranch size={14} />
          {locale === 'zh-CN' ? '会话图谱' : 'Session Galaxy'}
        </h1>
        {GRAPH_SOURCES.map((source) => {
          const count = sourceCounts.get(source) || 0
          if (count === 0) return null
          return (
            <div key={source} className="flex items-center gap-1.5">
              <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: sourceCssColor(source) }} />
              <span>{SOURCE_LABELS[source]}</span>
              <span className="text-muted tabular-nums">{count}</span>
            </div>
          )
        })}
        <div className="ml-auto flex items-center gap-2 text-muted tabular-nums">
          <span>{graph.edges.length} {locale === 'zh-CN' ? '条真实关系' : 'verified edges'}</span>
          <span aria-hidden="true">·</span>
          <span>{sessions.length} sessions</span>
          <span className="px-1.5 py-0.5 rounded bg-surface text-faint">
            {fallbackReason ? 'Canvas2D' : 'WebGL · Worker'}
          </span>
        </div>
      </header>

      <div
        ref={hostRef}
        className="session-graph-host flex-1 min-h-0 relative overflow-hidden outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-soft-purple"
        tabIndex={0}
        onKeyDown={(event) => { if (event.key === 'Escape') toggleLineage() }}
      >
        {(fallbackReason || !pixiReady) && (
          <CanvasSessionGraphFallback
            graph={graph}
            reducedMotion={reducedMotion}
            preview={!fallbackReason}
            onHover={handleHover}
            onNodeClick={handleNodeClick}
          />
        )}
        <div className="absolute z-10 left-3 bottom-3 flex items-center gap-1.5 text-[11px] text-faint bg-base/80 px-2 py-1 rounded pointer-events-none select-none">
          <MousePointer2 size={11} />
          {locale === 'zh-CN'
            ? '滚轮缩放 · 拖拽平移 · 拖动节点 · 双击空白复位'
            : 'Wheel to zoom · drag to pan · drag nodes · double-click to fit'}
        </div>
      </div>

      {hover && (
        <div
          className="fixed z-50 w-[310px] px-3 py-2.5 rounded-lg border border-edge bg-base shadow-xl text-xs pointer-events-none"
          style={{ left: tooltipLeft, top: tooltipTop }}
          role="tooltip"
        >
          <div className="flex items-center gap-2 mb-1.5">
            <span className="inline-block w-2 h-2 rounded-full" style={{ background: sourceCssColor(hover.node.source) }} />
            <span className="font-medium text-body">{SOURCE_LABELS[hover.node.source]}</span>
            <span className="text-faint ml-auto">{formatDate(hover.node.createdAt)}</span>
          </div>
          <div className="text-primary leading-5 line-clamp-2 mb-1.5">{hover.node.title}</div>
          <div className="text-muted flex flex-wrap gap-x-2 gap-y-0.5 tabular-nums">
            <span>{hover.node.turnCount} {locale === 'zh-CN' ? '轮' : 'turns'}</span>
            <span>{formatTokens(hover.node.totalTokens)} tokens</span>
            <span>{hover.node.compactCount} compact</span>
          </div>
          {hover.node.cwd && <div className="text-faint truncate mt-1" title={hover.node.cwd}>{hover.node.cwd}</div>}
        </div>
      )}
    </section>
  )
}
