/**
 * Session Audit Engine — experimental, explainable session-quality signals.
 *
 * The audit intentionally keeps observed facts separate from heuristics. Every
 * displayed metric carries line-addressable evidence and an explicit caveat;
 * the health score is a transparent heuristic, not an objective quality grade.
 * Framework marker sizing measures visible marker text in user messages only —
 * it is not API context overhead (t106 semantics).
 */
import type { RawJsonlMessage } from './types'
import { accountClaudeUsage, type TokenAccounting } from './token-accounting'
import {
  aggregateValuations,
  valuationForAccounting,
  valueUsageEvent,
  type Valuation
} from './token-valuation'

export type AuditProvenance = 'reported' | 'estimated' | 'unavailable'
export type AuditEvidenceKind =
  | 'tool-use'
  | 'tool-result'
  | 'usage'
  | 'thinking'
  | 'framework'
  | 'latency'
  | 'frustration'

export interface AuditEvidence {
  line: number
  messageUuid?: string
  role: 'user' | 'assistant'
  kind: AuditEvidenceKind
  excerpt: string
}

export interface AuditMetric<T> {
  value: T
  provenance: AuditProvenance
  evidence: AuditEvidence[]
  caveat: string
}

export interface ToolAntiPattern {
  type: 'repeated-read' | 'edit-revert' | 'ignored-agent' | 'excessive-bash-retry'
  turnIndex: number
  detail: string
  evidence: AuditEvidence[]
}

export interface FrustrationSignal {
  type: 'rapid-correction' | 'keyword' | 'repeated-instruction' | 'interruption'
  turnIndex: number
  text: string
  evidence: AuditEvidence[]
}

export interface TurnLatency {
  turnIndex: number
  latencyMs: number
  role: 'user' | 'assistant'
  evidence: AuditEvidence[]
}

export interface ModelUsage {
  model: string
  turns: number
  inputTokens: number
  outputTokens: number
  valuation: Valuation
}

export interface ToolEfficiency {
  name: string
  count: number
  errorCount: number
  errorRate: number
  avgLatencyMs: number
  evidence: AuditEvidence[]
}

export interface AuditScoreFactor {
  key: string
  impact: number
  detail: string
  evidence: AuditEvidence[]
}

export type SessionType = 'coding' | 'research' | 'debugging' | 'discussion' | 'mixed'

export interface SessionAuditResult {
  sessionId: string
  experimental: true
  methodologyVersion: 'experimental-v2'
  readEditHealthBasis: 'heuristic-unvalidated'
  limitations: string[]

  readEditRatio: AuditMetric<number>
  readEditHealth: 'healthy' | 'degraded' | 'critical' | 'unavailable'
  thinkingDepth: AuditMetric<{ avgSignatureLength: number; redactedCount: number; totalBlocks: number }>
  turnLatencies: TurnLatency[]
  latencyStats: AuditMetric<{ p50: number; p95: number; max: number }>
  valuation: AuditMetric<Valuation>
  visibleFrameworkMarkers: AuditMetric<{
    estimatedMarkerTokens: number
    estimatedVisibleUserTokens: number
    shareOfVisibleUserText: number
  }>

  sessionType: SessionType
  modelUsage: ModelUsage[]
  toolEfficiency: ToolEfficiency[]
  userInterruptions: number
  avgTurnsPerGoal: number
  antiPatterns: ToolAntiPattern[]
  frustrationSignals: FrustrationSignal[]

  healthScore: number
  healthLabel: 'excellent' | 'good' | 'fair' | 'poor'
  scoreFactors: AuditScoreFactor[]
  findings: string[]
}

interface ToolUse {
  id: string
  name: string
  path: string
}

interface ThinkingBlock {
  length: number
  signature?: string
}

const FRUSTRATION_KEYWORDS_ZH = ['不对', '错了', '别这样', '回滚', '撤销', '不是这个意思', '搞错了', '重来']
const FRUSTRATION_KEYWORDS_EN = ['no, not', "that's wrong", 'redo this', 'revert it', 'undo that', "that's not what"]

function extractToolUses(content: unknown): ToolUse[] {
  if (!Array.isArray(content)) return []
  return (content as Array<Record<string, unknown>>)
    .filter((part) => part.type === 'tool_use' && typeof part.name === 'string')
    .map((part) => {
      const input = part.input && typeof part.input === 'object'
        ? part.input as Record<string, unknown>
        : {}
      return {
        id: typeof part.id === 'string' ? part.id : '',
        name: part.name as string,
        path: typeof input.file_path === 'string'
          ? input.file_path
          : typeof input.command === 'string' ? input.command : ''
      }
    })
}

function extractThinkingBlocks(content: unknown): ThinkingBlock[] {
  if (!Array.isArray(content)) return []
  return (content as Array<Record<string, unknown>>)
    .filter((part) => part.type === 'thinking')
    .map((part) => ({
      length: typeof part.thinking === 'string' ? part.thinking.length : 0,
      signature: typeof part.signature === 'string' ? part.signature : undefined
    }))
}

function extractText(content: unknown): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Array<Record<string, unknown>>)
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n')
}

const FRAMEWORK_TAG_PATTERN = 'system-reminder|command-name|task-notification|local-command-[^>\\s]+|user-prompt-submit-hook'

function extractVisibleFrameworkContent(text: string): string {
  const paired = new RegExp(`<(${FRAMEWORK_TAG_PATTERN})[^>]*>[\\s\\S]*?<\\/\\1>`, 'gi')
  const matches = text.match(paired)
  if (matches) return matches.join('\n')
  // Some harness rows persist only a marker/opening tag. Count that literal row,
  // never the whole user message and never claim it represents hidden context.
  const markerLines = new RegExp(`^.*<(?:${FRAMEWORK_TAG_PATTERN})[^>]*>.*$`, 'gim')
  return (text.match(markerLines) || []).join('\n')
}

function isFrameworkContent(text: string): boolean {
  return extractVisibleFrameworkContent(text).length > 0
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const index = Math.ceil(sorted.length * p / 100) - 1
  return sorted[Math.max(0, index)]
}

function evidence(
  line: number,
  message: RawJsonlMessage,
  role: 'user' | 'assistant',
  kind: AuditEvidenceKind,
  excerpt: string
): AuditEvidence {
  return { line, messageUuid: message.uuid, role, kind, excerpt: excerpt.slice(0, 160) }
}

export function auditSession(
  messages: RawJsonlMessage[],
  sessionId: string,
  tokenAccounting?: TokenAccounting
): SessionAuditResult {
  const toolCounts: Record<string, number> = {}
  const toolErrors: Record<string, number> = {}
  const toolLatencies: Record<string, number[]> = {}
  const toolEvidence: Record<string, AuditEvidence[]> = {}
  const toolUsesById = new Map<string, { name: string; startedAt: number }>()
  const thinkingBlocks: Array<ThinkingBlock & { evidence: AuditEvidence }> = []
  const usageEvidence: AuditEvidence[] = []
  const frameworkEvidence: AuditEvidence[] = []
  const turnTimestamps: Array<{
    ts: number
    role: 'user' | 'assistant'
    index: number
    evidence: AuditEvidence
  }> = []
  const antiPatterns: ToolAntiPattern[] = []
  const frustrationSignals: FrustrationSignal[] = []
  const modelTurns: Record<string, number> = {}
  let visibleFrameworkMarkerTokens = 0
  let visibleUserTextTokens = 0
  let turnIndex = 0
  let userInterruptions = 0

  const recentReads: Array<{ path: string; turnIndex: number; evidence: AuditEvidence }> = []
  const recentEdits: Array<{ path: string; turnIndex: number; evidence: AuditEvidence }> = []
  let lastUserTimestamp = 0
  let lastUserText = ''
  let consecutiveShortUserMsgs = 0

  messages.forEach((message, messageIndex) => {
    if (message.isSidechain || !message.type || !message.message) return
    const line = messageIndex + 1
    const content = message.message.content
    const timestamp = message.timestamp ? new Date(message.timestamp).getTime() : 0

    if (message.type === 'assistant') {
      for (const tool of extractToolUses(content)) {
        const toolUseEvidence = evidence(line, message, 'assistant', 'tool-use', `${tool.name} invoked`)
        toolCounts[tool.name] = (toolCounts[tool.name] || 0) + 1
        ;(toolEvidence[tool.name] ||= []).push(toolUseEvidence)
        if (tool.id) toolUsesById.set(tool.id, { name: tool.name, startedAt: timestamp })
        if (tool.name === 'Read') recentReads.push({ path: tool.path, turnIndex, evidence: toolUseEvidence })
        if (tool.name === 'Edit' || tool.name === 'Write') {
          recentEdits.push({ path: tool.path, turnIndex, evidence: toolUseEvidence })
        }
      }

      for (const block of extractThinkingBlocks(content)) {
        thinkingBlocks.push({
          ...block,
          evidence: evidence(line, message, 'assistant', 'thinking',
            block.length > 0 ? `thinking block (${block.length} chars)` : 'redacted thinking block')
        })
      }

      const usage = message.message.usage
      if (usage) {
        usageEvidence.push(evidence(
          line,
          message,
          'assistant',
          'usage',
          `reported usage: input=${usage.input_tokens || 0}, output=${usage.output_tokens || 0}`
        ))
      }
      if (message.message.model) {
        modelTurns[message.message.model] = (modelTurns[message.message.model] || 0) + 1
      }

      if (timestamp > 0) {
        turnTimestamps.push({
          ts: timestamp,
          role: 'assistant',
          index: turnIndex,
          evidence: evidence(line, message, 'assistant', 'latency', `assistant timestamp ${message.timestamp}`)
        })
      }
      turnIndex++
      return
    }

    if (message.type !== 'user') return
    const text = extractText(content)
    // Visible marker estimate only. This does not observe the full request body.
    const visibleFrameworkContent = extractVisibleFrameworkContent(text)
    if (visibleFrameworkContent) {
      visibleFrameworkMarkerTokens += estimateTokens(visibleFrameworkContent)
      frameworkEvidence.push(evidence(
        line,
        message,
        'user',
        'framework',
        `visible framework marker (${visibleFrameworkContent.length} chars)`
      ))
    }
    visibleUserTextTokens += estimateTokens(text)

    if (Array.isArray(content)) {
      for (const part of content as unknown as Array<Record<string, unknown>>) {
        if (part.type !== 'tool_result' || typeof part.tool_use_id !== 'string') continue
        const matchedTool = toolUsesById.get(part.tool_use_id)
        if (!matchedTool) continue
        const resultEvidence = evidence(
          line,
          message,
          'user',
          'tool-result',
          `${matchedTool.name} result${part.is_error === true ? ' (error)' : ''}`
        )
        ;(toolEvidence[matchedTool.name] ||= []).push(resultEvidence)
        if (part.is_error === true) {
          toolErrors[matchedTool.name] = (toolErrors[matchedTool.name] || 0) + 1
        }
        const latency = timestamp - matchedTool.startedAt
        if (matchedTool.startedAt > 0 && latency >= 0 && latency < 3_600_000) {
          ;(toolLatencies[matchedTool.name] ||= []).push(latency)
        }
      }
    }

    if (text && !isFrameworkContent(text)) {
      const frustrationEvidence = evidence(line, message, 'user', 'frustration', text)
      if (timestamp > 0 && lastUserTimestamp > 0 && timestamp - lastUserTimestamp < 10_000 && text.length < 100) {
        consecutiveShortUserMsgs++
        if (consecutiveShortUserMsgs >= 2) {
          frustrationSignals.push({
            type: 'rapid-correction',
            turnIndex,
            text: text.slice(0, 60),
            evidence: [frustrationEvidence]
          })
        }
      } else {
        consecutiveShortUserMsgs = 0
      }

      if (text.length < 150) {
        const lower = text.toLowerCase()
        for (const keyword of [...FRUSTRATION_KEYWORDS_ZH, ...FRUSTRATION_KEYWORDS_EN]) {
          if (lower.startsWith(keyword) || lower.includes(keyword)) {
            frustrationSignals.push({
              type: 'keyword',
              turnIndex,
              text: `"${keyword}" in: ${text.slice(0, 50)}`,
              evidence: [frustrationEvidence]
            })
            break
          }
        }
      }

      if (lastUserText && text.length > 20 && text === lastUserText) {
        frustrationSignals.push({
          type: 'repeated-instruction',
          turnIndex,
          text: text.slice(0, 50),
          evidence: [frustrationEvidence]
        })
      }
      if (text.includes('[Request interrupted')) {
        userInterruptions++
        frustrationSignals.push({
          type: 'interruption',
          turnIndex,
          text: 'User interrupted request',
          evidence: [frustrationEvidence]
        })
      }
      lastUserText = text
      if (timestamp > 0) lastUserTimestamp = timestamp
    }

    if (timestamp > 0) {
      turnTimestamps.push({
        ts: timestamp,
        role: 'user',
        index: turnIndex,
        evidence: evidence(line, message, 'user', 'latency', `user timestamp ${message.timestamp}`)
      })
    }
  })

  const reads = toolCounts.Read || 0
  const edits = (toolCounts.Edit || 0) + (toolCounts.Write || 0)
  const readEditRatio = edits > 0 ? reads / edits : reads > 0 ? reads : 0
  const readEditHealth = edits === 0 && reads === 0 ? 'unavailable'
    : readEditRatio >= 6 ? 'healthy'
    : readEditRatio >= 2 ? 'degraded'
    : 'critical'
  const readEditEvidence = [...(toolEvidence.Read || []), ...(toolEvidence.Edit || []), ...(toolEvidence.Write || [])]

  const totalBlocks = thinkingBlocks.length
  const redactedCount = thinkingBlocks.filter((block) => block.length === 0 && block.signature).length
  const avgSignatureLength = totalBlocks > 0
    ? thinkingBlocks.reduce((total, block) => total + (block.signature?.length || block.length), 0) / totalBlocks
    : 0

  const latencies: TurnLatency[] = []
  for (let index = 1; index < turnTimestamps.length; index++) {
    const previous = turnTimestamps[index - 1]
    const current = turnTimestamps[index]
    if (current.ts > previous.ts && current.ts - previous.ts < 3_600_000) {
      latencies.push({
        turnIndex: current.index,
        latencyMs: current.ts - previous.ts,
        role: current.role,
        evidence: [previous.evidence, current.evidence]
      })
    }
  }
  const assistantLatencies = latencies
    .filter((latency) => latency.role === 'assistant')
    .map((latency) => latency.latencyMs)
    .sort((a, b) => a - b)
  const latencyEvidence = latencies
    .filter((latency) => latency.role === 'assistant')
    .flatMap((latency) => latency.evidence)

  const accounting = tokenAccounting || accountClaudeUsage(messages)
  const valuation = valuationForAccounting(accounting)
  // Visible framework-marker share within user text. Never treat as context overhead.
  const visibleMarkerShare = visibleUserTextTokens > 0
    ? (visibleFrameworkMarkerTokens / visibleUserTextTokens) * 100
    : 0

  const readPathCounts = new Map<string, number>()
  for (const read of recentReads) {
    if (read.path) readPathCounts.set(read.path, (readPathCounts.get(read.path) || 0) + 1)
  }
  const readThreshold = Math.max(5, Math.floor(turnIndex / 10))
  for (const [filePath, count] of readPathCounts) {
    if (count > readThreshold) {
      antiPatterns.push({
        type: 'repeated-read',
        turnIndex: recentReads.find((read) => read.path === filePath)?.turnIndex || 0,
        detail: `Read "${filePath.split('/').pop()}" ${count} times`,
        evidence: recentReads.filter((read) => read.path === filePath).map((read) => read.evidence)
      })
    }
  }
  const editsWithPaths = recentEdits.filter((edit) => Boolean(edit.path))
  for (let index = 1; index < editsWithPaths.length; index++) {
    if (editsWithPaths[index].path === editsWithPaths[index - 1].path) {
      antiPatterns.push({
        type: 'edit-revert',
        turnIndex: editsWithPaths[index].turnIndex,
        detail: `Re-edited "${editsWithPaths[index].path.split('/').pop()}" consecutively`,
        evidence: [editsWithPaths[index - 1].evidence, editsWithPaths[index].evidence]
      })
    }
  }

  const scoreFactors: AuditScoreFactor[] = []
  if (frustrationSignals.length > 5) {
    scoreFactors.push({
      key: 'frustration-signals',
      impact: -15,
      detail: `${frustrationSignals.length} frustration signals`,
      evidence: frustrationSignals.flatMap((signal) => signal.evidence)
    })
  } else if (frustrationSignals.length > 2) {
    scoreFactors.push({
      key: 'frustration-signals',
      impact: -8,
      detail: `${frustrationSignals.length} frustration signals`,
      evidence: frustrationSignals.flatMap((signal) => signal.evidence)
    })
  }
  if (antiPatterns.length > 3) {
    scoreFactors.push({
      key: 'tool-anti-patterns',
      impact: -10,
      detail: `${antiPatterns.length} heuristic tool anti-patterns`,
      evidence: antiPatterns.flatMap((pattern) => pattern.evidence)
    })
  } else if (antiPatterns.length > 0) {
    scoreFactors.push({
      key: 'tool-anti-patterns',
      impact: -5,
      detail: `${antiPatterns.length} heuristic tool anti-patterns`,
      evidence: antiPatterns.flatMap((pattern) => pattern.evidence)
    })
  }
  if (redactedCount > totalBlocks * 0.5 && totalBlocks > 5) {
    scoreFactors.push({
      key: 'redacted-thinking',
      impact: -10,
      detail: `${redactedCount}/${totalBlocks} thinking blocks redacted`,
      evidence: thinkingBlocks.filter((block) => block.length === 0 && block.signature).map((block) => block.evidence)
    })
  }
  const score = Math.max(0, Math.min(100,
    80 + scoreFactors.reduce((total, factor) => total + factor.impact, 0)))
  const healthLabel = score >= 80 ? 'excellent' : score >= 60 ? 'good' : score >= 40 ? 'fair' : 'poor'

  const findings: string[] = []
  if (readEditHealth === 'critical') {
    findings.push(`Read:Edit ratio ${readEditRatio.toFixed(1)} — experimental heuristic band; excluded from score`)
  }
  if (readEditHealth === 'degraded') {
    findings.push(`Read:Edit ratio ${readEditRatio.toFixed(1)} — experimental heuristic band; excluded from score`)
  }
  if (frustrationSignals.length > 3) findings.push(`${frustrationSignals.length} possible frustration signals detected`)
  if (antiPatterns.length > 0) findings.push(`${antiPatterns.length} heuristic tool anti-patterns detected`)
  if (redactedCount > 0) findings.push(`${redactedCount}/${totalBlocks} thinking blocks redacted; reasoning quality cannot be inferred`)
  if (assistantLatencies.length > 0 && percentile(assistantLatencies, 95) > 30_000) {
    findings.push(`P95 response latency ${(percentile(assistantLatencies, 95) / 1000).toFixed(0)}s`)
  }

  const totalTools = Object.values(toolCounts).reduce((total, count) => total + count, 0)
  const editTools = (toolCounts.Edit || 0) + (toolCounts.Write || 0)
  const readTools = toolCounts.Read || 0
  const bashTools = toolCounts.Bash || 0
  const searchTools = (toolCounts.WebSearch || 0) + (toolCounts.WebFetch || 0) + (toolCounts.Grep || 0)
  const sessionType: SessionType = totalTools === 0 ? 'discussion'
    : editTools > totalTools * 0.3 ? 'coding'
    : searchTools > totalTools * 0.3 ? 'research'
    : bashTools > totalTools * 0.3 && (toolErrors.Bash || 0) > 0 ? 'debugging'
    : readTools > totalTools * 0.5 ? 'research'
    : 'mixed'

  const modelEvents = new Map<string, typeof accounting.usageEvents>()
  const attributedRawModels = new Set<string>()
  for (const event of accounting.usageEvents) {
    const model = event.modelCanonical || event.modelRaw
    if (!model) continue
    if (event.modelRaw) attributedRawModels.add(event.modelRaw)
    const events = modelEvents.get(model) || []
    events.push(event)
    modelEvents.set(model, events)
  }
  const modelNames = new Set([
    ...modelEvents.keys(),
    ...Object.keys(modelTurns).filter((model) => !attributedRawModels.has(model))
  ])
  const modelUsage: ModelUsage[] = [...modelNames].map((model) => {
    const events = modelEvents.get(model) || []
    const components = events.reduce((total, event) => ({
      input: total.input + event.components.nonCachedInputTokens + event.components.cacheReadTokens +
        event.components.cacheWriteTokens + event.components.cacheWrite5mTokens + event.components.cacheWrite1hTokens,
      output: total.output + event.components.outputTokens
    }), { input: 0, output: 0 })
    return {
      model,
      turns: events.length > 0
        ? [...new Set(events.map((event) => event.modelRaw).filter((raw): raw is string => Boolean(raw)))]
            .reduce((sum, raw) => sum + (modelTurns[raw] || 0), 0) || events.length
        : modelTurns[model] || 0,
      inputTokens: components.input,
      outputTokens: components.output,
      valuation: aggregateValuations(events.map((event) => valueUsageEvent(event)))
    }
  }).sort((a, b) => b.turns - a.turns)

  const toolEfficiency: ToolEfficiency[] = Object.entries(toolCounts)
    .filter(([, count]) => count >= 2)
    .map(([name, count]) => {
      const observedLatencies = toolLatencies[name] || []
      return {
        name,
        count,
        errorCount: toolErrors[name] || 0,
        errorRate: (toolErrors[name] || 0) / count,
        avgLatencyMs: observedLatencies.length > 0
          ? observedLatencies.reduce((total, latency) => total + latency, 0) / observedLatencies.length
          : 0,
        evidence: toolEvidence[name] || []
      }
    })
    .sort((left, right) => right.count - left.count)

  const pureUserMessages = turnTimestamps.filter((turn) => turn.role === 'user').length
  const avgTurnsPerGoal = pureUserMessages > 0 ? turnIndex / pureUserMessages : turnIndex

  return {
    sessionId,
    experimental: true,
    methodologyVersion: 'experimental-v2',
    readEditHealthBasis: 'heuristic-unvalidated',
    limitations: [
      'Read/Edit health bands and the health score are unvalidated heuristics.',
      'API equivalent (estimate) uses an embedded, versioned public-price snapshot; it is not provider billing or cash spend.',
      'Framework tokens are estimated from character count, not provider token attribution.',
      'Context Inspector category attribution remains estimated even when its total token count is provider-reported.',
      'Sidechain messages and child transcript files are not recursively audited.',
      'Thinking blocks, session type, frustration, and anti-pattern signals are proxies rather than quality facts.'
    ],
    readEditRatio: {
      value: readEditRatio,
      provenance: 'reported',
      evidence: readEditEvidence,
      caveat: 'Counts are observed; ≥6/≥2 health bands are an unvalidated heuristic and are excluded from score.'
    },
    readEditHealth,
    thinkingDepth: {
      value: { avgSignatureLength: Math.round(avgSignatureLength), redactedCount, totalBlocks },
      provenance: totalBlocks > 0 ? 'reported' : 'unavailable',
      evidence: thinkingBlocks.map((block) => block.evidence),
      caveat: 'Thinking/signature block shape is observable, but it does not measure reasoning depth or quality.'
    },
    turnLatencies: latencies,
    latencyStats: {
      value: {
        p50: Math.round(percentile(assistantLatencies, 50)),
        p95: Math.round(percentile(assistantLatencies, 95)),
        max: assistantLatencies.length > 0 ? assistantLatencies[assistantLatencies.length - 1] : 0
      },
      provenance: assistantLatencies.length > 0 ? 'reported' : 'unavailable',
      evidence: latencyEvidence,
      caveat: 'Derived from adjacent message timestamps; queue, network, and user think time are not separated.'
    },
    valuation: {
      value: valuation,
      provenance: valuation.mode === 'reported' ? 'reported' : valuation.mode === 'unpriced' ? 'unavailable' : 'estimated',
      evidence: usageEvidence,
      caveat: 'API 等价值(估算)：逐请求按模型、Provider、事件时间与缓存桶计算；未匹配项保持未计价，不代表实际现金支出。'
    },
    visibleFrameworkMarkers: {
      value: {
        estimatedMarkerTokens: visibleFrameworkMarkerTokens,
        estimatedVisibleUserTokens: visibleUserTextTokens,
        shareOfVisibleUserText: visibleMarkerShare
      },
      provenance: 'estimated',
      evidence: frameworkEvidence,
      caveat: 'Visible framework markers in user messages, four characters per token; not API context overhead.'
    },
    sessionType,
    modelUsage,
    toolEfficiency,
    userInterruptions,
    avgTurnsPerGoal,
    antiPatterns,
    frustrationSignals,
    healthScore: score,
    healthLabel,
    scoreFactors,
    findings
  }
}
