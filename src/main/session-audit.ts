/**
 * Session Audit Engine — 会话质量审计
 *
 * 从 JSONL 消息流中计算审计指标，覆盖：
 * 1. Read:Edit Ratio（研究充分度 benchmark）
 * 2. Thinking Depth 代理（signature 长度 / redaction 检测）
 * 3. 逐轮延迟（p50/p95/max，慢轮标记）
 * 4. 成本估算（token × 模型单价）
 * 5. 框架开销占比（system-reminder 等注入）
 * 6. 工具序列反模式检测
 * 7. 用户挫败信号
 * 8. 行为健康评分
 *
 * 每个指标标注 provenance: 'reported' | 'estimated' | 'unavailable'
 */

export interface AuditMetric<T> {
  value: T
  provenance: 'reported' | 'estimated' | 'unavailable'
}

export interface ToolAntiPattern {
  type: 'repeated-read' | 'edit-revert' | 'ignored-agent' | 'excessive-bash-retry'
  turnIndex: number
  detail: string
}

export interface FrustrationSignal {
  type: 'rapid-correction' | 'keyword' | 'repeated-instruction' | 'interruption'
  turnIndex: number
  text: string
}

export interface TurnLatency {
  turnIndex: number
  latencyMs: number
  role: 'user' | 'assistant'
}

export interface SessionAuditResult {
  sessionId: string

  // Core metrics
  readEditRatio: AuditMetric<number>
  readEditHealth: 'healthy' | 'degraded' | 'critical' | 'unavailable'
  thinkingDepth: AuditMetric<{ avgSignatureLength: number; redactedCount: number; totalBlocks: number }>
  turnLatencies: TurnLatency[]
  latencyStats: AuditMetric<{ p50: number; p95: number; max: number }>
  estimatedCost: AuditMetric<{ inputCost: number; outputCost: number; totalCost: number; currency: string }>
  frameworkOverhead: AuditMetric<{ frameworkTokens: number; totalTokens: number; percentage: number }>

  // Pattern detection
  antiPatterns: ToolAntiPattern[]
  frustrationSignals: FrustrationSignal[]

  // Summary
  healthScore: number // 0-100
  healthLabel: 'excellent' | 'good' | 'fair' | 'poor'
  findings: string[]
}

interface RawMessage {
  uuid?: string
  type?: string
  timestamp?: string
  isSidechain?: boolean
  message?: {
    role?: string
    content?: string | Array<Record<string, unknown>>
    usage?: {
      input_tokens?: number
      output_tokens?: number
    }
    model?: string
  }
}

// Model pricing (USD per million tokens, 2026 rates)
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-20250514': { input: 3, output: 15 },
  'claude-opus-4-20250514': { input: 15, output: 75 },
  'claude-haiku-3-5-20241022': { input: 0.8, output: 4 },
  'claude-3-5-sonnet-20241022': { input: 3, output: 15 },
}

const FRUSTRATION_KEYWORDS_ZH = ['不对', '重做', '为什么', '错了', '别这样', '回滚', '撤销', '不是这个意思', '搞错了']
const FRUSTRATION_KEYWORDS_EN = ['no not', 'wrong', 'redo', 'revert', 'undo', 'that\'s not', 'stop', 'don\'t']

function extractToolUseNames(content: unknown): string[] {
  if (!content || !Array.isArray(content)) return []
  return (content as Array<Record<string, unknown>>)
    .filter(p => p.type === 'tool_use' && p.name)
    .map(p => p.name as string)
}

function extractToolInputPaths(content: unknown): Array<{ name: string; path: string }> {
  if (!content || !Array.isArray(content)) return []
  return (content as Array<Record<string, unknown>>)
    .filter(p => p.type === 'tool_use' && p.name && p.input)
    .map(p => ({
      name: p.name as string,
      path: ((p.input as Record<string, unknown>)?.file_path as string) ||
            ((p.input as Record<string, unknown>)?.command as string) || ''
    }))
}

function extractThinkingBlocks(content: unknown): Array<{ length: number; signature?: string }> {
  if (!content || !Array.isArray(content)) return []
  return (content as Array<Record<string, unknown>>)
    .filter(p => p.type === 'thinking')
    .map(p => ({
      length: typeof p.thinking === 'string' ? (p.thinking as string).length : 0,
      signature: typeof p.signature === 'string' ? (p.signature as string) : undefined
    }))
}

function extractText(content: unknown): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Array<Record<string, unknown>>)
    .filter(p => p.type === 'text' && p.text)
    .map(p => p.text as string)
    .join('\n')
}

function isFrameworkContent(text: string): boolean {
  return text.includes('<system-reminder>') ||
    text.includes('<command-name>') ||
    text.includes('<task-notification>') ||
    text.includes('<local-command-') ||
    text.includes('<user-prompt-submit-hook>')
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.ceil(sorted.length * p / 100) - 1
  return sorted[Math.max(0, idx)]
}

export function auditSession(messages: RawMessage[], sessionId: string): SessionAuditResult {
  const toolCounts: Record<string, number> = {}
  const thinkingBlocks: Array<{ length: number; signature?: string }> = []
  const turnTimestamps: Array<{ ts: number; role: string; index: number }> = []
  const antiPatterns: ToolAntiPattern[] = []
  const frustrationSignals: FrustrationSignal[] = []
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let frameworkTokens = 0
  let totalContentTokens = 0
  let lastModel = ''
  let turnIndex = 0

  // For anti-pattern detection
  const recentReads: Array<{ path: string; turnIndex: number }> = []
  const recentEdits: Array<{ path: string; turnIndex: number }> = []
  const agentSpawnIds = new Set<string>()
  const agentResultIds = new Set<string>()
  let lastUserTimestamp = 0
  let lastUserText = ''
  let consecutiveShortUserMsgs = 0

  for (const msg of messages) {
    if (msg.isSidechain) continue
    if (!msg.type || !msg.message) continue

    const content = msg.message.content
    const ts = msg.timestamp ? new Date(msg.timestamp).getTime() : 0

    if (msg.type === 'assistant') {
      // Tool counts
      const tools = extractToolUseNames(content)
      for (const t of tools) toolCounts[t] = (toolCounts[t] || 0) + 1

      // Tool paths for anti-pattern detection
      const toolPaths = extractToolInputPaths(content)
      for (const tp of toolPaths) {
        if (tp.name === 'Read') recentReads.push({ path: tp.path, turnIndex })
        if (tp.name === 'Edit' || tp.name === 'Write') recentEdits.push({ path: tp.path, turnIndex })
        if (tp.name === 'Agent') agentSpawnIds.add(tp.path)
      }

      // Thinking depth
      thinkingBlocks.push(...extractThinkingBlocks(content))

      // Token usage
      const usage = msg.message.usage
      if (usage) {
        totalInputTokens += usage.input_tokens || 0
        totalOutputTokens += usage.output_tokens || 0
      }
      if (msg.message.model) lastModel = msg.message.model

      // Timestamps
      if (ts > 0) turnTimestamps.push({ ts, role: 'assistant', index: turnIndex })
      turnIndex++
    } else if (msg.type === 'user') {
      const text = extractText(content)

      // Framework overhead
      if (isFrameworkContent(text)) {
        frameworkTokens += estimateTokens(text)
      }
      totalContentTokens += estimateTokens(text)

      // Tool results (for agent anti-pattern)
      if (Array.isArray(content)) {
        for (const p of (content as Array<Record<string, unknown>>)) {
          if (p.type === 'tool_result' && p.tool_use_id) {
            agentResultIds.add(p.tool_use_id as string)
          }
        }
      }

      // Frustration signals
      if (text && !isFrameworkContent(text)) {
        // Rapid correction
        if (ts > 0 && lastUserTimestamp > 0 && ts - lastUserTimestamp < 10000 && text.length < 100) {
          consecutiveShortUserMsgs++
          if (consecutiveShortUserMsgs >= 2) {
            frustrationSignals.push({ type: 'rapid-correction', turnIndex, text: text.slice(0, 60) })
          }
        } else {
          consecutiveShortUserMsgs = 0
        }

        // Keyword detection
        const lower = text.toLowerCase()
        const allKeywords = [...FRUSTRATION_KEYWORDS_ZH, ...FRUSTRATION_KEYWORDS_EN]
        for (const kw of allKeywords) {
          if (lower.includes(kw)) {
            frustrationSignals.push({ type: 'keyword', turnIndex, text: `"${kw}" in: ${text.slice(0, 50)}` })
            break
          }
        }

        // Repeated instruction
        if (lastUserText && text.length > 20 && text === lastUserText) {
          frustrationSignals.push({ type: 'repeated-instruction', turnIndex, text: text.slice(0, 50) })
        }

        // Interruption
        if (text.includes('[Request interrupted')) {
          frustrationSignals.push({ type: 'interruption', turnIndex, text: 'User interrupted request' })
        }

        lastUserText = text
        if (ts > 0) lastUserTimestamp = ts
      }

      if (ts > 0) turnTimestamps.push({ ts, role: 'user', index: turnIndex })
    }
  }

  // === Calculate metrics ===

  // 1. Read:Edit Ratio
  const reads = toolCounts['Read'] || 0
  const edits = (toolCounts['Edit'] || 0) + (toolCounts['Write'] || 0)
  const readEditRatio = edits > 0 ? reads / edits : reads > 0 ? reads : 0
  const readEditHealth = edits === 0 && reads === 0 ? 'unavailable'
    : readEditRatio >= 6 ? 'healthy'
    : readEditRatio >= 2 ? 'degraded'
    : 'critical'

  // 2. Thinking depth
  const totalBlocks = thinkingBlocks.length
  const redactedCount = thinkingBlocks.filter(b => b.length === 0 && b.signature).length
  const avgSignatureLength = thinkingBlocks.length > 0
    ? thinkingBlocks.reduce((a, b) => a + (b.signature?.length || b.length), 0) / thinkingBlocks.length
    : 0

  // 3. Latencies
  const latencies: TurnLatency[] = []
  for (let i = 1; i < turnTimestamps.length; i++) {
    const prev = turnTimestamps[i - 1]
    const curr = turnTimestamps[i]
    if (curr.ts > prev.ts && curr.ts - prev.ts < 3600000) {
      latencies.push({
        turnIndex: curr.index,
        latencyMs: curr.ts - prev.ts,
        role: curr.role as 'user' | 'assistant'
      })
    }
  }
  const assistantLatencies = latencies.filter(l => l.role === 'assistant').map(l => l.latencyMs).sort((a, b) => a - b)

  // 4. Cost estimation
  const pricing = MODEL_PRICING[lastModel] || { input: 3, output: 15 }
  const inputCost = (totalInputTokens / 1_000_000) * pricing.input
  const outputCost = (totalOutputTokens / 1_000_000) * pricing.output

  // 5. Framework overhead
  const frameworkPct = totalContentTokens > 0 ? (frameworkTokens / totalContentTokens) * 100 : 0

  // 6. Anti-patterns
  // Repeated Read same file >3 times
  const readPathCounts = new Map<string, number>()
  for (const r of recentReads) {
    if (r.path) readPathCounts.set(r.path, (readPathCounts.get(r.path) || 0) + 1)
  }
  for (const [filePath, count] of readPathCounts) {
    if (count > 3) {
      antiPatterns.push({
        type: 'repeated-read',
        turnIndex: recentReads.find(r => r.path === filePath)?.turnIndex || 0,
        detail: `Read "${filePath.split('/').pop()}" ${count} times`
      })
    }
  }

  // Edit followed by editing the same file again (possible revert)
  const editPaths = recentEdits.map(e => e.path).filter(Boolean)
  for (let i = 1; i < editPaths.length; i++) {
    if (editPaths[i] === editPaths[i - 1]) {
      antiPatterns.push({
        type: 'edit-revert',
        turnIndex: recentEdits[i].turnIndex,
        detail: `Re-edited "${editPaths[i].split('/').pop()}" consecutively`
      })
    }
  }

  // === Health Score ===
  let score = 80
  if (readEditHealth === 'critical') score -= 20
  else if (readEditHealth === 'degraded') score -= 10
  if (frustrationSignals.length > 5) score -= 15
  else if (frustrationSignals.length > 2) score -= 8
  if (antiPatterns.length > 3) score -= 10
  else if (antiPatterns.length > 0) score -= 5
  if (frameworkPct > 30) score -= 10
  if (redactedCount > totalBlocks * 0.5 && totalBlocks > 5) score -= 10
  score = Math.max(0, Math.min(100, score))

  const healthLabel = score >= 80 ? 'excellent' : score >= 60 ? 'good' : score >= 40 ? 'fair' : 'poor'

  // === Findings ===
  const findings: string[] = []
  if (readEditHealth === 'critical') findings.push(`Read:Edit ratio ${readEditRatio.toFixed(1)} — editing without sufficient research (benchmark: ≥6.0)`)
  if (readEditHealth === 'degraded') findings.push(`Read:Edit ratio ${readEditRatio.toFixed(1)} — slightly below research benchmark (≥6.0)`)
  if (frameworkPct > 30) findings.push(`Framework overhead ${frameworkPct.toFixed(0)}% — system injections consuming significant context`)
  if (frustrationSignals.length > 3) findings.push(`${frustrationSignals.length} frustration signals detected — frequent corrections or interruptions`)
  if (antiPatterns.length > 0) findings.push(`${antiPatterns.length} tool anti-patterns — repeated reads or edit-reverts suggest exploration loops`)
  if (redactedCount > 0) findings.push(`${redactedCount}/${totalBlocks} thinking blocks redacted — reasoning depth may be limited`)
  if (assistantLatencies.length > 0 && percentile(assistantLatencies, 95) > 30000) {
    findings.push(`P95 response latency ${(percentile(assistantLatencies, 95) / 1000).toFixed(0)}s — some turns are very slow`)
  }

  return {
    sessionId,
    readEditRatio: { value: readEditRatio, provenance: 'reported' },
    readEditHealth,
    thinkingDepth: {
      value: { avgSignatureLength: Math.round(avgSignatureLength), redactedCount, totalBlocks },
      provenance: totalBlocks > 0 ? 'reported' : 'unavailable'
    },
    turnLatencies: latencies,
    latencyStats: {
      value: {
        p50: Math.round(percentile(assistantLatencies, 50)),
        p95: Math.round(percentile(assistantLatencies, 95)),
        max: assistantLatencies.length > 0 ? assistantLatencies[assistantLatencies.length - 1] : 0
      },
      provenance: assistantLatencies.length > 0 ? 'reported' : 'unavailable'
    },
    estimatedCost: {
      value: { inputCost, outputCost, totalCost: inputCost + outputCost, currency: 'USD' },
      provenance: totalInputTokens > 0 ? 'estimated' : 'unavailable'
    },
    frameworkOverhead: {
      value: { frameworkTokens, totalTokens: totalContentTokens, percentage: frameworkPct },
      provenance: 'estimated'
    },
    antiPatterns,
    frustrationSignals,
    healthScore: score,
    healthLabel,
    findings
  }
}
