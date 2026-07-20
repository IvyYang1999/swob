export const GRAPH_SOURCES = ['claude-code', 'codex', 'cursor', 'opencode', 'zcode'] as const

export type GraphSource = (typeof GRAPH_SOURCES)[number]
export type LineageEdgeType = 'fork' | 'continuation'

export const SOURCE_LABELS: Record<GraphSource, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  zcode: 'Zcode'
}

export interface GraphSessionInput {
  id: string
  sessionId: string
  source?: GraphSource
  projectPath?: string
  firstUserMessage?: string
  turnCount: number
  compactCount: number
  createdAt: string
  updatedAt?: string
  cwds?: string[]
  tokenUsage?: {
    totalTokens?: number
    inputTokens?: number
    outputTokens?: number
    cacheCreationTokens?: number
    cacheReadTokens?: number
  }
}

export interface LineageRegistryInput {
  relations?: Array<{
    parent: string
    child: string
    type: string
  }>
}

export interface SessionGraphNode {
  id: string
  sessionId: string
  source: GraphSource
  project: string
  title: string
  turnCount: number
  totalTokens: number
  compactCount: number
  createdAt: number
  updatedAt: number
  recency: number
  cwd: string
  radius: number
  importance: number
  initialX: number
  initialY: number
}

export interface SessionGraphEdge {
  source: string
  target: string
  type: LineageEdgeType
}

export interface SessionGraphData {
  nodes: SessionGraphNode[]
  edges: SessionGraphEdge[]
}

export type WorkerRequest =
  | { type: 'init'; graph: SessionGraphData; reducedMotion: boolean; alpha?: number }
  | { type: 'reheat'; alpha?: number }
  | { type: 'drag-start'; id: string; x: number; y: number }
  | { type: 'drag'; id: string; x: number; y: number }
  | { type: 'drag-end'; id: string }
  | { type: 'stop' }

export type WorkerResponse =
  | { type: 'positions'; positions: ArrayBuffer; alpha: number; settled: boolean }
  | { type: 'error'; message: string }

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function hashString(value: string): number {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/** Small deterministic seed cloud used for the opening expansion. */
export function deterministicInitialPosition(id: string): { x: number; y: number } {
  const first = hashString(id)
  const second = hashString(`${id}:radius`)
  const angle = (first / 0xffffffff) * Math.PI * 2
  const radius = 5 + (second / 0xffffffff) * 21
  return {
    x: Math.cos(angle) * radius,
    y: Math.sin(angle) * radius
  }
}

export function totalTokensOf(session: GraphSessionInput): number {
  const usage = session.tokenUsage
  if (!usage) return 0
  if (Number.isFinite(usage.totalTokens)) return Math.max(0, usage.totalTokens || 0)
  return Math.max(0,
    (usage.inputTokens || 0) +
    (usage.outputTokens || 0) +
    (usage.cacheCreationTokens || 0) +
    (usage.cacheReadTokens || 0)
  )
}

export function computeNodeRadius(turnCount: number, totalTokens: number, compactCount: number): number {
  const turnSize = Math.log1p(Math.max(0, turnCount)) * 0.72
  const tokenBoost = Math.min(2.1, Math.log1p(Math.max(0, totalTokens)) / 7)
  const compactBoost = Math.min(1.2, Math.max(0, compactCount) * 0.28)
  return clamp(1.35 + turnSize + tokenBoost + compactBoost, 2.2, 8)
}

function normalizeSource(source?: GraphSource): GraphSource {
  return source && GRAPH_SOURCES.includes(source) ? source : 'claude-code'
}

function parseTime(value: string | undefined, fallback: number): number {
  const parsed = value ? new Date(value).getTime() : Number.NaN
  return Number.isFinite(parsed) ? parsed : fallback
}

/**
 * Converts UI summaries and the lineage registry into a truth-preserving graph.
 * Project/source/time affinity belongs to forces and hulls, never to edges.
 */
export function buildSessionGraph(
  sessions: GraphSessionInput[],
  registry: LineageRegistryInput | null,
  now = Date.now()
): SessionGraphData {
  const activeSessions = sessions.filter((s) => s.turnCount > 0)
  const nodes = activeSessions.map((session): SessionGraphNode => {
    const source = normalizeSource(session.source)
    const createdAt = parseTime(session.createdAt, now)
    const updatedAt = parseTime(session.updatedAt, createdAt)
    const ageDays = Math.max(0, (now - updatedAt) / 86_400_000)
    const recency = clamp(1 - ageDays / 180, 0, 1)
    const totalTokens = totalTokensOf(session)
    const radius = computeNodeRadius(session.turnCount, totalTokens, session.compactCount)
    const initial = deterministicInitialPosition(session.id || session.sessionId)
    return {
      id: session.id || session.sessionId,
      sessionId: session.sessionId,
      source,
      project: session.projectPath || '',
      title: session.firstUserMessage?.trim().replace(/\s+/g, ' ').slice(0, 120) || session.sessionId.slice(0, 12),
      turnCount: session.turnCount,
      totalTokens,
      compactCount: session.compactCount || 0,
      createdAt,
      updatedAt,
      recency,
      cwd: session.cwds?.[0] || '',
      radius,
      importance: clamp((radius - 2.2) / 5.8, 0, 1),
      initialX: initial.x,
      initialY: initial.y
    }
  })

  const exactIds = new Map(nodes.map((node) => [node.id, node]))
  const sessionIds = new Map<string, SessionGraphNode[]>()
  for (const node of nodes) {
    const list = sessionIds.get(node.sessionId) || []
    list.push(node)
    sessionIds.set(node.sessionId, list)
  }

  const resolve = (reference: string): SessionGraphNode | undefined => {
    const exact = exactIds.get(reference)
    if (exact) return exact
    const candidates = sessionIds.get(reference)
    // Ambiguous intra-session branches are intentionally not guessed.
    return candidates?.length === 1 ? candidates[0] : undefined
  }

  const seen = new Set<string>()
  const edges: SessionGraphEdge[] = []
  for (const relation of registry?.relations || []) {
    if (relation.type !== 'fork' && relation.type !== 'continuation') continue
    const source = resolve(relation.parent)
    const target = resolve(relation.child)
    if (!source || !target || source.id === target.id) continue
    const key = `${source.id}\u0000${target.id}\u0000${relation.type}`
    if (seen.has(key)) continue
    seen.add(key)
    edges.push({ source: source.id, target: target.id, type: relation.type })
  }

  return { nodes, edges }
}

export function buildAdjacency(graph: SessionGraphData): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>()
  for (const node of graph.nodes) adjacency.set(node.id, new Set())
  for (const edge of graph.edges) {
    adjacency.get(edge.source)?.add(edge.target)
    adjacency.get(edge.target)?.add(edge.source)
  }
  return adjacency
}

export function resolveSessionForGraphNode<T extends { id: string; sessionId: string }>(
  sessions: T[],
  node: Pick<SessionGraphNode, 'id' | 'sessionId'>
): T | undefined {
  return sessions.find((session) => session.id === node.id) ||
    sessions.find((session) => session.sessionId === node.sessionId)
}
