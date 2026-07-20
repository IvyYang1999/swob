/**
 * Context Inspector — 逐轮上下文构成分析
 *
 * 从 JSONL 消息流中重建每一轮的上下文压力：
 * - 各类内容占比（用户文本/工具I-O/Thinking/系统注入/图片）
 * - compact 前后对比
 * - cache 命中率
 * - 上下文增长预警点
 */

export type ContextCategory =
  | 'user-text'
  | 'assistant-text'
  | 'tool-input'
  | 'tool-output'
  | 'system-injection'
  | 'thinking'
  | 'image'
  | 'compact-summary'
  | 'unknown'

export interface ContextSlice {
  category: ContextCategory
  tokens: number
  provenance: 'reported' | 'estimated'
}

export interface TurnContext {
  turnIndex: number
  role: 'user' | 'assistant'
  timestamp: string
  slices: ContextSlice[]
  totalTokens: number
  cumulativeTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  isCompactBoundary: boolean
  compactSummaryTokens: number
}

export interface ContextInspectorData {
  sessionId: string
  turns: TurnContext[]
  peakTokens: number
  compactEvents: Array<{ turnIndex: number; tokensBefore: number; tokensAfter: number }>
  warnings: Array<{ turnIndex: number; type: 'spike' | 'near-limit' | 'cache-miss'; message: string }>
  categoryTotals: Record<ContextCategory, number>
}

interface RawMessage {
  uuid?: string
  type?: string
  timestamp?: string
  isSidechain?: boolean
  isMeta?: boolean
  message?: {
    role?: string
    content?: string | Array<Record<string, unknown>>
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
  }
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function classifyContent(msg: RawMessage): ContextSlice[] {
  const slices: ContextSlice[] = []
  const content = msg.message?.content
  if (!content) return slices

  if (typeof content === 'string') {
    const isSystem = msg.type === 'user' && (
      content.includes('<system-reminder>') ||
      content.includes('<command-name>') ||
      content.includes('<task-notification>')
    )
    const isCompact = content.includes('Compact summary:') || content.includes('This session is being continued from a previous conversation')
    const cat: ContextCategory = isCompact ? 'compact-summary' : isSystem ? 'system-injection' : msg.type === 'user' ? 'user-text' : 'assistant-text'
    slices.push({ category: cat, tokens: estimateTokens(content), provenance: 'estimated' })
    return slices
  }

  if (!Array.isArray(content)) return slices

  for (const part of content) {
    if (part.type === 'text' && typeof part.text === 'string') {
      const text = part.text as string
      const isSystem = text.includes('<system-reminder>') || text.includes('<command-name>') || text.includes('<task-notification>')
      const isCompact = text.includes('Compact summary:') || text.includes('This session is being continued')
      if (isCompact) {
        slices.push({ category: 'compact-summary', tokens: estimateTokens(text), provenance: 'estimated' })
      } else if (isSystem) {
        slices.push({ category: 'system-injection', tokens: estimateTokens(text), provenance: 'estimated' })
      } else if (msg.type === 'user') {
        slices.push({ category: 'user-text', tokens: estimateTokens(text), provenance: 'estimated' })
      } else {
        slices.push({ category: 'assistant-text', tokens: estimateTokens(text), provenance: 'estimated' })
      }
    } else if (part.type === 'thinking' && typeof part.thinking === 'string') {
      slices.push({ category: 'thinking', tokens: estimateTokens(part.thinking as string), provenance: 'estimated' })
    } else if (part.type === 'tool_use') {
      const input = JSON.stringify(part.input || {})
      slices.push({ category: 'tool-input', tokens: estimateTokens(input), provenance: 'estimated' })
    } else if (part.type === 'tool_result') {
      const resultContent = part.content
      let text = ''
      if (typeof resultContent === 'string') text = resultContent
      else if (Array.isArray(resultContent)) {
        text = (resultContent as Array<Record<string, unknown>>)
          .filter(sub => sub.type === 'text')
          .map(sub => sub.text as string)
          .join('\n')
      }
      slices.push({ category: 'tool-output', tokens: estimateTokens(text), provenance: 'estimated' })
    } else if (part.type === 'image') {
      slices.push({ category: 'image', tokens: 1600, provenance: 'estimated' })
    } else {
      slices.push({ category: 'unknown', tokens: estimateTokens(JSON.stringify(part)), provenance: 'estimated' })
    }
  }

  return slices
}

export function buildContextInspector(messages: RawMessage[], sessionId: string): ContextInspectorData {
  const turns: TurnContext[] = []
  const compactEvents: ContextInspectorData['compactEvents'] = []
  const warnings: ContextInspectorData['warnings'] = []
  const categoryTotals: Record<ContextCategory, number> = {
    'user-text': 0, 'assistant-text': 0, 'tool-input': 0, 'tool-output': 0,
    'system-injection': 0, thinking: 0, image: 0, 'compact-summary': 0, unknown: 0
  }

  let cumTokens = 0
  let peakTokens = 0
  let turnIndex = 0
  let prevCumTokens = 0

  for (const msg of messages) {
    if (msg.isSidechain) continue
    if (!msg.type || !msg.message) continue

    const slices = classifyContent(msg)
    const usage = msg.message.usage
    const inputTokens = usage?.input_tokens || 0
    const outputTokens = usage?.output_tokens || 0
    const cacheRead = usage?.cache_read_input_tokens || 0
    const cacheCreation = usage?.cache_creation_input_tokens || 0

    // Use reported tokens when available, estimated otherwise
    let turnTotal: number
    if (usage) {
      turnTotal = inputTokens + outputTokens
      // Upgrade slice provenance if we have real data
      const estimatedTotal = slices.reduce((a, s) => a + s.tokens, 0)
      if (estimatedTotal > 0 && turnTotal > 0) {
        const ratio = turnTotal / estimatedTotal
        for (const s of slices) {
          s.tokens = Math.round(s.tokens * ratio)
          if (usage) s.provenance = 'reported'
        }
      }
    } else {
      turnTotal = slices.reduce((a, s) => a + s.tokens, 0)
    }

    cumTokens += turnTotal
    if (cumTokens > peakTokens) peakTokens = cumTokens

    const isCompactBoundary = slices.some(s => s.category === 'compact-summary')
    const compactSummaryTokens = slices.filter(s => s.category === 'compact-summary').reduce((a, s) => a + s.tokens, 0)

    if (isCompactBoundary) {
      compactEvents.push({
        turnIndex,
        tokensBefore: prevCumTokens,
        tokensAfter: cumTokens
      })
      // Compact resets cumulative context
      cumTokens = turnTotal
    }

    // Warnings
    if (turnTotal > 50000) {
      warnings.push({ turnIndex, type: 'spike', message: `Token spike: ${Math.round(turnTotal / 1000)}k in single turn` })
    }
    if (cumTokens > 180000) {
      warnings.push({ turnIndex, type: 'near-limit', message: `Context pressure: ${Math.round(cumTokens / 1000)}k cumulative` })
    }
    if (usage && inputTokens > 10000 && cacheRead === 0) {
      warnings.push({ turnIndex, type: 'cache-miss', message: `Cache miss: ${Math.round(inputTokens / 1000)}k input, 0 cache read` })
    }

    for (const s of slices) {
      categoryTotals[s.category] += s.tokens
    }

    turns.push({
      turnIndex,
      role: msg.type as 'user' | 'assistant',
      timestamp: msg.timestamp || '',
      slices,
      totalTokens: turnTotal,
      cumulativeTokens: cumTokens,
      inputTokens,
      outputTokens,
      cacheReadTokens: cacheRead,
      cacheCreationTokens: cacheCreation,
      isCompactBoundary,
      compactSummaryTokens
    })

    prevCumTokens = cumTokens
    turnIndex++
  }

  return { sessionId, turns, peakTokens, compactEvents, warnings, categoryTotals }
}
