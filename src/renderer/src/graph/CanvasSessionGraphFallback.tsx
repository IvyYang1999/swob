import { useCallback, useEffect, useMemo, useRef } from 'react'
import {
  buildAdjacency,
  type SessionGraphData,
  type SessionGraphNode,
  type WorkerRequest,
  type WorkerResponse
} from './graph-model'
import type { HoverPoint } from './SessionGraphRenderer'

interface CanvasSessionGraphFallbackProps {
  graph: SessionGraphData
  reducedMotion: boolean
  preview?: boolean
  onHover: (node: SessionGraphNode | null, point: HoverPoint) => void
  onNodeClick: (node: SessionGraphNode) => void
}

interface Viewport {
  x: number
  y: number
  scale: number
}

interface DragState {
  mode: 'node' | 'pan'
  nodeId?: string
  lastX: number
  lastY: number
  moved: boolean
}

function cssColor(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

export function CanvasSessionGraphFallback({
  graph,
  reducedMotion,
  preview = false,
  onHover,
  onNodeClick
}: CanvasSessionGraphFallbackProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const workerRef = useRef<Worker | null>(null)
  const positionsRef = useRef(new Float32Array(graph.nodes.flatMap((node) => [node.initialX, node.initialY])))
  const viewportRef = useRef<Viewport>({ x: 0, y: 0, scale: 1 })
  const dragRef = useRef<DragState | null>(null)
  const hoverRef = useRef<string | null>(null)
  const frameRef = useRef(0)
  const indexById = useMemo(() => new Map(graph.nodes.map((node, index) => [node.id, index])), [graph])
  const adjacency = useMemo(() => buildAdjacency(graph), [graph])

  const draw = useCallback(() => {
    if (frameRef.current) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0
      const canvas = canvasRef.current
      if (!canvas) return
      const context = canvas.getContext('2d')
      if (!context) return
      const rect = canvas.getBoundingClientRect()
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const width = Math.max(1, Math.round(rect.width * dpr))
      const height = Math.max(1, Math.round(rect.height * dpr))
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
      }
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      context.clearRect(0, 0, rect.width, rect.height)

      const viewport = viewportRef.current
      context.save()
      context.translate(rect.width / 2 + viewport.x, rect.height / 2 + viewport.y)
      context.scale(viewport.scale, viewport.scale)

      const hovered = hoverRef.current
      for (const edge of graph.edges) {
        const source = indexById.get(edge.source)
        const target = indexById.get(edge.target)
        if (source === undefined || target === undefined) continue
        const relevant = !hovered || edge.source === hovered || edge.target === hovered
        context.beginPath()
        context.moveTo(positionsRef.current[source * 2], positionsRef.current[source * 2 + 1])
        context.lineTo(positionsRef.current[target * 2], positionsRef.current[target * 2 + 1])
        context.strokeStyle = edge.type === 'fork'
          ? cssColor('--color-soft-purple', '#8c72b8')
          : cssColor('--color-soft-blue', '#5a9fd4')
        context.globalAlpha = relevant ? 0.48 : 0.05
        context.lineWidth = 1 / viewport.scale
        context.setLineDash(edge.type === 'fork' ? [6 / viewport.scale, 4 / viewport.scale] : [])
        context.stroke()
      }
      context.setLineDash([])

      const neighbors = hovered ? adjacency.get(hovered) : undefined
      graph.nodes.forEach((node, index) => {
        const colorName = node.source === 'claude-code' ? '--color-soft-amber'
          : node.source === 'codex' ? '--color-soft-blue'
            : node.source === 'cursor' ? '--color-soft-green'
              : node.source === 'opencode' ? '--color-soft-cyan'
                : '--color-soft-red'
        context.fillStyle = cssColor(colorName, '#94a3b8')
        context.globalAlpha = !hovered
          ? 0.34 + node.recency * 0.58
          : node.id === hovered ? 1 : neighbors?.has(node.id) ? 0.88 : 0.1
        context.beginPath()
        context.arc(positionsRef.current[index * 2], positionsRef.current[index * 2 + 1], node.radius, 0, Math.PI * 2)
        context.fill()
      })

      if (hovered) {
        const index = indexById.get(hovered)
        if (index !== undefined) {
          const node = graph.nodes[index]
          context.globalAlpha = 0.18
          context.fillStyle = cssColor('--color-bright', '#f4f4f5')
          context.beginPath()
          context.arc(positionsRef.current[index * 2], positionsRef.current[index * 2 + 1], node.radius + 7 / viewport.scale, 0, Math.PI * 2)
          context.fill()
        }
      }
      context.restore()
      context.globalAlpha = 1
      if (canvas.parentElement) {
        canvas.parentElement.dataset.graphFirstFrame = 'true'
        if (!canvas.parentElement.dataset.graphFirstFrameMs) {
          const openedAt = Number((window as any).__swobGraphOpenAt)
          if (Number.isFinite(openedAt)) {
            canvas.parentElement.dataset.graphFirstFrameMs = (performance.now() - openedAt).toFixed(2)
          }
        }
      }
    })
  }, [adjacency, graph, indexById])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    viewportRef.current.scale = Math.max(0.55, Math.min(1.05, Math.min(rect.width, rect.height) / 900))

    const worker = new Worker(new URL('./graph.worker.ts', import.meta.url), { type: 'module', name: 'swob-session-graph-canvas' })
    workerRef.current = worker
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      if (event.data.type !== 'positions') return
      positionsRef.current = new Float32Array(event.data.positions)
      draw()
    }
    worker.postMessage({ type: 'init', graph, reducedMotion } satisfies WorkerRequest)
    const observer = new ResizeObserver(draw)
    observer.observe(canvas)
    draw()
    return () => {
      observer.disconnect()
      worker.postMessage({ type: 'stop' } satisfies WorkerRequest)
      worker.terminate()
      workerRef.current = null
      cancelAnimationFrame(frameRef.current)
    }
  }, [draw, graph, reducedMotion])

  const findNode = useCallback((clientX: number, clientY: number): SessionGraphNode | null => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    const viewport = viewportRef.current
    const x = (clientX - rect.left - rect.width / 2 - viewport.x) / viewport.scale
    const y = (clientY - rect.top - rect.height / 2 - viewport.y) / viewport.scale
    let closest: SessionGraphNode | null = null
    let distance = 12 / viewport.scale
    graph.nodes.forEach((node, index) => {
      const candidate = Math.hypot(positionsRef.current[index * 2] - x, positionsRef.current[index * 2 + 1] - y)
      if (candidate < Math.max(distance, node.radius + 4 / viewport.scale) && (!closest || candidate < distance)) {
        closest = node
        distance = candidate
      }
    })
    return closest
  }, [graph.nodes])

  const toWorld = useCallback((clientX: number, clientY: number) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    const viewport = viewportRef.current
    return {
      x: (clientX - rect.left - rect.width / 2 - viewport.x) / viewport.scale,
      y: (clientY - rect.top - rect.height / 2 - viewport.y) / viewport.scale
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      className="session-graph-canvas"
      aria-label="Interactive session lineage graph (Canvas fallback)"
      data-renderer={preview ? 'canvas-preview' : 'canvas-fallback'}
      data-graph-preview={preview ? 'true' : 'false'}
      onPointerDown={(event) => {
        const node = findNode(event.clientX, event.clientY)
        dragRef.current = { mode: node ? 'node' : 'pan', nodeId: node?.id, lastX: event.clientX, lastY: event.clientY, moved: false }
        event.currentTarget.setPointerCapture(event.pointerId)
        event.currentTarget.style.cursor = 'grabbing'
        if (node) workerRef.current?.postMessage({ type: 'drag-start', id: node.id, ...toWorld(event.clientX, event.clientY) } satisfies WorkerRequest)
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current
        if (drag) {
          const dx = event.clientX - drag.lastX
          const dy = event.clientY - drag.lastY
          drag.moved ||= Math.hypot(dx, dy) > 2
          if (drag.mode === 'pan') {
            viewportRef.current.x += dx
            viewportRef.current.y += dy
          } else if (drag.nodeId) {
            workerRef.current?.postMessage({ type: 'drag', id: drag.nodeId, ...toWorld(event.clientX, event.clientY) } satisfies WorkerRequest)
          }
          drag.lastX = event.clientX
          drag.lastY = event.clientY
          draw()
          return
        }
        const node = findNode(event.clientX, event.clientY)
        hoverRef.current = node?.id || null
        event.currentTarget.style.cursor = node ? 'pointer' : 'grab'
        onHover(node, { clientX: event.clientX, clientY: event.clientY })
        draw()
      }}
      onPointerUp={(event) => {
        const drag = dragRef.current
        dragRef.current = null
        event.currentTarget.style.cursor = hoverRef.current ? 'pointer' : 'grab'
        if (drag?.nodeId) {
          workerRef.current?.postMessage({ type: 'drag-end', id: drag.nodeId } satisfies WorkerRequest)
          if (!drag.moved) {
            const index = indexById.get(drag.nodeId)
            if (index !== undefined) onNodeClick(graph.nodes[index])
          }
        }
      }}
      onPointerLeave={(event) => {
        if (!dragRef.current) {
          hoverRef.current = null
          onHover(null, { clientX: event.clientX, clientY: event.clientY })
          draw()
        }
      }}
      onWheel={(event) => {
        event.preventDefault()
        const rect = event.currentTarget.getBoundingClientRect()
        const viewport = viewportRef.current
        const mouseX = event.clientX - rect.left - rect.width / 2
        const mouseY = event.clientY - rect.top - rect.height / 2
        const worldX = (mouseX - viewport.x) / viewport.scale
        const worldY = (mouseY - viewport.y) / viewport.scale
        const next = Math.max(0.16, Math.min(5, viewport.scale * Math.exp(-event.deltaY * 0.0012)))
        viewport.x = mouseX - worldX * next
        viewport.y = mouseY - worldY * next
        viewport.scale = next
        draw()
      }}
    />
  )
}
