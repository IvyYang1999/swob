import { translate } from '../i18n'
import { useState, useEffect, useMemo } from 'react'
import { useStore } from '../store'
import { GitBranch, Wrench, AlertTriangle, ChevronDown, ChevronRight, Zap, Bot } from 'lucide-react'

interface ToolCall {
  id: string
  name: string
  timestamp: string
  result?: string
  error?: boolean
  durationMs?: number
}

interface AgentSpawn {
  id: string
  description: string
  subagentType: string
  status: 'running' | 'completed' | 'failed' | 'unknown'
  resultSummary?: string
  timestamp: string
}

interface TurnInfo {
  index: number
  role: 'user' | 'assistant'
  timestamp: string
  textPreview: string
  toolCalls: ToolCall[]
  agentSpawns: AgentSpawn[]
  tokenUsage?: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
  }
  cumulativeTokens: number
}

interface ExecutionTree {
  sessionId: string
  turns: TurnInfo[]
  totalToolCalls: number
  totalAgentSpawns: number
  toolCallsByName: Record<string, number>
  errors: Array<{ turnIndex: number; toolName: string; message: string }>
  tokenTimeline: Array<{ turnIndex: number; cumulative: number; delta: number }>
}

const TOOL_COLORS: Record<string, string> = {
  Read: '#3b82f6',
  Write: '#22c55e',
  Edit: '#f59e0b',
  Bash: '#ef4444',
  Agent: '#a78bfa',
  Grep: '#06b6d4',
  Glob: '#8b5cf6',
  Skill: '#ec4899',
  TaskCreate: '#f97316',
  WebSearch: '#14b8a6',
  WebFetch: '#0ea5e9'
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

function formatTokens(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

function ToolCallItem({ tc }: { tc: ToolCall }) {
  const [open, setOpen] = useState(false)
  const color = TOOL_COLORS[tc.name] || '#6b7280'
  return (
    <div className="ml-4 border-l-2 border-edge pl-2 py-0.5">
      <button onClick={() => setOpen(!open)} className="flex items-center gap-1.5 text-[11px] hover:text-primary w-full text-left">
        {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        <Wrench size={10} style={{ color }} />
        <span className="font-medium" style={{ color }}>{tc.name}</span>
        {tc.error && <AlertTriangle size={10} className="text-red-400" />}
        {tc.durationMs != null && <span className="text-muted">{formatDuration(tc.durationMs)}</span>}
      </button>
      {open && tc.result && (
        <pre className="mt-1 ml-5 text-[10px] text-muted bg-surface/50 rounded p-1.5 overflow-x-auto max-h-[120px] overflow-y-auto whitespace-pre-wrap break-all">
          {tc.result.slice(0, 500)}
        </pre>
      )}
    </div>
  )
}

function AgentSpawnItem({ spawn }: { spawn: AgentSpawn }) {
  const [open, setOpen] = useState(false)
  const statusColor = spawn.status === 'completed' ? 'text-green-400' : spawn.status === 'failed' ? 'text-red-400' : 'text-yellow-400'
  return (
    <div className="ml-4 border-l-2 border-soft-purple/30 pl-2 py-0.5">
      <button onClick={() => setOpen(!open)} className="flex items-center gap-1.5 text-[11px] hover:text-primary w-full text-left">
        {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        <Bot size={10} className="text-soft-purple" />
        <span className="font-medium text-soft-purple">{spawn.subagentType}</span>
        <span className={`text-[9px] ${statusColor}`}>● {spawn.status}</span>
      </button>
      <div className="ml-5 text-[10px] text-muted truncate">{spawn.description}</div>
      {open && spawn.resultSummary && (
        <pre className="mt-1 ml-5 text-[10px] text-muted bg-surface/50 rounded p-1.5 overflow-x-auto max-h-[100px] overflow-y-auto whitespace-pre-wrap break-all">
          {spawn.resultSummary}
        </pre>
      )}
    </div>
  )
}

function TokenBar({ timeline, maxTokens }: { timeline: ExecutionTree['tokenTimeline']; maxTokens: number }) {
  if (timeline.length === 0) return null
  const w = 200
  const h = 40
  const points = timeline.map((t, i) => ({
    x: (i / Math.max(timeline.length - 1, 1)) * w,
    y: h - (t.cumulative / Math.max(maxTokens, 1)) * h
  }))
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ')
  return (
    <svg width={w} height={h} className="block">
      <path d={path} fill="none" stroke="var(--color-soft-blue, #60a5fa)" strokeWidth={1.5} opacity={0.7} />
      <path d={`${path} L${w},${h} L0,${h} Z`} fill="var(--color-soft-blue, #60a5fa)" opacity={0.08} />
    </svg>
  )
}

export function ExecutionTreePanel({ filePath }: { filePath: string }) {
  const locale = useStore((s) => s.locale)
  const [tree, setTree] = useState<ExecutionTree | null>(null)
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    window.api.getExecutionTree(filePath).then((data: ExecutionTree | null) => {
      if (!cancelled) { setTree(data); setLoading(false) }
    }).catch(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [filePath])

  const assistantTurns = useMemo(() =>
    tree?.turns.filter(t => t.role === 'assistant' && (t.toolCalls.length > 0 || t.agentSpawns.length > 0)) || [],
    [tree]
  )

  const topTools = useMemo(() => {
    if (!tree) return []
    return Object.entries(tree.toolCallsByName)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
  }, [tree])

  if (loading) return null
  if (!tree || tree.totalToolCalls === 0) return null

  const maxCum = tree.tokenTimeline.length > 0 ? tree.tokenTimeline[tree.tokenTimeline.length - 1].cumulative : 0

  return (
    <section>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-xs font-medium text-soft-blue mb-2 w-full text-left hover:text-primary"
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Zap size={12} />
        <span>{translate(locale, 'renderer.execution_tree_panel.execution_tree')}</span>
        <span className="text-muted text-[10px] ml-auto">
          {tree.totalToolCalls} tools · {tree.totalAgentSpawns > 0 ? `${tree.totalAgentSpawns} agents · ` : ''}
          {tree.errors.length > 0 ? `${tree.errors.length} errors` : ''}
        </span>
      </button>

      {expanded && (
        <div className="space-y-3">
          {/* Tool breakdown bar */}
          <div className="flex gap-1 flex-wrap">
            {topTools.map(([name, count]) => (
              <span
                key={name}
                className="px-1.5 py-0.5 rounded text-[10px] font-medium"
                style={{
                  backgroundColor: `${TOOL_COLORS[name] || '#6b7280'}15`,
                  color: TOOL_COLORS[name] || '#6b7280'
                }}
              >
                {name} {count}
              </span>
            ))}
          </div>

          {/* Token timeline sparkline */}
          {tree.tokenTimeline.length > 2 && (
            <div>
              <div className="text-[10px] text-muted mb-1">
                {translate(locale, 'renderer.execution_tree_panel.cumulative_tokens')}: {formatTokens(maxCum)}
              </div>
              <TokenBar timeline={tree.tokenTimeline} maxTokens={maxCum} />
            </div>
          )}

          {/* Errors */}
          {tree.errors.length > 0 && (
            <div className="space-y-1">
              <div className="text-[10px] font-medium text-red-400 flex items-center gap-1">
                <AlertTriangle size={10} />
                {tree.errors.length} {translate(locale, 'renderer.execution_tree_panel.errors')}
              </div>
              {tree.errors.slice(0, 5).map((err, i) => (
                <div key={i} className="text-[10px] text-red-300/70 pl-4 truncate">
                  Turn {err.turnIndex}: {err.toolName} — {err.message.slice(0, 80)}
                </div>
              ))}
            </div>
          )}

          {/* Execution timeline (collapsible turns) */}
          <div className="max-h-[300px] overflow-y-auto space-y-0.5">
            {assistantTurns.slice(0, 50).map((turn) => (
              <div key={turn.index} className="text-[11px]">
                <div className="flex items-center gap-1.5 text-secondary">
                  <span className="text-muted text-[9px] w-6 text-right shrink-0">#{turn.index}</span>
                  <span className="truncate flex-1">{turn.textPreview.slice(0, 60) || '(tool calls)'}</span>
                  {turn.tokenUsage && (
                    <span className="text-muted text-[9px] shrink-0">
                      {formatTokens(turn.tokenUsage.inputTokens + turn.tokenUsage.outputTokens)}
                    </span>
                  )}
                </div>
                {turn.agentSpawns.map((s) => <AgentSpawnItem key={s.id} spawn={s} />)}
                {turn.toolCalls.map((tc) => <ToolCallItem key={tc.id} tc={tc} />)}
              </div>
            ))}
            {assistantTurns.length > 50 && (
              <div className="text-[10px] text-muted text-center py-1">
                +{assistantTurns.length - 50} more turns
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
