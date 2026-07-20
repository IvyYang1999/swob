/**
 * Session Execution Tree — 解析单个会话内的 Agent/Tool 执行结构
 *
 * 从 JSONL 消息流中提取：
 * - 工具调用（tool_use → tool_result 配对）
 * - 子 Agent 派发（Agent tool_use → task-notification result）
 * - 每轮 token 用量
 * - 错误/失败
 */

export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
  timestamp: string
  result?: string
  resultTimestamp?: string
  error?: boolean
  durationMs?: number
}

export interface AgentSpawn {
  id: string
  description: string
  subagentType: string
  model?: string
  timestamp: string
  status: 'running' | 'completed' | 'failed' | 'unknown'
  resultSummary?: string
  resultTimestamp?: string
  toolCalls: ToolCall[]
}

export interface TurnInfo {
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

export interface ExecutionTree {
  sessionId: string
  turns: TurnInfo[]
  totalToolCalls: number
  totalAgentSpawns: number
  toolCallsByName: Record<string, number>
  errors: Array<{ turnIndex: number; toolName: string; message: string }>
  tokenTimeline: Array<{ turnIndex: number; cumulative: number; delta: number }>
}

interface RawMessage {
  uuid?: string
  type?: string
  timestamp?: string
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
  isSidechain?: boolean
}

function extractText(content: unknown): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Array<Record<string, unknown>>)
    .filter((p) => p.type === 'text' && p.text)
    .map((p) => p.text as string)
    .join('\n')
}

function extractToolUses(content: unknown): Array<{ id: string; name: string; input: Record<string, unknown> }> {
  if (!content || !Array.isArray(content)) return []
  return (content as Array<Record<string, unknown>>)
    .filter((p) => p.type === 'tool_use' && p.name && p.id)
    .map((p) => ({
      id: p.id as string,
      name: p.name as string,
      input: (p.input as Record<string, unknown>) || {}
    }))
}

function extractToolResults(content: unknown): Array<{ toolUseId: string; text: string; isError: boolean }> {
  if (!content || !Array.isArray(content)) return []
  return (content as Array<Record<string, unknown>>)
    .filter((p) => p.type === 'tool_result' && p.tool_use_id)
    .map((p) => {
      const resultContent = p.content
      let text = ''
      if (typeof resultContent === 'string') text = resultContent
      else if (Array.isArray(resultContent)) {
        text = (resultContent as Array<Record<string, unknown>>)
          .filter((sub) => sub.type === 'text')
          .map((sub) => sub.text as string)
          .join('\n')
      }
      return {
        toolUseId: p.tool_use_id as string,
        text: text.slice(0, 500),
        isError: p.is_error === true
      }
    })
}

export function buildExecutionTree(messages: RawMessage[], sessionId: string): ExecutionTree {
  const turns: TurnInfo[] = []
  const pendingToolCalls = new Map<string, ToolCall>()
  const pendingAgents = new Map<string, AgentSpawn>()
  const toolCallsByName: Record<string, number> = {}
  const errors: ExecutionTree['errors'] = []
  const tokenTimeline: ExecutionTree['tokenTimeline'] = []
  let cumTokens = 0
  let turnIndex = 0

  for (const msg of messages) {
    if (msg.isSidechain) continue
    if (!msg.type || !msg.message) continue

    const timestamp = msg.timestamp || ''
    const content = msg.message.content

    if (msg.type === 'assistant') {
      const text = extractText(content)
      const toolUses = extractToolUses(content)
      const turnToolCalls: ToolCall[] = []
      const turnAgentSpawns: AgentSpawn[] = []

      for (const tu of toolUses) {
        toolCallsByName[tu.name] = (toolCallsByName[tu.name] || 0) + 1

        if (tu.name === 'Agent') {
          const spawn: AgentSpawn = {
            id: tu.id,
            description: (tu.input.description as string) || '',
            subagentType: (tu.input.subagent_type as string) || 'general-purpose',
            model: tu.input.model as string | undefined,
            timestamp,
            status: 'running',
            toolCalls: []
          }
          pendingAgents.set(tu.id, spawn)
          turnAgentSpawns.push(spawn)
        } else {
          const tc: ToolCall = {
            id: tu.id,
            name: tu.name,
            input: tu.input,
            timestamp
          }
          pendingToolCalls.set(tu.id, tc)
          turnToolCalls.push(tc)
        }
      }

      const usage = msg.message.usage
      let tokenUsage: TurnInfo['tokenUsage']
      if (usage) {
        const delta = (usage.input_tokens || 0) + (usage.output_tokens || 0)
        cumTokens += delta
        tokenUsage = {
          inputTokens: usage.input_tokens || 0,
          outputTokens: usage.output_tokens || 0,
          cacheReadTokens: usage.cache_read_input_tokens || 0,
          cacheCreationTokens: usage.cache_creation_input_tokens || 0
        }
        tokenTimeline.push({ turnIndex, cumulative: cumTokens, delta })
      }

      turns.push({
        index: turnIndex,
        role: 'assistant',
        timestamp,
        textPreview: text.slice(0, 200),
        toolCalls: turnToolCalls,
        agentSpawns: turnAgentSpawns,
        tokenUsage,
        cumulativeTokens: cumTokens
      })
      turnIndex++
    } else if (msg.type === 'user') {
      const toolResults = extractToolResults(content)
      for (const tr of toolResults) {
        const pending = pendingToolCalls.get(tr.toolUseId)
        if (pending) {
          pending.result = tr.text
          pending.resultTimestamp = timestamp
          pending.error = tr.isError
          if (pending.timestamp && timestamp) {
            pending.durationMs = new Date(timestamp).getTime() - new Date(pending.timestamp).getTime()
          }
          if (tr.isError) {
            errors.push({ turnIndex: turnIndex - 1, toolName: pending.name, message: tr.text.slice(0, 200) })
          }
          pendingToolCalls.delete(tr.toolUseId)
        }
        const pendingAgent = pendingAgents.get(tr.toolUseId)
        if (pendingAgent) {
          pendingAgent.status = tr.isError ? 'failed' : 'completed'
          pendingAgent.resultSummary = tr.text.slice(0, 300)
          pendingAgent.resultTimestamp = timestamp
          pendingAgents.delete(tr.toolUseId)
        }
      }

      const text = extractText(content)
      if (text && !toolResults.length) {
        turns.push({
          index: turnIndex,
          role: 'user',
          timestamp,
          textPreview: text.slice(0, 200),
          toolCalls: [],
          agentSpawns: [],
          cumulativeTokens: cumTokens
        })
        turnIndex++
      }
    }
  }

  return {
    sessionId,
    turns,
    totalToolCalls: Object.values(toolCallsByName).reduce((a, b) => a + b, 0),
    totalAgentSpawns: Object.values(toolCallsByName).filter((_, i) =>
      Object.keys(toolCallsByName)[i] === 'Agent').reduce((a, b) => a + b, 0),
    toolCallsByName,
    errors,
    tokenTimeline
  }
}
