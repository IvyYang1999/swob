import { useState, useRef, useEffect, useCallback } from 'react'
import { useStore } from '../../store'
import { useAnalysisScope, scopeBasisLabel, isPresetRange } from './scope'
import type { AnalysisPreset, AnalysisScope } from './scope'
import { formatTokenCount } from './shared'
import type { InsightsData } from './shared'

const TIME_PRESETS: Array<{ value: AnalysisPreset; zh: string; en: string }> = [
  { value: 'today', zh: '今日', en: 'Today' },
  { value: '7d', zh: '7d', en: '7d' },
  { value: '30d', zh: '30d', en: '30d' },
  { value: '90d', zh: '90d', en: '90d' },
  { value: 'all', zh: '全部', en: 'All' },
]

function TogglePill({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`px-2 py-0.5 rounded text-[11px] transition-colors ${
        active
          ? 'bg-accent/15 text-accent'
          : 'bg-hover text-muted hover:text-secondary'
      }`}
    >
      {label}
    </button>
  )
}

function Dropdown({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div ref={ref} className={`relative ${className || ''}`}>
      <button
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-1 px-2 py-0.5 rounded text-[11px] transition-colors ${
          open ? 'bg-accent/15 text-accent' : 'bg-hover text-muted hover:text-secondary'
        }`}
      >
        {label}
        <svg width="8" height="8" viewBox="0 0 8 8" className={`transition-transform ${open ? 'rotate-180' : ''}`}>
          <path d="M1 3l3 3 3-3" stroke="currentColor" strokeWidth="1.2" fill="none" />
        </svg>
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 z-20 min-w-[180px] max-h-[240px] overflow-y-auto rounded border border-edge bg-panel shadow-lg p-1">
          {children}
        </div>
      )}
    </div>
  )
}

export function FilterBar({ data }: { data: InsightsData }) {
  const locale = useStore((s) => s.locale)
  const zh = locale === 'zh-CN'
  const { scope, setScope, availableSources, availableModels, availableProjects } = useAnalysisScope()

  const [showCustomRange, setShowCustomRange] = useState(false)
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')

  const activePreset = isPresetRange(scope.range) ? scope.range : null

  const handlePresetClick = useCallback((preset: AnalysisPreset) => {
    setShowCustomRange(false)
    setScope({ ...scope, range: preset })
  }, [scope, setScope])

  const handleCustomRangeApply = useCallback(() => {
    if (!customFrom && !customTo) return
    setScope({
      ...scope,
      range: {
        from: customFrom || undefined,
        to: customTo || undefined,
      },
    })
  }, [scope, setScope, customFrom, customTo])

  const handleBasisToggle = useCallback((basis: 'billing' | 'conversation') => {
    setScope({ ...scope, metricBasis: basis })
  }, [scope, setScope])

  const toggleSource = useCallback((source: string) => {
    const current = scope.sources ?? []
    const next = current.includes(source)
      ? current.filter((s) => s !== source)
      : [...current, source] as AnalysisScope['sources']
    setScope({ ...scope, sources: next && next.length > 0 ? next : undefined })
  }, [scope, setScope])

  const toggleModel = useCallback((model: string) => {
    const current = scope.models ?? []
    const next = current.includes(model)
      ? current.filter((m) => m !== model)
      : [...current, model]
    setScope({ ...scope, models: next.length > 0 ? next : undefined })
  }, [scope, setScope])

  const selectProject = useCallback((proj: { kind: 'project' | 'folder'; key: string } | null) => {
    setScope({ ...scope, projectOrFolder: proj ?? undefined })
  }, [scope, setScope])

  const basisTotal = scope.metricBasis === 'conversation' ? data.conversationOnlyTokens : data.totalTokens

  const activeSourceCount = scope.sources?.length ?? 0
  const activeModelCount = scope.models?.length ?? 0
  const hasProject = !!scope.projectOrFolder

  return (
    <div className="sticky top-0 z-10 -mx-4 -mt-4 border-b border-edge bg-panel/95 px-4 py-2 backdrop-blur">
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        {/* Time presets */}
        <div className="flex overflow-hidden rounded border border-edge" role="group" aria-label={zh ? '时间范围' : 'Time range'}>
          {TIME_PRESETS.map((p) => (
            <button
              key={p.value}
              onClick={() => handlePresetClick(p.value)}
              aria-pressed={activePreset === p.value}
              className={`px-2 py-1 transition-colors ${
                activePreset === p.value
                  ? 'bg-accent/15 text-accent'
                  : 'text-muted hover:text-primary'
              }`}
            >
              {zh ? p.zh : p.en}
            </button>
          ))}
          <button
            onClick={() => setShowCustomRange(!showCustomRange)}
            aria-pressed={!activePreset && !showCustomRange}
            className={`px-2 py-1 transition-colors ${
              !activePreset ? 'bg-accent/15 text-accent' : 'text-muted hover:text-primary'
            }`}
          >
            {zh ? '自定义' : 'Custom'}
          </button>
        </div>

        {/* Custom date range inputs */}
        {showCustomRange && (
          <div className="flex items-center gap-1">
            <input
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="px-1.5 py-0.5 rounded bg-hover border border-edge text-[11px] text-primary"
            />
            <span className="text-muted">~</span>
            <input
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              className="px-1.5 py-0.5 rounded bg-hover border border-edge text-[11px] text-primary"
            />
            <button
              onClick={handleCustomRangeApply}
              className="px-2 py-0.5 rounded bg-accent/15 text-accent text-[11px] hover:bg-accent/25"
            >
              {zh ? '应用' : 'Apply'}
            </button>
          </div>
        )}

        {/* Divider */}
        <div className="w-px h-4 bg-edge" />

        {/* Source filter pills */}
        {availableSources.length > 0 && (
          <Dropdown
            label={`${zh ? '来源' : 'Source'}${activeSourceCount > 0 ? ` (${activeSourceCount})` : ''}`}
          >
            {availableSources.map((source) => (
              <label key={source} className="flex items-center gap-2 px-2 py-1 hover:bg-hover rounded cursor-pointer">
                <input
                  type="checkbox"
                  checked={scope.sources?.includes(source as any) ?? false}
                  onChange={() => toggleSource(source)}
                  className="rounded"
                />
                <span className="text-xs text-primary">{source}</span>
              </label>
            ))}
          </Dropdown>
        )}

        {/* Model filter pills */}
        {availableModels.length > 0 && (
          <Dropdown
            label={`${zh ? '模型' : 'Model'}${activeModelCount > 0 ? ` (${activeModelCount})` : ''}`}
          >
            {availableModels.map((model) => (
              <label key={model} className="flex items-center gap-2 px-2 py-1 hover:bg-hover rounded cursor-pointer">
                <input
                  type="checkbox"
                  checked={scope.models?.includes(model) ?? false}
                  onChange={() => toggleModel(model)}
                  className="rounded"
                />
                <span className="text-xs text-primary truncate">{model}</span>
              </label>
            ))}
          </Dropdown>
        )}

        {/* Project dropdown */}
        {availableProjects.length > 0 && (
          <Dropdown
            label={`${zh ? '项目' : 'Project'}${hasProject ? ' *' : ''}`}
          >
            <button
              onClick={() => selectProject(null)}
              className={`w-full text-left px-2 py-1 text-xs rounded hover:bg-hover ${
                !hasProject ? 'text-accent' : 'text-primary'
              }`}
            >
              {zh ? '全部项目' : 'All projects'}
            </button>
            {availableProjects.map((p) => (
              <button
                key={p.key}
                onClick={() => selectProject({ kind: p.kind, key: p.key })}
                className={`w-full text-left px-2 py-1 text-xs rounded truncate hover:bg-hover ${
                  scope.projectOrFolder?.key === p.key ? 'text-accent' : 'text-primary'
                }`}
                title={p.key}
              >
                {p.label}
              </button>
            ))}
          </Dropdown>
        )}

        {/* Divider */}
        <div className="w-px h-4 bg-edge" />

        {/* Basis toggle */}
        <div className="flex overflow-hidden rounded border border-edge" role="group" aria-label={zh ? '统计口径' : 'Token basis'}>
          {(['billing', 'conversation'] as const).map((basis) => (
            <button
              key={basis}
              onClick={() => handleBasisToggle(basis)}
              aria-pressed={scope.metricBasis === basis}
              className={`px-2 py-1 transition-colors ${
                scope.metricBasis === basis ? 'bg-accent/15 text-accent' : 'text-muted hover:text-primary'
              }`}
            >
              {basis === 'billing' ? (zh ? '计费口径' : 'Billing') : (zh ? '仅会话' : 'Conversation')}
            </button>
          ))}
        </div>

        <span className="text-muted">
          {scopeBasisLabel(scope, locale)} · {formatTokenCount(basisTotal)} tokens
        </span>

        {/* Active filter badges */}
        {(activeSourceCount > 0 || activeModelCount > 0 || hasProject) && (
          <button
            onClick={() => setScope({ ...scope, sources: undefined, models: undefined, projectOrFolder: undefined })}
            className="px-1.5 py-0.5 rounded text-[10px] text-red-400 bg-red-400/10 hover:bg-red-400/20"
          >
            {zh ? '清除筛选' : 'Clear filters'}
          </button>
        )}
      </div>
    </div>
  )
}
