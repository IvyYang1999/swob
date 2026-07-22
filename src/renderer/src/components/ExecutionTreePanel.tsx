import { translate } from '../i18n'
import { useState, useEffect, useMemo } from 'react'
import { useStore } from '../store'
import { Wrench, AlertTriangle, Zap, Bot } from 'lucide-react'
import { DisclosureSection } from './inspector'

/* ------------------------------------------------------------------ */
/*  Data types (unchanged)                                             */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/*  Semantic tool colors (using CSS variable approach where possible)   */
/* ------------------------------------------------------------------ */

const TOOL_COLORS: Record<string, string> = {
  Read: 'var(--color-soft-blue)',
  Write: 'var(--color-soft-green)',
  Edit: 'var(--color-soft-amber)',
  Bash: 'var(--color-soft-red)',
  Agent: 'var(--color-soft-purple)',
  Grep: 'var(--color-soft-cyan)',
  Glob: 'var(--color-soft-indigo)',
  Skill: 'var(--color-soft-pink)',
  TaskCreate: 'var(--color-soft-orange)',
  WebSearch: 'var(--color-soft-emerald)',
  WebFetch: 'var(--color-soft-blue)'
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/*  Sub-components                                                     */
/* ------------------------------------------------------------------ */

function ToolCallItem({ tc, locale }: { tc: ToolCall; locale: string }) {
  const color = TOOL_COLORS[tc.name] || 'var(--color-muted)'
  return (
    <div className="ml-4 border-l-2 border-edge pl-2 py-0.5">
      <div className="flex items-center gap-1.5 text-[11px] w-full text-left">
        <Wrench size={10} style={{ color }} />
        <span className="font-medium" style={{ color }}>{tc.name}</span>
        {tc.error && <AlertTriangle size={10} className="text-soft-red" />}
        {tc.durationMs != null && <span className="text-muted">{formatDuration(tc.durationMs)}</span>}
      </div>
      {tc.result && (
        <div className="ml-3 mt-0.5">
          <DisclosureSection
            title={locale === 'zh-CN' ? '原始输出' : 'Raw output'}
            defaultOpen={false}
          >
            <pre className="text-[10px] text-muted bg-surface/50 rounded p-1.5 overflow-x-auto max-h-[120px] overflow-y-auto whitespace-pre-wrap break-all">
              {tc.result.slice(0, 500)}
            </pre>
          </DisclosureSection>
        </div>
      )}
    </div>
  )
}

function AgentSpawnItem({ spawn, locale }: { spawn: AgentSpawn; locale: string }) {
  const statusClass =
    spawn.status === 'completed'
      ? 'text-soft-green'
      : spawn.status === 'failed'
        ? 'text-soft-red'
        : 'text-soft-amber'
  return (
    <div className="ml-4 border-l-2 border-soft-purple/30 pl-2 py-0.5">
      <div className="flex items-center gap-1.5 text-[11px] w-full text-left">
        <Bot size={10} className="text-soft-purple" />
        <span className="font-medium text-soft-purple">{spawn.subagentType}</span>
        <span className={`text-[10px] ${statusClass}`}>
          {spawn.status === 'completed' ? '✓' : spawn.status === 'failed' ? '✗' : '●'} {spawn.status}
        </span>
      </div>
      <div className="ml-5 text-[10px] text-muted truncate">{spawn.description}</div>
      {spawn.resultSummary && (
        <div className="ml-3 mt-0.5">
          <DisclosureSection
            title={locale === 'zh-CN' ? '原始输出' : 'Raw output'}
            defaultOpen={false}
          >
            <pre className="text-[10px] text-muted bg-surface/50 rounded p-1.5 overflow-x-auto max-h-[100px] overflow-y-auto whitespace-pre-wrap break-all">
              {spawn.resultSummary}
            </pre>
          </DisclosureSection>
        </div>
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
      <path d={path} fill="none" stroke="var(--color-soft-blue)" strokeWidth={1.5} opacity={0.7} />
      <path d={`${path} L${w},${h} L0,${h} Z`} fill="var(--color-soft-blue)" opacity={0.08} />
    </svg>
  )
}

/* ------------------------------------------------------------------ */
/*  Summary badge builder                                              */
/* ------------------------------------------------------------------ */

function buildSummaryBadge(tree: ExecutionTree, locale: string): string {
  const parts: string[] = []
  parts.push(`${tree.totalToolCalls} ${locale === 'zh-CN' ? '工具' : 'tools'}`)
  if (tree.totalAgentSpawns > 0) {
    parts.push(`${tree.totalAgentSpawns} ${locale === 'zh-CN' ? '子代理' : 'agents'}`)
  }
  if (tree.errors.length > 0) {
    parts.push(`${tree.errors.length} ${locale === 'zh-CN' ? '错误' : 'errors'}`)
  }
  return parts.join(' · ')
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export function ExecutionTreePanel({ filePath }: { filePath: string }) {
  const locale = useStore((s) => s.locale)
  const [tree, setTree] = useState<ExecutionTree | null>(null)
  const [loading, setLoading] = useState(true)

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
  const summaryBadge = buildSummaryBadge(tree, locale)

  // Error badge fragment for the DisclosureSection — shows error count prominently
  const badgeContent = tree.errors.length > 0
    ? <span>{summaryBadge.replace(
        `${tree.errors.length} ${locale === 'zh-CN' ? '错误' : 'errors'}`,
        ''
      ).replace(/\s*·\s*$/, '')}<span className="text-soft-red ml-1">{tree.errors.length} {locale === 'zh-CN' ? '错误' : 'err'}</span></span>
    : summaryBadge

  return (
<<<<<<< HEAD
    <DisclosureSection
      title={locale === 'zh-CN' ? '执行树' : 'Execution Tree'}
      icon={<Zap size={12} />}
      badge={badgeContent}
      defaultOpen={false}
    >
      <div className="space-y-3">
        {/* Tool breakdown bar */}
        <div className="flex gap-1 flex-wrap">
          {topTools.map(([name, count]) => (
            <span
              key={name}
              className="px-1.5 py-0.5 rounded text-[10px] font-medium"
              style={{
                backgroundColor: `color-mix(in srgb, ${TOOL_COLORS[name] || 'var(--color-muted)'} 12%, transparent)`,
                color: TOOL_COLORS[name] || 'var(--color-muted)'
              }}
            >
              {name} {count}
            </span>
          ))}
=======
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
>>>>>>> fix/tf19-i18n-production-completion
        </div>

        {/* Token timeline sparkline */}
        {tree.tokenTimeline.length > 2 && (
          <div>
            <div className="text-[10px] text-muted mb-1">
              {locale === 'zh-CN' ? 'Token 累计' : 'Cumulative tokens'}: {formatTokens(maxCum)}
            </div>
            <TokenBar timeline={tree.tokenTimeline} maxTokens={maxCum} />
          </div>
        )}

        {/* Errors */}
        {tree.errors.length > 0 && (
          <div className="space-y-1">
            <div className="text-[10px] font-medium text-soft-red flex items-center gap-1">
              <AlertTriangle size={10} />
              {tree.errors.length} {locale === 'zh-CN' ? '个错误' : 'errors'}
            </div>
            {tree.errors.slice(0, 5).map((err, i) => (
              <div key={i} className="text-[10px] text-soft-red/70 pl-4 truncate">
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
                <span className="text-muted text-[10px] w-6 text-right shrink-0">#{turn.index}</span>
                <span className="truncate flex-1">{turn.textPreview.slice(0, 60) || '(tool calls)'}</span>
                {turn.tokenUsage && (
                  <span className="text-muted text-[10px] shrink-0">
                    {formatTokens(turn.tokenUsage.inputTokens + turn.tokenUsage.outputTokens)}
                  </span>
                )}
              </div>
              {turn.agentSpawns.map((s) => <AgentSpawnItem key={s.id} spawn={s} locale={locale} />)}
              {turn.toolCalls.map((tc) => <ToolCallItem key={tc.id} tc={tc} locale={locale} />)}
            </div>
          ))}
          {assistantTurns.length > 50 && (
            <div className="text-[10px] text-muted text-center py-1">
              +{assistantTurns.length - 50} more turns
            </div>
          )}
        </div>
      </div>
    </DisclosureSection>
  )
}
