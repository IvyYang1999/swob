/**
 * Cross-Session Insights Report Generator
 *
 * Aggregates audit data across all sessions and generates a standalone HTML report.
 * Inspired by Claude Code /insights but covers 11 harnesses + lineage + provenance.
 */

import { auditSession, type SessionAuditResult, type SessionType } from './session-audit'
import { parseSessionFile } from './session-loader'
import { callLlm, resolveLlmModel, type LlmSettings } from './llm-client'
import { accountingForSession } from './token-accounting'
import { aggregateValuations, type Valuation } from './token-valuation'
import type { SessionSummary } from './types'

export type InsightsProgress = (stage: string, current: number, total: number) => void

export interface InsightsGenerationOptions {
  signal?: AbortSignal
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
}

export interface InsightsReport {
  generatedAt: string
  dateRange: { start: string; end: string }
  totalSessions: number
  totalTurns: number
  totalTokens: number
  tokenAvailability: { availableSessions: number; unavailableSessions: number }
  valuation: Valuation
  activeDays: number
  totalActiveHours: number

  bySource: Array<{
    source: string
    sessions: number
    turns: number
    tokens: number
    valuation: Valuation
    unavailableSessions: number
  }>

  bySessionType: Record<SessionType, number>

  healthDistribution: {
    excellent: number
    good: number
    fair: number
    poor: number
    avgScore: number
  }

  topTools: Array<{ name: string; count: number; errorRate: number }>

  topModels: Array<{ model: string; turns: number; valuation: Valuation }>

  visibleFrameworkMarkers: { avgEstimatedTokens: number; maxEstimatedTokens: number; maxSessionId: string }

  readEditRatio: { avg: number; healthyCnt: number; degradedCnt: number; criticalCnt: number }

  totalAntiPatterns: number
  totalFrustrationSignals: number
  totalInterruptions: number

  peakHours: number[]
  dailyActivity: Record<string, number>

  findings: string[]
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export async function generateInsightsReport(
  sessions: SessionSummary[],
  maxSessions = 200,
  onProgress?: InsightsProgress,
  options: InsightsGenerationOptions = {}
): Promise<InsightsReport> {
  const eligible = sessions
    .filter(s => s.turnCount > 1 && s.filePath)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, maxSessions)

  const analyzed: Array<{ session: SessionSummary; audit: SessionAuditResult }> = []
  for (let i = 0; i < eligible.length; i++) {
    throwIfCancelled(options.signal)
    const s = eligible[i]
    try {
      const msgs = await parseSessionFile(s.filePath)
      if (msgs.length > 0) analyzed.push({
        session: s,
        audit: auditSession(msgs, s.sessionId, accountingForSession(s))
      })
    } catch { /* skip */ }
    if (onProgress && (i % 10 === 0 || i === eligible.length - 1)) {
      onProgress('analyzing', i + 1, eligible.length)
    }
  }

  const bySource = new Map<string, {
    sessions: number
    turns: number
    tokens: number
    valuations: Valuation[]
    unavailableSessions: number
  }>()
  const byType: Record<SessionType, number> = { coding: 0, research: 0, debugging: 0, discussion: 0, mixed: 0 }
  const health = { excellent: 0, good: 0, fair: 0, poor: 0, totalScore: 0 }
  const toolAgg = new Map<string, { count: number; errors: number }>()
  const modelAgg = new Map<string, { turns: number; valuations: Valuation[] }>()
  const hours: number[] = new Array(24).fill(0)
  const daily = new Map<string, number>()
  let totalAntiPatterns = 0
  let totalFrustration = 0
  let totalInterruptions = 0
  let totalTokens = 0
  let availableTokenSessions = 0
  let unavailableTokenSessions = 0
  let totalTurns = 0
  const valuations: Valuation[] = []
  let markerTotal = 0
  let markerCount = 0
  let markerMax = 0
  let markerMaxSid = ''
  let reSum = 0
  let reHealthy = 0
  let reDegraded = 0
  let reCritical = 0
  let reCount = 0
  const dates: number[] = []

  for (const { audit, session } of analyzed) {
    const src = session.source || 'claude-code'
    const accounting = accountingForSession(session)
    const excludedFromRollups = accounting.excludedFromRollups === true
    const billingTokens = excludedFromRollups ? null : accounting.billingTotal

    if (!bySource.has(src)) bySource.set(src, {
      sessions: 0, turns: 0, tokens: 0, valuations: [], unavailableSessions: 0
    })
    const srcEntry = bySource.get(src)!
    srcEntry.sessions++
    srcEntry.turns += session.turnCount
    if (billingTokens === null) srcEntry.unavailableSessions++
    else srcEntry.tokens += billingTokens
    if (!excludedFromRollups) srcEntry.valuations.push(audit.valuation.value)

    byType[audit.sessionType]++

    if (audit.healthScore >= 80) health.excellent++
    else if (audit.healthScore >= 60) health.good++
    else if (audit.healthScore >= 40) health.fair++
    else health.poor++
    health.totalScore += audit.healthScore

    for (const t of audit.toolEfficiency) {
      if (!toolAgg.has(t.name)) toolAgg.set(t.name, { count: 0, errors: 0 })
      const te = toolAgg.get(t.name)!
      te.count += t.count
      te.errors += t.errorCount
    }

    for (const m of audit.modelUsage) {
      if (!modelAgg.has(m.model)) modelAgg.set(m.model, { turns: 0, valuations: [] })
      const me = modelAgg.get(m.model)!
      me.turns += m.turns
      if (!excludedFromRollups) me.valuations.push(m.valuation)
    }

    totalAntiPatterns += audit.antiPatterns.length
    totalFrustration += audit.frustrationSignals.length
    totalInterruptions += audit.userInterruptions
    if (billingTokens === null) unavailableTokenSessions++
    else {
      availableTokenSessions++
      totalTokens += billingTokens
    }
    totalTurns += session.turnCount
    if (!excludedFromRollups) valuations.push(audit.valuation.value)

    if (audit.visibleFrameworkMarkers.value.estimatedMarkerTokens > 0) {
      const markerTokens = audit.visibleFrameworkMarkers.value.estimatedMarkerTokens
      markerTotal += markerTokens
      markerCount++
      if (markerTokens > markerMax) {
        markerMax = markerTokens
        markerMaxSid = audit.sessionId
      }
    }

    if (audit.readEditHealth !== 'unavailable') {
      reSum += audit.readEditRatio.value
      reCount++
      if (audit.readEditHealth === 'healthy') reHealthy++
      else if (audit.readEditHealth === 'degraded') reDegraded++
      else reCritical++
    }

    const created = new Date(session.createdAt)
    if (!isNaN(created.getTime())) {
      dates.push(created.getTime())
      hours[created.getHours()]++
      const dk = dayKey(created)
      daily.set(dk, (daily.get(dk) || 0) + 1)
    }
  }

  dates.sort()

  const findings: string[] = []
  const avgHealth = analyzed.length > 0 ? health.totalScore / analyzed.length : 0
  if (avgHealth < 50) findings.push(`Average health score ${avgHealth.toFixed(0)}/100 — significant quality issues across sessions`)
  if (totalInterruptions > analyzed.length * 0.5) findings.push(`${totalInterruptions} interruptions across ${analyzed.length} sessions — frequent workflow breaks`)
  if (reCount > 0 && reSum / reCount < 3) findings.push(`Average Read:Edit ratio ${(reSum / reCount).toFixed(1)} — tendency to edit before thoroughly reading`)
  const sourceRows = [...bySource.entries()].map(([source, data]) => ({
    source,
    sessions: data.sessions,
    turns: data.turns,
    tokens: data.tokens,
    unavailableSessions: data.unavailableSessions,
    valuation: aggregateValuations(data.valuations)
  }))
  const topSrc = [...sourceRows].sort((a, b) => (b.valuation.usd || 0) - (a.valuation.usd || 0))
  if (topSrc.length > 1 && topSrc[0].valuation.usd !== undefined) {
    findings.push(
      `Highest API equivalent (estimate) source: ${topSrc[0].source} ($${topSrc[0].valuation.usd.toFixed(2)}, ` +
      `${topSrc[0].valuation.coveragePercent.toFixed(1)}% covered) across ${topSrc[0].sessions} sessions`
    )
  }

  const activeDays = daily.size
  const totalHours = eligible.reduce((a, s) => a + (s.estimatedTime || 0), 0) / 3600000

  return {
    generatedAt: new Date().toISOString(),
    dateRange: {
      start: dates.length > 0 ? new Date(dates[0]).toISOString().slice(0, 10) : '',
      end: dates.length > 0 ? new Date(dates[dates.length - 1]).toISOString().slice(0, 10) : ''
    },
    totalSessions: analyzed.length,
    totalTurns,
    totalTokens,
    tokenAvailability: { availableSessions: availableTokenSessions, unavailableSessions: unavailableTokenSessions },
    valuation: aggregateValuations(valuations),
    activeDays,
    totalActiveHours: Math.round(totalHours),
    bySource: sourceRows.sort((a, b) => b.sessions - a.sessions),
    bySessionType: byType,
    healthDistribution: { ...health, avgScore: avgHealth },
    topTools: [...toolAgg.entries()]
      .map(([name, d]) => ({ name, count: d.count, errorRate: d.count > 0 ? d.errors / d.count : 0 }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 15),
    topModels: [...modelAgg.entries()]
      .map(([model, data]) => ({
        model,
        turns: data.turns,
        valuation: aggregateValuations(data.valuations)
      }))
      .sort((a, b) => b.turns - a.turns),
    visibleFrameworkMarkers: {
      avgEstimatedTokens: markerCount > 0 ? markerTotal / markerCount : 0,
      maxEstimatedTokens: markerMax,
      maxSessionId: markerMaxSid
    },
    readEditRatio: { avg: reCount > 0 ? reSum / reCount : 0, healthyCnt: reHealthy, degradedCnt: reDegraded, criticalCnt: reCritical },
    totalAntiPatterns,
    totalFrustrationSignals: totalFrustration,
    totalInterruptions,
    peakHours: hours,
    dailyActivity: Object.fromEntries(daily),
    findings
  }
}

export function renderInsightsHtml(report: InsightsReport): string {
  const srcRows = report.bySource.map(s =>
    `<tr><td>${s.source}</td><td>${s.sessions}</td><td>${s.turns.toLocaleString()}</td><td>${Math.round(s.tokens / 1000).toLocaleString()}k</td><td>${s.valuation.usd === undefined ? 'unpriced' : `$${s.valuation.usd.toFixed(2)} (${s.valuation.coveragePercent.toFixed(1)}%)`}</td></tr>`
  ).join('')

  const toolRows = report.topTools.slice(0, 10).map(t =>
    `<tr><td>${t.name}</td><td>${t.count.toLocaleString()}</td><td>${(t.errorRate * 100).toFixed(1)}%</td></tr>`
  ).join('')

  const modelRows = report.topModels.map(m =>
    `<tr><td>${m.model}</td><td>${m.turns.toLocaleString()}</td><td>${m.valuation.usd === undefined ? 'unpriced' : `$${m.valuation.usd.toFixed(2)} (${m.valuation.coveragePercent.toFixed(1)}%)`}</td></tr>`
  ).join('')

  const healthBar = (label: string, count: number, color: string) =>
    count > 0 ? `<div style="flex:${count};background:${color};height:24px;border-radius:4px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:600">${count}</div>` : ''

  const peakHoursHtml = report.peakHours.map((count, hour) => {
    const maxH = Math.max(...report.peakHours, 1)
    const h = Math.round((count / maxH) * 40)
    return `<div style="display:flex;flex-direction:column;align-items:center;gap:2px"><div style="width:14px;background:var(--accent);border-radius:2px;opacity:${0.2 + 0.8 * count / maxH}" title="${count} sessions at ${hour}:00" style="height:${h}px;min-height:2px"></div><span style="font-size:9px;color:var(--dim)">${hour}</span></div>`
  }).join('')

  const findingsHtml = report.findings.map(f =>
    `<div style="padding:8px 12px;background:var(--bg-alt);border-radius:6px;border-left:3px solid var(--accent);font-size:13px;color:var(--fg);margin-bottom:8px">${f}</div>`
  ).join('')

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Swob Session Insights</title>
<style>
:root{--bg:#0d1117;--bg-alt:#161b22;--fg:#e6edf3;--dim:#8b949e;--accent:#3fb950;--blue:#58a6ff;--amber:#f59e0b;--red:#f85149;--border:#30363d;--mono:ui-monospace,"SF Mono",Menlo,monospace;--sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
@media(prefers-color-scheme:light){:root{--bg:#fff;--bg-alt:#f6f8fa;--fg:#1f2328;--dim:#656d76;--accent:#1a7f37;--blue:#0969da;--amber:#bc4c00;--red:#cf222e;--border:#d0d7de}}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--sans);background:var(--bg);color:var(--fg);line-height:1.6;max-width:800px;margin:0 auto;padding:32px 24px}
h1{font-family:var(--mono);font-size:1.5rem;margin-bottom:4px}
h2{font-family:var(--mono);font-size:1rem;margin:32px 0 12px;color:var(--accent);border-bottom:1px solid var(--border);padding-bottom:4px}
.subtitle{color:var(--dim);font-size:13px;margin-bottom:24px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px;margin-bottom:24px}
.stat{background:var(--bg-alt);border:1px solid var(--border);border-radius:8px;padding:12px;text-align:center}
.stat-value{font-family:var(--mono);font-size:1.4rem;font-weight:700;color:var(--fg)}
.stat-label{font-size:11px;color:var(--dim);margin-top:2px}
table{width:100%;border-collapse:collapse;font-size:13px;margin:8px 0}
th,td{padding:6px 10px;text-align:left;border-bottom:1px solid var(--border)}
th{color:var(--dim);font-weight:500;font-size:11px;text-transform:uppercase}
.health-bar{display:flex;gap:2px;margin:8px 0;border-radius:6px;overflow:hidden}
.hours{display:flex;gap:1px;align-items:end;height:50px;margin:8px 0}
.provenance{font-size:9px;padding:2px 5px;border-radius:3px;background:var(--bg-alt);color:var(--dim)}
footer{margin-top:40px;padding-top:16px;border-top:1px solid var(--border);text-align:center;font-size:11px;color:var(--dim);font-family:var(--mono)}
</style>
</head>
<body>
<h1>Swob Session Insights</h1>
<p class="subtitle">${report.dateRange.start} — ${report.dateRange.end} · ${report.totalSessions} sessions analyzed · Generated ${new Date(report.generatedAt).toLocaleString()}</p>

<div class="stats">
<div class="stat"><div class="stat-value">${report.totalSessions}</div><div class="stat-label">Sessions</div></div>
<div class="stat"><div class="stat-value">${report.totalTurns.toLocaleString()}</div><div class="stat-label">Turns</div></div>
<div class="stat"><div class="stat-value">${Math.round(report.totalTokens / 1000).toLocaleString()}k</div><div class="stat-label">Processed Tokens</div></div>
<div class="stat"><div class="stat-value">${report.valuation.usd === undefined ? 'unpriced' : `$${report.valuation.usd.toFixed(2)}`}</div><div class="stat-label">API 等价值(估算) · ${report.valuation.coveragePercent.toFixed(1)}% covered</div></div>
<div class="stat"><div class="stat-value">${report.activeDays}</div><div class="stat-label">Active Days</div></div>
<div class="stat"><div class="stat-value">${report.totalActiveHours}h</div><div class="stat-label">Active Time</div></div>
</div>

<h2>Health Distribution</h2>
<div class="health-bar">
${healthBar('Excellent', report.healthDistribution.excellent, '#3fb950')}
${healthBar('Good', report.healthDistribution.good, '#58a6ff')}
${healthBar('Fair', report.healthDistribution.fair, '#f59e0b')}
${healthBar('Poor', report.healthDistribution.poor, '#f85149')}
</div>
<p style="font-size:12px;color:var(--dim)">Average health score: <strong style="color:var(--fg)">${report.healthDistribution.avgScore.toFixed(0)}/100</strong> · Read:Edit avg: ${report.readEditRatio.avg.toFixed(1)} · Visible marker estimate avg: ${Math.round(report.visibleFrameworkMarkers.avgEstimatedTokens).toLocaleString()} tokens (not API context overhead)</p>

<h2>By Source</h2>
<table><tr><th>Source</th><th>Sessions</th><th>Turns</th><th>Tokens</th><th>API equivalent (estimate) / coverage</th></tr>${srcRows}</table>

<h2>Session Types</h2>
<p style="font-size:13px">Coding: <strong>${report.bySessionType.coding}</strong> · Research: <strong>${report.bySessionType.research}</strong> · Debugging: <strong>${report.bySessionType.debugging}</strong> · Discussion: <strong>${report.bySessionType.discussion}</strong> · Mixed: <strong>${report.bySessionType.mixed}</strong></p>

<h2>Top Tools</h2>
<table><tr><th>Tool</th><th>Uses</th><th>Error Rate</th></tr>${toolRows}</table>

<h2>Models</h2>
<table><tr><th>Model</th><th>Turns</th><th>API equivalent (estimate) / coverage</th></tr>${modelRows}</table>

<h2>Signals</h2>
<div class="stats" style="grid-template-columns:repeat(3,1fr)">
<div class="stat"><div class="stat-value" style="color:var(--amber)">${report.totalAntiPatterns}</div><div class="stat-label">Anti-patterns</div></div>
<div class="stat"><div class="stat-value" style="color:var(--red)">${report.totalFrustrationSignals}</div><div class="stat-label">Frustration Signals</div></div>
<div class="stat"><div class="stat-value">${report.totalInterruptions}</div><div class="stat-label">Interruptions</div></div>
</div>

${report.findings.length > 0 ? `<h2>Key Findings</h2>${findingsHtml}` : ''}

<footer>
Generated by Swob · A git graph for your AI conversations<br>
Covers ${report.bySource.map(s => s.source).join(', ')} · All metrics tagged with provenance
</footer>
</body>
</html>`
}

// ============ LLM Narrative（用户提供 API key，session 内容会发送到所选服务商） ============

export interface LlmNarrative {
  atAGlance: string
  workPatterns: string
  frictionAnalysis: string
  recommendations: string
  model: string
  provider: string
}

/** 采样 session 内容供 LLM 分析。只取真人 user 消息前 300 字符，每 session 最多 8 条。 */
async function sampleSessionContent(
  sessions: SessionSummary[],
  maxSessions: number,
  onProgress?: InsightsProgress,
  signal?: AbortSignal
): Promise<string> {
  const lines: string[] = []
  const picked = sessions
    .filter(s => s.turnCount > 1 && s.filePath)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, maxSessions)

  for (let i = 0; i < picked.length; i++) {
    throwIfCancelled(signal)
    const s = picked[i]
    try {
      const msgs = await parseSessionFile(s.filePath)
      const userTexts: string[] = []
      for (const m of msgs) {
        if (m.isSidechain || m.type !== 'user' || !m.message) continue
        const c = m.message.content
        const text = typeof c === 'string' ? c
          : Array.isArray(c) ? c.filter((p: { type?: string; text?: string }) => p.type === 'text' && p.text).map((p: { text?: string }) => p.text).join(' ')
          : ''
        if (!text || text.startsWith('<') || text.includes('system-reminder')) continue
        userTexts.push(text.slice(0, 300))
        if (userTexts.length >= 8) break
      }
      if (userTexts.length > 0) {
        lines.push(`--- Session (${s.source || 'claude-code'}, ${s.turnCount} turns, ${new Date(s.createdAt).toISOString().slice(0, 10)}) ---`)
        lines.push(...userTexts.map(t => `[User]: ${t}`))
      }
    } catch { /* skip */ }
    if (onProgress && i % 10 === 0) onProgress('sampling', i + 1, picked.length)
  }
  return lines.join('\n').slice(0, 120_000)
}

export async function generateLlmNarrative(
  report: InsightsReport,
  sessions: SessionSummary[],
  llm: LlmSettings,
  onProgress?: InsightsProgress,
  options: InsightsGenerationOptions = {}
): Promise<LlmNarrative> {
  onProgress?.('sampling', 0, 1)
  const contentSample = await sampleSessionContent(sessions, 60, onProgress, options.signal)

  const statsBlock = JSON.stringify({
    totalSessions: report.totalSessions,
    dateRange: report.dateRange,
    bySource: report.bySource,
    bySessionType: report.bySessionType,
    healthDistribution: { avg: report.healthDistribution.avgScore, poor: report.healthDistribution.poor },
    topTools: report.topTools.slice(0, 8),
    topModels: report.topModels,
    readEditRatio: report.readEditRatio,
    visibleFrameworkMarkerAvgEstimatedTokens: report.visibleFrameworkMarkers.avgEstimatedTokens,
    tokenAvailability: report.tokenAvailability,
    frustrationSignals: report.totalFrustrationSignals,
    interruptions: report.totalInterruptions,
    quantFindings: report.findings
  }, null, 1)

  const systemPrompt = 'You are an AI-coding-workflow analyst writing a usage insights report for a developer who uses multiple AI coding tools (Claude Code, Codex, Cursor, etc). Analyze their aggregated metrics and real session samples. Write in the same language the user predominantly writes in (detect from samples — likely Chinese). Be specific, cite examples from the data, use second person. No flattery; genuinely useful observations only.'

  onProgress?.('llm', 0, 1)
  const raw = await callLlm(llm, systemPrompt, `## Aggregated metrics (computed locally, provenance-tagged)
${statsBlock}

## Real user-message samples from recent sessions
${contentSample}

## Task
Return STRICT JSON with exactly these keys (values are markdown strings):
{
  "atAGlance": "2-3 sentence executive summary of how this user works with AI coding tools",
  "workPatterns": "2-3 paragraphs analyzing HOW the user interacts: iterate quickly vs detailed specs? interrupt often? multi-tool workflows? cite specific examples with **bold** key insights",
  "frictionAnalysis": "top friction points visible in the data: repeated corrections, tool errors, context overflows — with concrete examples",
  "recommendations": "3-5 numbered, actionable recommendations tailored to this user's patterns (e.g. CLAUDE.md rules to add, workflow changes, tool choices)"
}`, 4096, { signal: options.signal, connectTimeoutMs: 30_000, totalTimeoutMs: 120_000 })

  onProgress?.('llm', 1, 1)
  const jsonMatch = raw.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('llm-response-not-json')
  const parsed = JSON.parse(jsonMatch[0])
  return {
    atAGlance: String(parsed.atAGlance || ''),
    workPatterns: String(parsed.workPatterns || ''),
    frictionAnalysis: String(parsed.frictionAnalysis || ''),
    recommendations: String(parsed.recommendations || ''),
    model: resolveLlmModel(llm),
    provider: llm.provider
  }
}

function mdToHtml(md: string): string {
  return md
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>')
}

export function renderNarrativeHtml(n: LlmNarrative): string {
  return `
<h2>At a Glance <span class="provenance">AI · ${n.provider}/${n.model}</span></h2>
<div style="padding:14px 16px;background:var(--bg-alt);border-radius:8px;border:1px solid var(--border);font-size:14px;margin-bottom:8px"><p>${mdToHtml(n.atAGlance)}</p></div>
<h2>Work Patterns <span class="provenance">AI</span></h2>
<div style="font-size:13px;color:var(--fg)"><p>${mdToHtml(n.workPatterns)}</p></div>
<h2>Friction Analysis <span class="provenance">AI</span></h2>
<div style="font-size:13px;color:var(--fg)"><p>${mdToHtml(n.frictionAnalysis)}</p></div>
<h2>Recommendations <span class="provenance">AI</span></h2>
<div style="font-size:13px;color:var(--fg)"><ol style="padding-left:20px">${mdToHtml(n.recommendations)}</ol></div>`
}
