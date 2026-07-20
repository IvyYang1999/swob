import {
  Application,
  Container,
  Graphics,
  Particle,
  ParticleContainer,
  Text,
  Texture
} from 'pixi.js'
import {
  buildAdjacency,
  type GraphSource,
  type SessionGraphData,
  type SessionGraphNode,
  type WorkerRequest,
  type WorkerResponse
} from './graph-model'

export interface SessionGraphTheme {
  edge: number
  muted: number
  text: number
  surface: number
  continuation: number
  fork: number
  sourceColors: Record<GraphSource, number>
}

export interface HoverPoint {
  clientX: number
  clientY: number
}

interface SessionGraphRendererOptions {
  host: HTMLDivElement
  graph: SessionGraphData
  theme: SessionGraphTheme
  reducedMotion: boolean
  onHover: (node: SessionGraphNode | null, point: HoverPoint) => void
  onNodeClick: (node: SessionGraphNode) => void
  onFallback: (reason: string) => void
  onReady?: () => void
}

interface PointerInteraction {
  mode: 'node' | 'pan'
  pointerId: number
  nodeId?: string
  startX: number
  startY: number
  lastX: number
  lastY: number
  lastAt: number
  velocityX: number
  velocityY: number
  moved: boolean
}

const MIN_SCALE = 0.16
const MAX_SCALE = 5

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function createNodeTexture(): Texture {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  const context = canvas.getContext('2d')!
  const gradient = context.createRadialGradient(26, 24, 2, 32, 32, 30)
  gradient.addColorStop(0, 'rgba(255,255,255,1)')
  gradient.addColorStop(0.62, 'rgba(255,255,255,0.96)')
  gradient.addColorStop(1, 'rgba(255,255,255,0.65)')
  context.fillStyle = gradient
  context.beginPath()
  context.arc(32, 32, 29, 0, Math.PI * 2)
  context.fill()
  return Texture.from(canvas)
}

function projectName(project: string): string {
  if (!project) return ''
  const parts = project.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts[parts.length - 1] || project
}

export class SessionGraphRenderer {
  private readonly host: HTMLDivElement
  private readonly reducedMotion: boolean
  private readonly onHover: SessionGraphRendererOptions['onHover']
  private readonly onNodeClick: SessionGraphRendererOptions['onNodeClick']
  private readonly onFallback: SessionGraphRendererOptions['onFallback']
  private readonly onReady?: SessionGraphRendererOptions['onReady']

  private app: Application | null = null
  private root = new Container()
  private hullLayer = new Graphics()
  private edgeLayer = new Graphics()
  private highlightLayer = new Graphics()
  private labelLayer = new Container()
  private particleLayer: ParticleContainer<Particle> | null = null
  private particles: Particle[] = []
  private nodeTexture: Texture | null = null
  private graph: SessionGraphData
  private theme: SessionGraphTheme
  private adjacency = new Map<string, Set<string>>()
  private nodeIndex = new Map<string, number>()
  private positions: Float32Array
  private worker: Worker | null = null
  private hoveredId: string | null = null
  private labels = new Map<string, Text>()
  private topLabelIds: string[] = []
  private projectGroups: Array<{ project: string; indices: number[]; source: GraphSource }> = []
  private pointer: PointerInteraction | null = null
  private renderRequest = 0
  private inertiaRequest = 0
  private viewportRequest = 0
  private frameCount = 0
  private destroyed = false
  private canvas: HTMLCanvasElement | null = null

  constructor(options: SessionGraphRendererOptions) {
    this.host = options.host
    this.graph = options.graph
    this.theme = options.theme
    this.reducedMotion = options.reducedMotion
    this.onHover = options.onHover
    this.onNodeClick = options.onNodeClick
    this.onFallback = options.onFallback
    this.onReady = options.onReady
    this.positions = new Float32Array(this.graph.nodes.length * 2)
    this.indexGraph()
  }

  async init(): Promise<void> {
    try {
      const app = new Application()
      await app.init({
        resizeTo: this.host,
        preference: 'webgl',
        powerPreference: 'high-performance',
        antialias: true,
        autoDensity: true,
        resolution: Math.min(window.devicePixelRatio || 1, 2),
        backgroundAlpha: 0,
        autoStart: false,
        sharedTicker: false
      })
      if (this.destroyed) {
        app.destroy({ removeView: true }, { children: true, context: true })
        return
      }

      this.app = app
      app.ticker.stop()
      this.canvas = app.canvas
      this.canvas.className = 'session-graph-canvas'
      this.canvas.setAttribute('aria-label', 'Interactive session lineage graph')
      this.canvas.dataset.renderer = 'webgl'
      this.host.appendChild(this.canvas)

      this.root.addChild(this.hullLayer, this.edgeLayer)
      this.nodeTexture = createNodeTexture()
      this.particleLayer = new ParticleContainer({
        texture: this.nodeTexture,
        dynamicProperties: {
          position: true,
          color: true,
          rotation: false,
          vertex: false,
          uvs: false
        }
      })
      this.root.addChild(this.particleLayer, this.highlightLayer, this.labelLayer)
      app.stage.addChild(this.root)
      this.buildParticles()
      this.centerInitialViewport()
      this.updateViewportDataset()
      this.bindEvents()
      this.startWorker()
      this.requestRender()
      this.host.dataset.graphReady = 'true'
      this.onReady?.()
    } catch (error) {
      this.onFallback(error instanceof Error ? error.message : String(error))
    }
  }

  updateGraph(graph: SessionGraphData): void {
    const previousPositions = new Map<string, { x: number; y: number }>()
    for (let index = 0; index < this.graph.nodes.length; index++) {
      previousPositions.set(this.graph.nodes[index].id, {
        x: this.positions[index * 2],
        y: this.positions[index * 2 + 1]
      })
    }
    const sameNodes = graph.nodes.length === this.graph.nodes.length &&
      graph.nodes.every((node, index) => node.id === this.graph.nodes[index]?.id)
    this.graph = graph
    this.indexGraph()
    for (let index = 0; index < graph.nodes.length; index++) {
      const previous = previousPositions.get(graph.nodes[index].id)
      if (!previous) continue
      this.positions[index * 2] = previous.x
      this.positions[index * 2 + 1] = previous.y
    }
    if (!sameNodes) {
      this.rebuildParticles()
    }
    this.startWorker(sameNodes ? 0.28 : 0.55)
    this.requestRender()
  }

  setTheme(theme: SessionGraphTheme): void {
    this.theme = theme
    for (let index = 0; index < this.particles.length; index++) {
      this.particles[index].tint = theme.sourceColors[this.graph.nodes[index].source]
    }
    this.particleLayer?.update()
    this.rebuildLabels()
    this.requestRender()
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.worker?.postMessage({ type: 'stop' } satisfies WorkerRequest)
    this.worker?.terminate()
    this.worker = null
    cancelAnimationFrame(this.renderRequest)
    cancelAnimationFrame(this.inertiaRequest)
    cancelAnimationFrame(this.viewportRequest)
    this.unbindEvents()
    this.labels.clear()
    this.nodeTexture?.destroy(true)
    this.nodeTexture = null
    this.app?.destroy(
      { removeView: true },
      { children: true, texture: false, textureSource: false, context: true }
    )
    this.app = null
    this.canvas = null
    delete this.host.dataset.graphReady
    delete this.host.dataset.graphRenderer
    delete this.host.dataset.graphAlpha
    delete this.host.dataset.graphSettled
    delete this.host.dataset.graphHoverActive
    delete this.host.dataset.graphDraggingNode
    delete this.host.dataset.graphProbeX
    delete this.host.dataset.graphProbeY
    delete this.host.dataset.graphViewportAnimating
  }

  private indexGraph(): void {
    this.adjacency = buildAdjacency(this.graph)
    this.nodeIndex = new Map(this.graph.nodes.map((node, index) => [node.id, index]))
    this.positions = new Float32Array(this.graph.nodes.length * 2)
    for (let index = 0; index < this.graph.nodes.length; index++) {
      this.positions[index * 2] = this.graph.nodes[index].initialX
      this.positions[index * 2 + 1] = this.graph.nodes[index].initialY
    }
    this.topLabelIds = [...this.graph.nodes]
      .sort((a, b) => b.importance - a.importance || b.updatedAt - a.updatedAt)
      .map((node) => node.id)
    this.projectGroups = this.buildProjectGroups()
  }

  private buildProjectGroups(): Array<{ project: string; indices: number[]; source: GraphSource }> {
    const groups = new Map<string, number[]>()
    for (let index = 0; index < this.graph.nodes.length; index++) {
      const project = this.graph.nodes[index].project
      if (!project) continue
      const list = groups.get(project) || []
      list.push(index)
      groups.set(project, list)
    }
    return [...groups]
      .filter(([, indices]) => indices.length >= 3)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 24)
      .map(([project, indices]) => {
        const counts = new Map<GraphSource, number>()
        for (const index of indices) {
          const source = this.graph.nodes[index].source
          counts.set(source, (counts.get(source) || 0) + 1)
        }
        const source = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] || 'claude-code'
        return { project, indices, source }
      })
  }

  private buildParticles(): void {
    if (!this.particleLayer || !this.nodeTexture) return
    this.particles = this.graph.nodes.map((node, index) => {
      const diameterScale = node.radius * 2 / 64
      const particle = new Particle({
        texture: this.nodeTexture!,
        x: this.positions[index * 2],
        y: this.positions[index * 2 + 1],
        scaleX: diameterScale,
        scaleY: diameterScale,
        anchorX: 0.5,
        anchorY: 0.5,
        tint: this.theme.sourceColors[node.source],
        alpha: this.baseAlpha(node)
      })
      this.particleLayer!.addParticle(particle)
      return particle
    })
    this.particleLayer.update()
    this.rebuildLabels()
  }

  private rebuildParticles(): void {
    if (!this.particleLayer) return
    this.particleLayer.removeParticles(0, this.particleLayer.particleChildren.length)
    this.particles = []
    this.buildParticles()
  }

  private baseAlpha(node: SessionGraphNode): number {
    return 0.34 + node.recency * 0.58
  }

  private startWorker(alpha = 1): void {
    this.worker?.postMessage({ type: 'stop' } satisfies WorkerRequest)
    this.worker?.terminate()
    if (this.destroyed) return
    this.worker = new Worker(new URL('./graph.worker.ts', import.meta.url), { type: 'module', name: 'swob-session-graph' })
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data
      if (message.type === 'error') {
        console.error('[SessionGraphWorker]', message.message)
        return
      }
      const positions = new Float32Array(message.positions)
      if (positions.length !== this.graph.nodes.length * 2) return
      this.positions = positions
      for (let index = 0; index < this.particles.length; index++) {
        this.particles[index].x = positions[index * 2]
        this.particles[index].y = positions[index * 2 + 1]
      }
      this.host.dataset.graphAlpha = message.alpha.toFixed(4)
      this.host.dataset.graphSettled = String(message.settled)
      this.requestRender()
    }
    this.worker.onerror = (event) => {
      console.error('[SessionGraphWorker]', event.message)
      this.onFallback(`Worker failed: ${event.message}`)
    }
    const workerGraph: SessionGraphData = {
      edges: this.graph.edges,
      nodes: this.graph.nodes.map((node, index) => ({
        ...node,
        initialX: this.positions[index * 2],
        initialY: this.positions[index * 2 + 1]
      }))
    }
    const message: WorkerRequest = { type: 'init', graph: workerGraph, reducedMotion: this.reducedMotion, alpha }
    this.worker.postMessage(message)
  }

  private centerInitialViewport(): void {
    const width = Math.max(1, this.host.clientWidth)
    const height = Math.max(1, this.host.clientHeight)
    const scale = clamp(Math.min(width, height) / 900, 0.55, 1.05)
    this.root.position.set(width / 2, height / 2)
    this.root.scale.set(scale)
    this.updateViewportDataset()
  }

  private updateViewportDataset(): void {
    this.host.dataset.graphRenderer = 'webgl'
    this.host.dataset.graphScale = this.root.scale.x.toFixed(4)
    this.host.dataset.graphX = this.root.position.x.toFixed(2)
    this.host.dataset.graphY = this.root.position.y.toFixed(2)
  }

  private requestRender(): void {
    if (this.renderRequest || this.destroyed || !this.app) return
    this.renderRequest = requestAnimationFrame(() => {
      this.renderRequest = 0
      this.render()
    })
  }

  private render(): void {
    if (!this.app || this.destroyed) return
    this.frameCount++
    this.drawEdges()
    if (this.frameCount % 3 === 0 || this.frameCount < 4) this.drawProjectHulls()
    this.drawHighlight()
    this.updateLabelPositions()
    this.updateProbeDataset()
    this.app.render()
  }

  /** Screen-space position of one stable, non-sensitive E2E interaction probe. */
  private updateProbeDataset(): void {
    // Pick the lightest session so click-through tests do not benchmark transcript parsing.
    const id = this.topLabelIds[this.topLabelIds.length - 1]
    const index = id ? this.nodeIndex.get(id) : undefined
    if (index === undefined) return
    this.host.dataset.graphProbeX = (this.root.position.x + this.positions[index * 2] * this.root.scale.x).toFixed(2)
    this.host.dataset.graphProbeY = (this.root.position.y + this.positions[index * 2 + 1] * this.root.scale.y).toFixed(2)
  }

  private drawEdges(): void {
    const graphics = this.edgeLayer
    graphics.clear()
    const scale = this.root.scale.x || 1
    const hovered = this.hoveredId

    for (const type of ['continuation', 'fork'] as const) {
      for (const edge of this.graph.edges) {
        if (edge.type !== type) continue
        const sourceIndex = this.nodeIndex.get(edge.source)
        const targetIndex = this.nodeIndex.get(edge.target)
        if (sourceIndex === undefined || targetIndex === undefined) continue
        const x1 = this.positions[sourceIndex * 2]
        const y1 = this.positions[sourceIndex * 2 + 1]
        const x2 = this.positions[targetIndex * 2]
        const y2 = this.positions[targetIndex * 2 + 1]
        const incident = !hovered || edge.source === hovered || edge.target === hovered
        if (!incident) continue
        if (type === 'continuation') {
          graphics.moveTo(x1, y1).lineTo(x2, y2)
        } else {
          this.addDashedLine(graphics, x1, y1, x2, y2, 6 / scale, 4 / scale)
        }
      }
      graphics.stroke({
        color: type === 'fork' ? this.theme.fork : this.theme.continuation,
        alpha: hovered ? 0.62 : 0.36,
        width: (type === 'fork' ? 1.25 : 1.05) / scale
      })
    }

    if (hovered) {
      for (const edge of this.graph.edges) {
        if (edge.source === hovered || edge.target === hovered) continue
        const sourceIndex = this.nodeIndex.get(edge.source)
        const targetIndex = this.nodeIndex.get(edge.target)
        if (sourceIndex === undefined || targetIndex === undefined) continue
        graphics.moveTo(this.positions[sourceIndex * 2], this.positions[sourceIndex * 2 + 1])
          .lineTo(this.positions[targetIndex * 2], this.positions[targetIndex * 2 + 1])
      }
      graphics.stroke({ color: this.theme.edge, alpha: 0.04, width: 0.8 / scale })
    }
  }

  private addDashedLine(
    graphics: Graphics,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    dash: number,
    gap: number
  ): void {
    const dx = x2 - x1
    const dy = y2 - y1
    const distance = Math.hypot(dx, dy)
    if (distance === 0) return
    const ux = dx / distance
    const uy = dy / distance
    for (let offset = 0; offset < distance; offset += dash + gap) {
      const end = Math.min(distance, offset + dash)
      graphics.moveTo(x1 + ux * offset, y1 + uy * offset)
        .lineTo(x1 + ux * end, y1 + uy * end)
    }
  }

  private drawProjectHulls(): void {
    const graphics = this.hullLayer
    graphics.clear()
    const scale = this.root.scale.x || 1
    graphics.visible = scale < 1.35
    if (!graphics.visible) return

    for (const group of this.projectGroups) {
      let x = 0
      let y = 0
      for (const index of group.indices) {
        x += this.positions[index * 2]
        y += this.positions[index * 2 + 1]
      }
      x /= group.indices.length
      y /= group.indices.length
      let radius = 0
      for (const index of group.indices) {
        radius = Math.max(radius, Math.hypot(this.positions[index * 2] - x, this.positions[index * 2 + 1] - y))
      }
      radius += 16
      const color = this.theme.sourceColors[group.source]
      graphics.circle(x, y, radius).fill({ color, alpha: 0.007 })
      graphics.circle(x, y, radius).stroke({ color, alpha: 0.065, width: 0.7 / scale })
    }
  }

  private drawHighlight(): void {
    const graphics = this.highlightLayer
    graphics.clear()
    if (!this.hoveredId) return
    const index = this.nodeIndex.get(this.hoveredId)
    if (index === undefined) return
    const node = this.graph.nodes[index]
    const x = this.positions[index * 2]
    const y = this.positions[index * 2 + 1]
    const color = this.theme.sourceColors[node.source]
    graphics.circle(x, y, node.radius + 8 / this.root.scale.x).fill({ color, alpha: 0.13 })
    graphics.circle(x, y, node.radius + 3 / this.root.scale.x).stroke({
      color,
      alpha: 0.88,
      width: 1.2 / this.root.scale.x
    })
  }

  private rebuildLabels(): void {
    for (const text of this.labels.values()) text.destroy()
    this.labels.clear()
    this.labelLayer.removeChildren()
    this.syncLabels()
  }

  private syncLabels(): void {
    const scale = this.root.scale.x || 1
    const compact = this.host.clientWidth < 1_000
    const count = scale < 0.8 ? 0 : scale < 1.35 ? (compact ? 6 : 12) : scale < 2.2 ? (compact ? 14 : 28) : (compact ? 26 : 46)
    const visibleIds = new Set(this.topLabelIds.slice(0, count))
    if (this.hoveredId) visibleIds.add(this.hoveredId)

    for (const [id, text] of this.labels) {
      if (visibleIds.has(id)) continue
      this.labelLayer.removeChild(text)
      text.destroy()
      this.labels.delete(id)
    }
    for (const id of visibleIds) {
      if (this.labels.has(id)) continue
      const index = this.nodeIndex.get(id)
      if (index === undefined) continue
      const node = this.graph.nodes[index]
      const labelText = node.title.length > 26 ? `${node.title.slice(0, 26)}…` : node.title
      const label = new Text({
        text: labelText,
        style: {
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
          fontSize: 11,
          fontWeight: id === this.hoveredId ? '600' : '500',
          fill: this.theme.text,
          stroke: { color: this.theme.surface, width: 2.2, alpha: 0.88 },
          align: 'left'
        },
        resolution: Math.min(window.devicePixelRatio || 1, 2)
      })
      label.alpha = id === this.hoveredId ? 1 : 0.72
      this.labels.set(id, label)
      this.labelLayer.addChild(label)
    }
    this.updateLabelPositions()
  }

  private updateLabelPositions(): void {
    const scale = this.root.scale.x || 1
    const inverseScale = 1 / scale
    const width = this.host.clientWidth
    const height = this.host.clientHeight
    const placed: Array<{ left: number; right: number; top: number; bottom: number }> = []
    const entries = [...this.labels].sort(([first], [second]) =>
      first === this.hoveredId ? -1 : second === this.hoveredId ? 1 : 0)
    for (const [id, label] of entries) {
      const index = this.nodeIndex.get(id)
      if (index === undefined) continue
      const node = this.graph.nodes[index]
      label.scale.set(inverseScale)
      const worldX = this.positions[index * 2] + node.radius + 6 * inverseScale
      const worldY = this.positions[index * 2 + 1] - 7 * inverseScale
      const screenX = this.root.position.x + worldX * scale
      const screenY = this.root.position.y + worldY * scale
      const labelWidth = [...label.text].reduce((sum, character) =>
        sum + (character.charCodeAt(0) <= 0xff ? 6.3 : 11.2), 10)
      const bounds = { left: screenX, right: screenX + labelWidth, top: screenY - 3, bottom: screenY + 17 }
      const inViewport = bounds.right > 4 && bounds.left < width - 4 && bounds.bottom > 4 && bounds.top < height - 4
      const overlaps = placed.some((other) =>
        bounds.left < other.right + 6 && bounds.right > other.left - 6 &&
        bounds.top < other.bottom + 4 && bounds.bottom > other.top - 4)
      label.visible = id === this.hoveredId || (inViewport && !overlaps)
      if (!label.visible) continue
      label.position.set(worldX, worldY)
      placed.push(bounds)
    }
  }

  private updateHover(id: string | null, point: HoverPoint): void {
    if (this.hoveredId !== id) {
      this.hoveredId = id
      this.host.dataset.graphHoverActive = String(Boolean(id))
      const neighbors = id ? this.adjacency.get(id) || new Set<string>() : null
      for (let index = 0; index < this.graph.nodes.length; index++) {
        const node = this.graph.nodes[index]
        this.particles[index].alpha = !id
          ? this.baseAlpha(node)
          : node.id === id
            ? 1
            : neighbors!.has(node.id)
              ? Math.max(0.86, this.baseAlpha(node))
              : 0.1
      }
      this.syncLabels()
      this.requestRender()
    }
    const nodeIndex = id ? this.nodeIndex.get(id) : undefined
    this.onHover(nodeIndex === undefined ? null : this.graph.nodes[nodeIndex], point)
    if (this.canvas && !this.pointer) this.canvas.style.cursor = id ? 'pointer' : 'grab'
  }

  private findNode(clientX: number, clientY: number): SessionGraphNode | null {
    if (!this.canvas) return null
    const rect = this.canvas.getBoundingClientRect()
    const worldX = (clientX - rect.left - this.root.position.x) / this.root.scale.x
    const worldY = (clientY - rect.top - this.root.position.y) / this.root.scale.y
    let closest: SessionGraphNode | null = null
    let closestDistance = 12 / this.root.scale.x
    for (let index = 0; index < this.graph.nodes.length; index++) {
      const node = this.graph.nodes[index]
      const distance = Math.hypot(this.positions[index * 2] - worldX, this.positions[index * 2 + 1] - worldY)
      const hitRadius = Math.max(node.radius + 4 / this.root.scale.x, closestDistance)
      if (distance <= hitRadius && (!closest || distance < closestDistance)) {
        closest = node
        closestDistance = distance
      }
    }
    return closest
  }

  private screenToWorld(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas!.getBoundingClientRect()
    return {
      x: (clientX - rect.left - this.root.position.x) / this.root.scale.x,
      y: (clientY - rect.top - this.root.position.y) / this.root.scale.y
    }
  }

  private bindEvents(): void {
    const canvas = this.canvas!
    canvas.addEventListener('pointerdown', this.handlePointerDown)
    canvas.addEventListener('pointermove', this.handlePointerMove)
    canvas.addEventListener('pointerup', this.handlePointerUp)
    canvas.addEventListener('pointercancel', this.handlePointerUp)
    canvas.addEventListener('pointerleave', this.handlePointerLeave)
    canvas.addEventListener('wheel', this.handleWheel, { passive: false })
    canvas.addEventListener('dblclick', this.handleDoubleClick)
    canvas.addEventListener('webglcontextlost', this.handleContextLost)
    window.addEventListener('resize', this.handleResize)
  }

  private unbindEvents(): void {
    const canvas = this.canvas
    if (!canvas) return
    canvas.removeEventListener('pointerdown', this.handlePointerDown)
    canvas.removeEventListener('pointermove', this.handlePointerMove)
    canvas.removeEventListener('pointerup', this.handlePointerUp)
    canvas.removeEventListener('pointercancel', this.handlePointerUp)
    canvas.removeEventListener('pointerleave', this.handlePointerLeave)
    canvas.removeEventListener('wheel', this.handleWheel)
    canvas.removeEventListener('dblclick', this.handleDoubleClick)
    canvas.removeEventListener('webglcontextlost', this.handleContextLost)
    window.removeEventListener('resize', this.handleResize)
  }

  private handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || !this.canvas) return
    cancelAnimationFrame(this.inertiaRequest)
    cancelAnimationFrame(this.viewportRequest)
    this.host.dataset.graphViewportAnimating = 'false'
    const node = this.findNode(event.clientX, event.clientY)
    const now = performance.now()
    this.pointer = {
      mode: node ? 'node' : 'pan',
      pointerId: event.pointerId,
      nodeId: node?.id,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      lastAt: now,
      velocityX: 0,
      velocityY: 0,
      moved: false
    }
    this.canvas.setPointerCapture(event.pointerId)
    this.canvas.style.cursor = 'grabbing'
    if (node) {
      this.host.dataset.graphDraggingNode = 'true'
      const world = this.screenToWorld(event.clientX, event.clientY)
      this.worker?.postMessage({ type: 'drag-start', id: node.id, ...world } satisfies WorkerRequest)
    }
  }

  private handlePointerMove = (event: PointerEvent): void => {
    const interaction = this.pointer
    if (!interaction) {
      const node = this.findNode(event.clientX, event.clientY)
      this.updateHover(node?.id || null, { clientX: event.clientX, clientY: event.clientY })
      return
    }
    if (event.pointerId !== interaction.pointerId) return
    const dx = event.clientX - interaction.lastX
    const dy = event.clientY - interaction.lastY
    const distance = Math.hypot(event.clientX - interaction.startX, event.clientY - interaction.startY)
    interaction.moved ||= distance > 3
    const now = performance.now()
    const elapsed = Math.max(1, now - interaction.lastAt)

    if (interaction.mode === 'pan') {
      this.root.position.x += dx
      this.root.position.y += dy
      this.updateViewportDataset()
      interaction.velocityX = dx / elapsed * 16.67
      interaction.velocityY = dy / elapsed * 16.67
      this.requestRender()
    } else if (interaction.nodeId) {
      const world = this.screenToWorld(event.clientX, event.clientY)
      const index = this.nodeIndex.get(interaction.nodeId)
      if (index !== undefined) {
        this.positions[index * 2] = world.x
        this.positions[index * 2 + 1] = world.y
        this.particles[index].x = world.x
        this.particles[index].y = world.y
      }
      this.worker?.postMessage({ type: 'drag', id: interaction.nodeId, ...world } satisfies WorkerRequest)
      this.requestRender()
    }

    interaction.lastX = event.clientX
    interaction.lastY = event.clientY
    interaction.lastAt = now
  }

  private handlePointerUp = (event: PointerEvent): void => {
    const interaction = this.pointer
    if (!interaction || event.pointerId !== interaction.pointerId) return
    this.canvas?.releasePointerCapture(event.pointerId)
    this.pointer = null
    this.host.dataset.graphDraggingNode = 'false'

    if (interaction.mode === 'node' && interaction.nodeId) {
      this.worker?.postMessage({ type: 'drag-end', id: interaction.nodeId } satisfies WorkerRequest)
      if (!interaction.moved) {
        const index = this.nodeIndex.get(interaction.nodeId)
        if (index !== undefined) this.onNodeClick(this.graph.nodes[index])
      }
    } else if (!this.reducedMotion && interaction.moved) {
      this.startInertia(interaction.velocityX, interaction.velocityY)
    }
    if (this.canvas) this.canvas.style.cursor = this.hoveredId ? 'pointer' : 'grab'
  }

  private handlePointerLeave = (event: PointerEvent): void => {
    if (!this.pointer) this.updateHover(null, { clientX: event.clientX, clientY: event.clientY })
  }

  private handleWheel = (event: WheelEvent): void => {
    event.preventDefault()
    if (!this.canvas) return
    cancelAnimationFrame(this.inertiaRequest)
    cancelAnimationFrame(this.viewportRequest)
    this.host.dataset.graphViewportAnimating = 'false'
    const rect = this.canvas.getBoundingClientRect()
    const mouseX = event.clientX - rect.left
    const mouseY = event.clientY - rect.top
    const oldScale = this.root.scale.x
    const worldX = (mouseX - this.root.position.x) / oldScale
    const worldY = (mouseY - this.root.position.y) / oldScale
    const nextScale = clamp(oldScale * Math.exp(-event.deltaY * 0.0012), MIN_SCALE, MAX_SCALE)
    this.root.scale.set(nextScale)
    this.root.position.set(mouseX - worldX * nextScale, mouseY - worldY * nextScale)
    this.updateViewportDataset()
    this.syncLabels()
    this.requestRender()
  }

  private handleDoubleClick = (event: MouseEvent): void => {
    if (this.findNode(event.clientX, event.clientY)) return
    event.preventDefault()
    cancelAnimationFrame(this.inertiaRequest)
    this.fitAll(true)
  }

  private handleContextLost = (event: Event): void => {
    event.preventDefault()
    this.onFallback('WebGL context lost')
  }

  private handleResize = (): void => {
    this.requestRender()
  }

  private startInertia(velocityX: number, velocityY: number): void {
    cancelAnimationFrame(this.inertiaRequest)
    let vx = velocityX
    let vy = velocityY
    const step = () => {
      vx *= 0.91
      vy *= 0.91
      this.root.position.x += vx
      this.root.position.y += vy
      this.updateViewportDataset()
      this.requestRender()
      if (Math.hypot(vx, vy) > 0.08 && !this.destroyed) {
        this.inertiaRequest = requestAnimationFrame(step)
      }
    }
    this.inertiaRequest = requestAnimationFrame(step)
  }

  private fitAll(animate: boolean): void {
    if (!this.canvas || this.graph.nodes.length === 0) return
    let minX = Number.POSITIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY
    for (let index = 0; index < this.graph.nodes.length; index++) {
      const radius = this.graph.nodes[index].radius + 24
      minX = Math.min(minX, this.positions[index * 2] - radius)
      maxX = Math.max(maxX, this.positions[index * 2] + radius)
      minY = Math.min(minY, this.positions[index * 2 + 1] - radius)
      maxY = Math.max(maxY, this.positions[index * 2 + 1] + radius)
    }
    const rect = this.canvas.getBoundingClientRect()
    const scale = clamp(Math.min(rect.width / Math.max(1, maxX - minX), rect.height / Math.max(1, maxY - minY)) * 0.9, MIN_SCALE, 2.2)
    const targetX = rect.width / 2 - ((minX + maxX) / 2) * scale
    const targetY = rect.height / 2 - ((minY + maxY) / 2) * scale
    if (!animate || this.reducedMotion) {
      this.host.dataset.graphViewportAnimating = 'false'
      this.root.scale.set(scale)
      this.root.position.set(targetX, targetY)
      this.updateViewportDataset()
      this.syncLabels()
      this.requestRender()
      return
    }

    cancelAnimationFrame(this.viewportRequest)
    this.host.dataset.graphViewportAnimating = 'true'
    const startAt = performance.now()
    const startScale = this.root.scale.x
    const startX = this.root.position.x
    const startY = this.root.position.y
    const duration = 360
    const step = (now: number) => {
      const progress = clamp((now - startAt) / duration, 0, 1)
      const eased = 1 - Math.pow(1 - progress, 5)
      const nextScale = startScale + (scale - startScale) * eased
      this.root.scale.set(nextScale)
      this.root.position.set(startX + (targetX - startX) * eased, startY + (targetY - startY) * eased)
      this.updateViewportDataset()
      this.syncLabels()
      this.requestRender()
      if (progress < 1 && !this.destroyed) this.viewportRequest = requestAnimationFrame(step)
      else this.host.dataset.graphViewportAnimating = 'false'
    }
    this.viewportRequest = requestAnimationFrame(step)
  }
}

export function graphThemeFromCss(): SessionGraphTheme {
  const styles = getComputedStyle(document.documentElement)
  const value = (name: string, fallback: number): number => {
    const css = styles.getPropertyValue(name).trim()
    const match = css.match(/^#([0-9a-f]{6})$/i)
    return match ? Number.parseInt(match[1], 16) : fallback
  }
  return {
    edge: value('--color-edge', 0x3f3f46),
    muted: value('--color-muted', 0x71717a),
    text: value('--color-body', 0xd4d4d8),
    surface: value('--color-base', 0x18181b),
    continuation: value('--color-soft-blue', 0x5a9fd4),
    fork: value('--color-soft-purple', 0x8c72b8),
    sourceColors: {
      'claude-code': value('--color-soft-amber', 0xc49a4a),
      codex: value('--color-soft-blue', 0x5a9fd4),
      cursor: value('--color-soft-green', 0x4aad76),
      opencode: value('--color-soft-cyan', 0x4aacba),
      zcode: value('--color-soft-red', 0xcc6b6b)
    }
  }
}

export { projectName }
