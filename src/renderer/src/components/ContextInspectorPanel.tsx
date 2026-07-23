import { translate } from '../i18n'
import { useState, useEffect, useMemo } from 'react'
import { useStore } from '../store'
import { Activity, ChevronDown, ChevronRight, AlertTriangle, Layers } from 'lucide-react'

type ContextCategory =
  | 'user-text' | 'assistant-text' | 'tool-input' | 'tool-output'
  | 'system-injection' | 'thinking' | 'image' | 'compact-summary' | 'unknown'

interface ContextSlice {
  category: ContextCategory
  tokens: number
  provenance: 'reported' | 'estimated'
}

interface TurnContext {
  turnIndex: number
  role: 'user' | 'assistant'
  timestamp: string
  slices: ContextSlice[]
  totalTokens: number
  cumulativeTokens: number
  isCompactBoundary: boolean
}

interface ContextInspectorData {
  sessionId: string
  turns: TurnContext[]
  peakTokens: number
  compactEvents: Array<{ turnIndex: number; tokensBefore: number; tokensAfter: number }>
  warnings: Array<{ turnIndex: number; type: string; message: string }>
  categoryTotals: Record<ContextCategory, number>
}

const CATEGORY_COLORS: Record<ContextCategory, string> = {
  'user-text': 'var(--color-soft-blue)',
  'assistant-text': 'var(--color-soft-green)',
  'tool-input': 'var(--color-soft-amber)',
  'tool-output': 'var(--color-soft-red)',
  'system-injection': 'var(--color-soft-purple)',
  thinking: 'var(--color-soft-pink)',
  image: 'var(--color-soft-cyan)',
  'compact-summary': 'var(--color-muted)',
  unknown: 'var(--color-faint)'
}

const CATEGORY_LABELS: Record<ContextCategory, string> = {
  'user-text': 'User',
  'assistant-text': 'Assistant',
  'tool-input': 'Tool Input',
  'tool-output': 'Tool Output',
  'system-injection': 'System',
  thinking: 'Thinking',
  image: 'Images',
  'compact-summary': 'Compact',
  unknown: 'Other'
}

function formatTokens(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

function CategoryBar({ totals }: { totals: Record<ContextCategory, number> }) {
  const total = Object.values(totals).reduce((a, b) => a + b, 0)
  if (total === 0) return null
  const entries = (Object.entries(totals) as [ContextCategory, number][])
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])

  return (
    <div>
      <div className="flex h-3 rounded overflow-hidden mb-2">
        {entries.map(([cat, tokens]) => (
          <div
            key={cat}
            style={{ width: `${(tokens / total) * 100}%`, backgroundColor: CATEGORY_COLORS[cat] }}
            title={`${CATEGORY_LABELS[cat]}: ${formatTokens(tokens)} (${Math.round((tokens / total) * 100)}%)`}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {entries.slice(0, 6).map(([cat, tokens]) => (
          <div key={cat} className="flex items-center gap-1 text-[10px]">
            <span className="w-2 h-2 rounded-sm shrink-0" style={{ backgroundColor: CATEGORY_COLORS[cat] }} />
            <span className="text-muted">{CATEGORY_LABELS[cat]}</span>
            <span className="text-secondary">{formatTokens(tokens)}</span>
            <span className="text-faint">({Math.round((tokens / total) * 100)}%)</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function PressureChart({ turns, peak }: { turns: TurnContext[]; peak: number }) {
  if (turns.length < 3) return null
  const w = 200
  const h = 50

  const assistantTurns = turns.filter(t => t.role === 'assistant' && t.totalTokens > 0)
  if (assistantTurns.length < 2) return null

  const points = assistantTurns.map((t, i) => ({
    x: (i / Math.max(assistantTurns.length - 1, 1)) * w,
    y: h - (t.cumulativeTokens / Math.max(peak, 1)) * h,
    isCompact: t.isCompactBoundary
  }))

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ')

  return (
    <div>
      <div className="text-[10px] text-muted mb-1 flex justify-between">
        <span>Context Pressure</span>
        <span>Peak: {formatTokens(peak)}</span>
      </div>
      <svg width={w} height={h} className="block">
        <path d={`${linePath} L${w},${h} L0,${h} Z`} fill="var(--color-soft-amber)" opacity={0.08} />
        <path d={linePath} fill="none" stroke="var(--color-soft-amber)" strokeWidth={1.5} opacity={0.7} />
        {points.filter(p => p.isCompact).map((p, i) => (
          <line key={i} x1={p.x} y1={0} x2={p.x} y2={h} stroke="var(--color-soft-purple)" strokeWidth={1} strokeDasharray="2 2" opacity={0.5} />
        ))}
      </svg>
    </div>
  )
}

export function ContextInspectorPanel({ filePath }: { filePath: string }) {
  const locale = useStore((s) => s.locale)
  const [data, setData] = useState<ContextInspectorData | null>(null)
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    window.api.getContextInspector(filePath).then((result: ContextInspectorData | null) => {
      if (!cancelled) { setData(result); setLoading(false) }
    }).catch(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [filePath])

  const hasContent = data && data.turns.length > 0

  if (loading || !hasContent) return null

  return (
    <section>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-xs font-medium text-soft-amber mb-2 w-full text-left hover:text-primary"
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Activity size={12} />
        <span>{translate(locale, 'renderer.context_inspector_panel.context_inspector')}</span>
        <span className="text-muted text-[10px] ml-auto">
          peak {formatTokens(data!.peakTokens)}
          {data!.compactEvents.length > 0 && ` · ${data!.compactEvents.length} compacts`}
          {data!.warnings.length > 0 && ` · ${data!.warnings.length} ⚠️`}
        </span>
      </button>

      {expanded && (
        <div className="space-y-3">
          {/* Category breakdown */}
          <CategoryBar totals={data!.categoryTotals} />

          {/* Pressure chart */}
          <PressureChart turns={data!.turns} peak={data!.peakTokens} />

          {/* Compact events */}
          {data!.compactEvents.length > 0 && (
            <div>
              <div className="text-[10px] font-medium text-soft-purple flex items-center gap-1 mb-1">
                <Layers size={10} />
                {data!.compactEvents.length} compact {translate(locale, 'renderer.context_inspector_panel.events')}
              </div>
              {data!.compactEvents.map((e, i) => (
                <div key={i} className="text-[10px] text-muted pl-4">
                  Turn {e.turnIndex}: {formatTokens(e.tokensBefore)} → {formatTokens(e.tokensAfter)}
                  <span className="text-soft-emerald ml-1">
                    (−{formatTokens(Math.max(0, e.tokensBefore - e.tokensAfter))})
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Warnings */}
          {data!.warnings.length > 0 && (
            <div>
              <div className="text-[10px] font-medium text-soft-amber flex items-center gap-1 mb-1">
                <AlertTriangle size={10} />
                {data!.warnings.length} {translate(locale, 'renderer.context_inspector_panel.warnings')}
              </div>
              {data!.warnings.slice(0, 8).map((w, i) => (
                <div key={i} className="text-[10px] text-soft-amber/60 pl-4 truncate">
                  T{w.turnIndex}: {w.message}
                </div>
              ))}
            </div>
          )}

          {/* Data provenance note */}
          <div className="text-[9px] text-faint border-t border-edge pt-2">
            {translate(locale, 'renderer.context_inspector_panel.turns_with_api_usage_data_use_reported_tokens')}
          </div>
        </div>
      )}
    </section>
  )
}
