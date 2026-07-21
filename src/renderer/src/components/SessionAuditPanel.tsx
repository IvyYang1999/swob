import { useState, useEffect } from 'react'
import { useStore } from '../store'
import { Shield, ChevronDown, ChevronRight, AlertTriangle, CheckCircle, XCircle, Info } from 'lucide-react'

interface AuditMetric<T> {
  value: T
  provenance: 'reported' | 'estimated' | 'unavailable'
}

interface SessionAuditResult {
  sessionId: string
  readEditRatio: AuditMetric<number>
  readEditHealth: 'healthy' | 'degraded' | 'critical' | 'unavailable'
  thinkingDepth: AuditMetric<{ avgSignatureLength: number; redactedCount: number; totalBlocks: number }>
  latencyStats: AuditMetric<{ p50: number; p95: number; max: number }>
  estimatedCost: AuditMetric<{ inputCost: number; outputCost: number; totalCost: number; currency: string }>
  visibleFrameworkMarkers: AuditMetric<{
    estimatedMarkerTokens: number
    estimatedVisibleUserTokens: number
    shareOfVisibleUserText: number
  }>
  antiPatterns: Array<{ type: string; turnIndex: number; detail: string }>
  frustrationSignals: Array<{ type: string; turnIndex: number; text: string }>
  healthScore: number
  healthLabel: 'excellent' | 'good' | 'fair' | 'poor'
  findings: string[]
}

function ProvenanceBadge({ p }: { p: string }) {
  const colors = {
    reported: 'text-soft-emerald bg-soft-emerald/10',
    estimated: 'text-soft-amber bg-soft-amber/10',
    unavailable: 'text-faint bg-surface'
  }
  return <span className={`px-1 py-0.5 rounded text-[8px] ${colors[p as keyof typeof colors] || colors.unavailable}`}>{p}</span>
}

function HealthBadge({ score, label }: { score: number; label: string }) {
  const color = score >= 80 ? 'text-soft-emerald' : score >= 60 ? 'text-soft-blue' : score >= 40 ? 'text-soft-amber' : 'text-red-400'
  const Icon = score >= 60 ? CheckCircle : score >= 40 ? AlertTriangle : XCircle
  return (
    <div className={`flex items-center gap-1.5 ${color}`}>
      <Icon size={14} />
      <span className="text-sm font-bold">{score}</span>
      <span className="text-[10px] uppercase">{label}</span>
    </div>
  )
}

function MetricRow({ label, value, unit, provenance, health }: {
  label: string; value: string | number; unit?: string; provenance?: string
  health?: 'healthy' | 'degraded' | 'critical' | 'unavailable'
}) {
  const healthColor = health === 'healthy' ? 'text-soft-emerald' : health === 'degraded' ? 'text-soft-amber' : health === 'critical' ? 'text-red-400' : 'text-muted'
  return (
    <div className="flex items-center justify-between text-[11px] py-1">
      <span className="text-muted">{label}</span>
      <div className="flex items-center gap-1.5">
        <span className={health ? healthColor : 'text-primary font-medium'}>{value}{unit && <span className="text-muted ml-0.5">{unit}</span>}</span>
        {provenance && <ProvenanceBadge p={provenance} />}
      </div>
    </div>
  )
}

export function SessionAuditPanel({ filePath }: { filePath: string }) {
  const locale = useStore((s) => s.locale)
  const [audit, setAudit] = useState<SessionAuditResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    window.api.auditSession(filePath).then((data: SessionAuditResult | null) => {
      if (!cancelled) { setAudit(data); setLoading(false) }
    }).catch(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [filePath])

  if (loading || !audit) return null

  const formatMs = (ms: number) => ms >= 60000 ? `${(ms / 60000).toFixed(1)}m` : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
  const formatCost = (n: number) => n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`

  return (
    <section>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-xs font-medium text-soft-emerald mb-2 w-full text-left hover:text-primary"
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Shield size={12} />
        <span>{locale === 'zh-CN' ? '会话审计' : 'Session Audit'}</span>
        <div className="ml-auto">
          <HealthBadge score={audit.healthScore} label={audit.healthLabel} />
        </div>
      </button>

      {expanded && (
        <div className="space-y-3 text-xs">
          {/* Core metrics */}
          <div className="space-y-0.5 border-b border-edge pb-2">
            <MetricRow
              label="Read:Edit Ratio"
              value={audit.readEditRatio.value.toFixed(1)}
              provenance={audit.readEditRatio.provenance}
              health={audit.readEditHealth}
            />
            {audit.thinkingDepth.provenance !== 'unavailable' && (
              <MetricRow
                label={locale === 'zh-CN' ? 'Thinking 深度' : 'Thinking Depth'}
                value={`${audit.thinkingDepth.value.avgSignatureLength} avg`}
                unit={audit.thinkingDepth.value.redactedCount > 0 ? `(${audit.thinkingDepth.value.redactedCount} redacted)` : ''}
                provenance={audit.thinkingDepth.provenance}
              />
            )}
            {audit.latencyStats.provenance !== 'unavailable' && (
              <MetricRow
                label={locale === 'zh-CN' ? '响应延迟 P95' : 'Response P95'}
                value={formatMs(audit.latencyStats.value.p95)}
                unit={`(p50: ${formatMs(audit.latencyStats.value.p50)})`}
                provenance={audit.latencyStats.provenance}
              />
            )}
            {audit.estimatedCost.provenance !== 'unavailable' && (
              <MetricRow
                label={locale === 'zh-CN' ? '估算成本' : 'Est. Cost'}
                value={formatCost(audit.estimatedCost.value.totalCost)}
                unit={`(in: ${formatCost(audit.estimatedCost.value.inputCost)} + out: ${formatCost(audit.estimatedCost.value.outputCost)})`}
                provenance={audit.estimatedCost.provenance}
              />
            )}
            <MetricRow
              label={locale === 'zh-CN' ? '可见框架标记' : 'Visible Framework Markers'}
              value={`≈${audit.visibleFrameworkMarkers.value.estimatedMarkerTokens.toLocaleString()}`}
              unit={locale === 'zh-CN' ? 'tokens（非 API 上下文开销）' : 'tokens (not API context overhead)'}
              provenance={audit.visibleFrameworkMarkers.provenance}
            />
          </div>

          {/* Findings */}
          {audit.findings.length > 0 && (
            <div>
              <div className="text-[10px] font-medium text-secondary flex items-center gap-1 mb-1">
                <Info size={10} />
                {audit.findings.length} {locale === 'zh-CN' ? '项发现' : 'findings'}
              </div>
              {audit.findings.map((f, i) => (
                <div key={i} className="text-[10px] text-muted pl-3 py-0.5 border-l-2 border-edge">{f}</div>
              ))}
            </div>
          )}

          {/* Anti-patterns */}
          {audit.antiPatterns.length > 0 && (
            <div>
              <div className="text-[10px] font-medium text-soft-amber flex items-center gap-1 mb-1">
                <AlertTriangle size={10} />
                {audit.antiPatterns.length} {locale === 'zh-CN' ? '个反模式' : 'anti-patterns'}
              </div>
              {audit.antiPatterns.slice(0, 5).map((ap, i) => (
                <div key={i} className="text-[10px] text-soft-amber/60 pl-3 truncate">T{ap.turnIndex}: {ap.detail}</div>
              ))}
            </div>
          )}

          {/* Frustration signals */}
          {audit.frustrationSignals.length > 0 && (
            <div>
              <div className="text-[10px] font-medium text-soft-purple flex items-center gap-1 mb-1">
                😤 {audit.frustrationSignals.length} {locale === 'zh-CN' ? '个挫败信号' : 'frustration signals'}
              </div>
              {audit.frustrationSignals.slice(0, 5).map((fs, i) => (
                <div key={i} className="text-[10px] text-soft-purple/60 pl-3 truncate">{fs.type}: {fs.text}</div>
              ))}
            </div>
          )}

          {/* Session type + model usage */}
          <div className="border-t border-edge pt-2 space-y-1.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-muted">{locale === 'zh-CN' ? '会话类型' : 'Session Type'}</span>
              <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-surface text-secondary capitalize">{audit.sessionType}</span>
            </div>
            {audit.modelUsage && audit.modelUsage.length > 0 && (
              <div>
                <div className="text-[10px] text-muted mb-1">{locale === 'zh-CN' ? '模型使用' : 'Model Usage'}</div>
                {audit.modelUsage.slice(0, 3).map((m, i) => (
                  <div key={i} className="flex items-center justify-between text-[10px] pl-2">
                    <span className="text-secondary truncate">{m.model}</span>
                    <span className="text-muted">{m.turns} turns · ${m.estimatedCost.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            )}
            {audit.toolEfficiency && audit.toolEfficiency.length > 0 && (
              <div>
                <div className="text-[10px] text-muted mb-1">{locale === 'zh-CN' ? '工具效率' : 'Tool Efficiency'}</div>
                {audit.toolEfficiency.slice(0, 5).map((t, i) => (
                  <div key={i} className="flex items-center justify-between text-[10px] pl-2">
                    <span className="text-secondary">{t.name}</span>
                    <span className="text-muted">
                      {t.count}x
                      {t.errorCount > 0 && <span className="text-red-400 ml-1">({t.errorCount} err)</span>}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {audit.userInterruptions > 0 && (
              <div className="text-[10px] text-soft-amber">
                ⏸ {audit.userInterruptions} {locale === 'zh-CN' ? '次用户中断' : 'interruptions'}
              </div>
            )}
          </div>

          {/* Provenance legend */}
          <div className="flex gap-2 text-[9px] text-faint border-t border-edge pt-2">
            <span><ProvenanceBadge p="reported" /> API 真实值</span>
            <span><ProvenanceBadge p="estimated" /> 估算</span>
            <span><ProvenanceBadge p="unavailable" /> 无数据</span>
          </div>
        </div>
      )}
    </section>
  )
}
