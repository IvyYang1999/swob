/// <reference lib="webworker" />

import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Force,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum
} from 'd3-force'
import {
  GRAPH_SOURCES,
  hashString,
  type GraphSource,
  type SessionGraphData,
  type SessionGraphNode,
  type WorkerRequest,
  type WorkerResponse
} from './graph-model'

interface SimulationNode extends SessionGraphNode, SimulationNodeDatum {
  x: number
  y: number
  vx: number
  vy: number
}

interface SimulationLink extends SimulationLinkDatum<SimulationNode> {
  source: string | SimulationNode
  target: string | SimulationNode
  type: 'fork' | 'continuation'
}

const FRAME_MS = 1000 / 60
const ALPHA_MIN = 0.001
const SOURCE_WELL_RADIUS = 290

const sourceCenters = new Map<GraphSource, { x: number; y: number }>(
  GRAPH_SOURCES.map((source, index) => {
    const angle = -Math.PI / 2 + index * (Math.PI * 2 / GRAPH_SOURCES.length)
    return [source, {
      x: Math.cos(angle) * SOURCE_WELL_RADIUS,
      y: Math.sin(angle) * SOURCE_WELL_RADIUS
    }]
  })
)

let nodes: SimulationNode[] = []
let nodeById = new Map<string, SimulationNode>()
let simulation: Simulation<SimulationNode, SimulationLink> | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let stopped = false

function groupedCentroidForce(
  keyOf: (node: SimulationNode) => string,
  strength: number,
  maxGroupSize = Number.POSITIVE_INFINITY
): Force<SimulationNode, undefined> {
  let forceNodes: SimulationNode[] = []

  const force = ((alpha: number) => {
    const sums = new Map<string, { x: number; y: number; count: number }>()
    for (const node of forceNodes) {
      const key = keyOf(node)
      if (!key) continue
      const current = sums.get(key) || { x: 0, y: 0, count: 0 }
      current.x += node.x
      current.y += node.y
      current.count++
      sums.set(key, current)
    }
    for (const node of forceNodes) {
      const key = keyOf(node)
      const sum = key ? sums.get(key) : undefined
      if (!sum || sum.count < 2 || sum.count > maxGroupSize) continue
      const x = sum.x / sum.count
      const y = sum.y / sum.count
      node.vx += (x - node.x) * strength * alpha
      node.vy += (y - node.y) * strength * alpha
    }
  }) as Force<SimulationNode, undefined>

  force.initialize = (nextNodes) => { forceNodes = nextNodes }
  return force
}

function dayKey(node: SimulationNode): string {
  return String(Math.floor(node.createdAt / 86_400_000))
}

function weekKey(node: SimulationNode): string {
  return String(Math.floor(node.createdAt / (86_400_000 * 7)))
}

function createSimulation(graph: SessionGraphData, reducedMotion: boolean, initialAlpha = 1): void {
  stopLoop()
  stopped = false
  nodes = graph.nodes.map((node) => {
    if (!reducedMotion) {
      return { ...node, x: node.initialX, y: node.initialY, vx: 0, vy: 0 }
    }
    const center = sourceCenters.get(node.source) || { x: 0, y: 0 }
    const projectAngle = (hashString(node.project || node.id) / 0xffffffff) * Math.PI * 2
    const projectRadius = 30 + (hashString(`${node.project}:distance`) / 0xffffffff) * 85
    return {
      ...node,
      x: center.x + Math.cos(projectAngle) * projectRadius + node.initialX,
      y: center.y + Math.sin(projectAngle) * projectRadius + node.initialY,
      vx: 0,
      vy: 0
    }
  })
  nodeById = new Map(nodes.map((node) => [node.id, node]))

  const links: SimulationLink[] = graph.edges.map((edge) => ({ ...edge }))
  const linkForce = forceLink<SimulationNode, SimulationLink>(links)
    .id((node) => node.id)
    .distance((link) => link.type === 'fork' ? 92 : 70)
    .strength((link) => link.type === 'fork' ? 0.13 : 0.2)

  simulation = forceSimulation<SimulationNode, SimulationLink>(nodes)
    .stop()
    .alpha(reducedMotion ? Math.min(initialAlpha, 0.16) : initialAlpha)
    .alphaTarget(0)
    .alphaDecay(0.02)
    .alphaMin(ALPHA_MIN)
    .velocityDecay(0.28)
    .force('charge', forceManyBody<SimulationNode>()
      .strength((node) => -34 - node.radius * 6)
      .distanceMin(5)
      .distanceMax(560)
      .theta(0.82))
    .force('collide', forceCollide<SimulationNode>()
      .radius((node) => node.radius + 2.4)
      .strength(0.82)
      .iterations(1))
    .force('lineage', linkForce)
    .force('source-x', forceX<SimulationNode>((node) => sourceCenters.get(node.source)?.x || 0).strength(0.085))
    .force('source-y', forceY<SimulationNode>((node) => sourceCenters.get(node.source)?.y || 0).strength(0.085))
    .force('project', groupedCentroidForce((node) => node.project, 0.024, 500))
    .force('same-day', groupedCentroidForce(dayKey, 0.006, 80))
    .force('same-week', groupedCentroidForce(weekKey, 0.0022, 360))
    .force('importance-x', forceX<SimulationNode>(0).strength((node) => node.importance * 0.007))
    .force('importance-y', forceY<SimulationNode>(0).strength((node) => node.importance * 0.007))

  postPositions(false)
  scheduleLoop()
}

function postPositions(settled: boolean): void {
  if (!simulation) return
  const positions = new Float32Array(nodes.length * 2)
  for (let index = 0; index < nodes.length; index++) {
    positions[index * 2] = nodes[index].x
    positions[index * 2 + 1] = nodes[index].y
  }
  const response: WorkerResponse = {
    type: 'positions',
    positions: positions.buffer,
    alpha: simulation.alpha(),
    settled
  }
  self.postMessage(response, { transfer: [positions.buffer] })
}

function scheduleLoop(): void {
  if (!simulation || stopped || timer) return
  timer = setTimeout(tick, 0)
}

function tick(): void {
  timer = null
  if (!simulation || stopped) return
  const startedAt = performance.now()
  simulation.tick(1)
  const settled = simulation.alpha() < ALPHA_MIN && simulation.alphaTarget() === 0
  postPositions(settled)
  if (settled) return
  timer = setTimeout(tick, Math.max(0, FRAME_MS - (performance.now() - startedAt)))
}

function stopLoop(): void {
  if (timer) clearTimeout(timer)
  timer = null
}

function reheat(alpha = 0.42): void {
  if (!simulation) return
  simulation.alpha(Math.max(simulation.alpha(), alpha)).alphaTarget(0)
  scheduleLoop()
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  try {
    const message = event.data
    if (message.type === 'init') {
      createSimulation(message.graph, message.reducedMotion, message.alpha)
      return
    }
    if (message.type === 'stop') {
      stopped = true
      stopLoop()
      simulation?.stop()
      return
    }
    if (message.type === 'reheat') {
      reheat(message.alpha)
      return
    }

    const node = nodeById.get(message.id)
    if (!node || !simulation) return
    if (message.type === 'drag-start') {
      node.fx = message.x
      node.fy = message.y
      node.x = message.x
      node.y = message.y
      simulation.alpha(Math.max(simulation.alpha(), 0.42)).alphaTarget(0.24)
      scheduleLoop()
    } else if (message.type === 'drag') {
      node.fx = message.x
      node.fy = message.y
      node.x = message.x
      node.y = message.y
      scheduleLoop()
    } else if (message.type === 'drag-end') {
      node.fx = null
      node.fy = null
      simulation.alphaTarget(0)
      reheat(0.3)
    }
  } catch (error) {
    const response: WorkerResponse = {
      type: 'error',
      message: error instanceof Error ? error.message : String(error)
    }
    self.postMessage(response)
  }
}

export {}
