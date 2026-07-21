import { useState, useEffect } from 'react'
import { useStore } from '../store'
import {
  Shield, ChevronDown, ChevronRight, AlertTriangle, CheckCircle, XCircle, Info, FlaskConical
} from 'lucide-react'

interface AuditEvidence {
  line: number
  messageUuid?: string
  role: 'user' | 'assistant'
  kind: string
  excerpt: string
}

interface AuditMetric<T> {
  value: T
  provenance: 'reported' | 'estimated' | 'unavailable'
  evidence: AuditEvidence[]
  caveat: string
}

interface SessionAuditResult {
  sessionId: string
  experimental: true
  methodologyVersion: string
  readEditHealthBasis: 'heuristic-unvalidated'
  limitations: string[]
  readEditRatio: AuditMetric<number>
  readEditHealth: 'healthy' | 'degraded' | 'critical' | 'unavailable'
  thinkingDepth: AuditMetric<{ avgSignatureLength: number; redactedCount: number; totalBlocks: number }>
  latencyStats: AuditMetric<{ p50: number; p95: number; max: number }>
  estimatedCost: AuditMetric<{ inputCost: number; outputCost: number; totalCost: number; currency: string }>
  frameworkOverhead: AuditMetric<{ frameworkTokens: number; totalTokens: number; percentage: number }>
  antiPatterns: Array<{ type: string; turnIndex: number; detail: string; evidence: AuditEvidence[] }>
  frustrationSignals: Array<{ type: string; turnIndex: number; text: string; evidence: AuditEvidence[] }>
  sessionType: string
  modelUsage: Array<{ model: string; turns: number; estimatedCost: number }>
  toolEfficiency: Array<{
    name: string; count: number; errorCount: number; avgLatencyMs: number; evidence: AuditEvidence[]
  }>
  userInterruptions: number
  healthScore: number
  healthLabel: 'excellent' | 'good' | 'fair' | 'poor'
  scoreFactors: Array<{ key: string; impact: number; detail: string; evidence: AuditEvidence[] }>
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
  const [evidenceOpen, setEvidenceOpen] = useState(false)

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
  const evidenceMetrics: Array<{ label: string; metric: Pick<AuditMetric<unknown>, 'evidence' | 'caveat'> }> = [
    { label: 'Read:Edit Ratio', metric: audit.readEditRatio },
    { label: locale === 'zh-CN' ? 'Thinking 代理' : 'Thinking Proxy', metric: audit.thinkingDepth },
    { label: locale === 'zh-CN' ? '响应延迟' : 'Response Latency', metric: audit.latencyStats },
    { label: locale === 'zh-CN' ? '成本估算' : 'Cost Estimate', metric: audit.estimatedCost },
    { label: locale === 'zh-CN' ? '框架开销' : 'Framework Overhead', metric: audit.frameworkOverhead }
  ]

  return (
    <section>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-xs font-medium text-soft-emerald mb-2 w-full text-left hover:text-primary"
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Shield size={12} />
        <span>{locale === 'zh-CN' ? '会话审计' : 'Session Audit'}</span>
        <span className="inline-flex items-center gap-0.5 rounded border border-soft-amber/30 bg-soft-amber/10 px-1 py-0.5 text-[8px] font-medium text-soft-amber">
          <FlaskConical size={8} />
          {locale === 'zh-CN' ? '实验' : 'Experimental'}
        </span>
        <div className="ml-auto">
          <HealthBadge score={audit.healthScore} label={audit.healthLabel} />
        </div>
      </button>

      {expanded && (
        <div className="space-y-3 text-xs">
          <div className="rounded border border-soft-amber/20 bg-soft-amber/5 px-2 py-1.5 text-[10px] leading-relaxed text-muted">
            {locale === 'zh-CN'
              ? '分数是可解释的启发式信号，不是客观质量评级；请结合下方原始依据判断。'
              : 'The score is an explainable heuristic signal, not an objective quality grade. Review its evidence.'}
          </div>

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
              label={locale === 'zh-CN' ? '框架开销' : 'Framework Overhead'}
              value={`${audit.frameworkOverhead.value.percentage.toFixed(0)}%`}
              provenance={audit.frameworkOverhead.provenance}
              health={audit.frameworkOverhead.value.percentage > 30 ? 'critical' : audit.frameworkOverhead.value.percentage > 15 ? 'degraded' : 'healthy'}
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

          {/* Evidence and methodology */}
          <div className="border-t border-edge pt-2">
            <button
              onClick={() => setEvidenceOpen(!evidenceOpen)}
              className="flex w-full items-center gap-1 text-left text-[10px] font-medium text-secondary hover:text-primary"
            >
              {evidenceOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
              {locale === 'zh-CN' ? '查看评分依据与原始消息行' : 'View score evidence and source lines'}
            </button>
            {evidenceOpen && (
              <div className="mt-2 space-y-2 rounded bg-surface/60 p-2">
                <div>
                  <div className="mb-1 text-[9px] font-medium uppercase tracking-wide text-faint">
                    {locale === 'zh-CN' ? '评分扣分项（基线 80）' : 'Score factors (baseline 80)'}
                  </div>
                  {audit.scoreFactors.length === 0 ? (
                    <div className="text-[10px] text-muted">{locale === 'zh-CN' ? '无扣分项' : 'No deductions'}</div>
                  ) : audit.scoreFactors.map((factor) => (
                    <div key={factor.key} className="mb-1 text-[10px]">
                      <span className="mr-1 font-medium text-red-400">{factor.impact}</span>
                      <span className="text-secondary">{factor.detail}</span>
                      <div className="text-faint">
                        {factor.evidence.slice(0, 3).map((item) => `L${item.line}`).join(' · ')}
                      </div>
                    </div>
                  ))}
                </div>

                {evidenceMetrics.map(({ label, metric }) => (
                  <div key={label} className="border-t border-edge/60 pt-1.5">
                    <div className="text-[10px] font-medium text-secondary">{label}</div>
                    <div className="text-[9px] leading-relaxed text-faint">{metric.caveat}</div>
                    {metric.evidence.length > 0 ? metric.evidence.slice(0, 4).map((item, index) => (
                      <div key={`${item.line}-${item.kind}-${index}`} className="mt-0.5 break-words text-[9px] text-muted">
                        L{item.line} · {item.kind} · {item.excerpt}
                      </div>
                    )) : (
                      <div className="mt-0.5 text-[9px] text-faint">
                        {locale === 'zh-CN' ? '当前会话无可用原始依据' : 'No source evidence available'}
                      </div>
                    )}
                  </div>
                ))}

                <div className="border-t border-edge/60 pt-1.5">
                  <div className="text-[10px] font-medium text-secondary">
                    {locale === 'zh-CN' ? '已知限制' : 'Known limitations'}
                  </div>
                  {audit.limitations.map((limitation, index) => (
                    <div key={index} className="mt-0.5 text-[9px] leading-relaxed text-faint">• {limitation}</div>
                  ))}
                </div>
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
