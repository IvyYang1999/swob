/**
 * Synthetic sample builders for the self-test and the checkup tests.
 *
 * Values are invented; key names and key order follow the real formats
 * (taken from repository tests and a key-path-only dump of real files, which
 * printed no values). Claude records: parentUuid, isSidechain, [promptId],
 * [agentId], type, message, uuid, timestamp, …; Codex rows: timestamp,
 * [ordinal], type, payload.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

export const LS = String.fromCharCode(0x2028)
export const PS = String.fromCharCode(0x2029)

const CLAUDE_VERSION = '2.1.281'
const CODEX_CLI_VERSION = '0.130.0'

/** Deterministic UUID-shaped synthetic identifier. */
export function syntheticUuid(seed: number, variant = 'c1a0'): string {
  const hex = seed.toString(16).padStart(12, '0').slice(-12)
  return `00000000-0000-4000-8000-${variant}${hex.slice(4)}`.slice(0, 36)
}

export function syntheticTime(minute: number): string {
  return new Date(Date.UTC(2026, 8, 20, 9, 0, 0) + minute * 60_000).toISOString()
}

interface ClaudeBase { uuid: string; parentUuid: string | null; sessionId: string; timestamp: string; cwd: string }

export const claude = {
  user(base: ClaudeBase & { text: string; promptId?: string }): Record<string, unknown> {
    return {
      parentUuid: base.parentUuid,
      isSidechain: false,
      promptId: base.promptId ?? `prompt-${base.uuid.slice(-4)}`,
      type: 'user',
      message: { role: 'user', content: base.text },
      uuid: base.uuid,
      timestamp: base.timestamp,
      permissionMode: 'default',
      promptSource: 'typed',
      userType: 'external',
      entrypoint: 'cli',
      cwd: base.cwd,
      sessionId: base.sessionId,
      version: CLAUDE_VERSION,
      gitBranch: 'main'
    }
  },
  toolResult(base: ClaudeBase & { toolUseId: string; output: string; sourceToolAssistantUUID: string }): Record<string, unknown> {
    return {
      parentUuid: base.parentUuid,
      isSidechain: false,
      promptId: `prompt-${base.uuid.slice(-4)}`,
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', content: base.output, is_error: false, tool_use_id: base.toolUseId }] },
      uuid: base.uuid,
      timestamp: base.timestamp,
      toolUseResult: base.output,
      sourceToolAssistantUUID: base.sourceToolAssistantUUID,
      userType: 'external',
      entrypoint: 'cli',
      cwd: base.cwd,
      sessionId: base.sessionId,
      version: CLAUDE_VERSION,
      gitBranch: 'main'
    }
  },
  assistant(base: ClaudeBase & { text: string; messageId: string; requestId: string; usage?: Partial<Record<'input' | 'cacheWrite' | 'cacheRead' | 'output', number>> }): Record<string, unknown> {
    return {
      parentUuid: base.parentUuid,
      isSidechain: false,
      message: {
        model: 'claude-opus-4-6',
        id: base.messageId,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: base.text }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: base.usage?.input ?? 10,
          cache_creation_input_tokens: base.usage?.cacheWrite ?? 0,
          cache_read_input_tokens: base.usage?.cacheRead ?? 0,
          output_tokens: base.usage?.output ?? 5,
          service_tier: 'standard'
        }
      },
      requestId: base.requestId,
      type: 'assistant',
      uuid: base.uuid,
      timestamp: base.timestamp,
      userType: 'external',
      entrypoint: 'cli',
      cwd: base.cwd,
      sessionId: base.sessionId,
      version: CLAUDE_VERSION,
      gitBranch: 'main'
    }
  },
  compactBoundary(base: ClaudeBase & { logicalParentUuid: string }): Record<string, unknown> {
    return {
      parentUuid: null,
      logicalParentUuid: base.logicalParentUuid,
      isSidechain: false,
      type: 'system',
      subtype: 'compact_boundary',
      content: 'Conversation compacted',
      level: 'info',
      compactMetadata: { trigger: 'auto', preTokens: 160000 },
      uuid: base.uuid,
      timestamp: base.timestamp,
      userType: 'external',
      entrypoint: 'cli',
      cwd: base.cwd,
      sessionId: base.sessionId,
      version: CLAUDE_VERSION,
      gitBranch: 'main',
      slug: 'synthetic-slug'
    }
  },
  compactSummary(base: ClaudeBase): Record<string, unknown> {
    return {
      parentUuid: base.parentUuid,
      isSidechain: false,
      promptId: `prompt-${base.uuid.slice(-4)}`,
      type: 'user',
      message: { role: 'user', content: 'This session is being continued from a previous conversation.' },
      isVisibleInTranscriptOnly: true,
      isCompactSummary: true,
      uuid: base.uuid,
      timestamp: base.timestamp,
      userType: 'external',
      entrypoint: 'cli',
      cwd: base.cwd,
      sessionId: base.sessionId,
      version: CLAUDE_VERSION,
      gitBranch: 'main',
      slug: 'synthetic-slug'
    }
  },
  queueOperation(input: { sessionId: string; timestamp: string; content: string }): Record<string, unknown> {
    return { type: 'queue-operation', operation: 'enqueue', timestamp: input.timestamp, sessionId: input.sessionId, content: input.content }
  },
  subagentUser(base: ClaudeBase & { agentId: string; text: string }): Record<string, unknown> {
    return {
      parentUuid: base.parentUuid,
      isSidechain: true,
      promptId: `prompt-${base.uuid.slice(-4)}`,
      agentId: base.agentId,
      type: 'user',
      message: { role: 'user', content: base.text },
      uuid: base.uuid,
      timestamp: base.timestamp,
      userType: 'external',
      entrypoint: 'cli',
      cwd: base.cwd,
      sessionId: base.sessionId,
      version: CLAUDE_VERSION,
      gitBranch: 'main'
    }
  },
  subagentAssistant(base: ClaudeBase & { agentId: string; text: string; messageId: string; requestId: string }): Record<string, unknown> {
    return {
      parentUuid: base.parentUuid,
      isSidechain: true,
      agentId: base.agentId,
      message: {
        model: 'claude-opus-4-6',
        id: base.messageId,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: base.text }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 2, service_tier: 'standard' }
      },
      requestId: base.requestId,
      type: 'assistant',
      uuid: base.uuid,
      timestamp: base.timestamp,
      userType: 'external',
      entrypoint: 'cli',
      cwd: base.cwd,
      sessionId: base.sessionId,
      version: CLAUDE_VERSION,
      gitBranch: 'main'
    }
  }
}

interface CodexRowBase { timestamp: string; ordinal?: number }

function codexRow(base: CodexRowBase, type: string, payload: Record<string, unknown>): Record<string, unknown> {
  return base.ordinal === undefined
    ? { timestamp: base.timestamp, type, payload }
    : { timestamp: base.timestamp, ordinal: base.ordinal, type, payload }
}

export interface CodexUsage { input: number; cached: number; output: number; reasoning?: number }

function usageObject(usage: CodexUsage): Record<string, number> {
  return {
    input_tokens: usage.input,
    cached_input_tokens: usage.cached,
    cache_write_input_tokens: 0,
    output_tokens: usage.output,
    reasoning_output_tokens: usage.reasoning ?? 0,
    total_tokens: usage.input + usage.output
  }
}

export const codex = {
  topLevelMeta(base: CodexRowBase & { id: string; cwd: string }): Record<string, unknown> {
    return codexRow(base, 'session_meta', {
      session_id: base.id,
      id: base.id,
      timestamp: base.timestamp,
      cwd: base.cwd,
      originator: 'codex_cli_rs',
      cli_version: CODEX_CLI_VERSION,
      source: 'cli',
      thread_source: 'user',
      model_provider: 'openai',
      base_instructions: { text: 'synthetic base instructions' }
    })
  },
  legacyTopLevelMeta(base: CodexRowBase & { id: string; cwd: string }): Record<string, unknown> {
    return codexRow({ timestamp: base.timestamp }, 'session_meta', {
      id: base.id,
      timestamp: base.timestamp,
      cwd: base.cwd,
      originator: 'codex_cli_rs',
      cli_version: '0.46.0',
      source: 'cli',
      model_provider: 'openai',
      base_instructions: { text: 'synthetic base instructions' }
    })
  },
  threadSpawnMeta(base: CodexRowBase & { id: string; parentId: string; cwd: string; depth?: number; historyStartOrdinal?: number; forked?: boolean }): Record<string, unknown> {
    return codexRow(base, 'session_meta', {
      session_id: base.id,
      id: base.id,
      ...(base.forked === false ? {} : { forked_from_id: base.parentId }),
      parent_thread_id: base.parentId,
      timestamp: base.timestamp,
      cwd: base.cwd,
      originator: 'codex_cli_rs',
      cli_version: CODEX_CLI_VERSION,
      source: { subagent: { thread_spawn: { parent_thread_id: base.parentId, depth: base.depth ?? 1, agent_path: '/root/worker', agent_nickname: 'Worker', agent_role: null } } },
      thread_source: 'subagent',
      agent_nickname: 'Worker',
      agent_path: '/root/worker',
      model_provider: 'openai',
      base_instructions: { text: 'synthetic base instructions' },
      subagent_history_start_ordinal: base.historyStartOrdinal ?? 0
    })
  },
  guardianMeta(base: CodexRowBase & { id: string; parentId: string; cwd: string }): Record<string, unknown> {
    return codexRow(base, 'session_meta', {
      session_id: base.id,
      id: base.id,
      parent_thread_id: base.parentId,
      timestamp: base.timestamp,
      cwd: base.cwd,
      originator: 'codex_cli_rs',
      cli_version: CODEX_CLI_VERSION,
      source: { subagent: { other: 'guardian' } },
      thread_source: 'subagent',
      model_provider: 'openai',
      base_instructions: { text: 'synthetic base instructions' },
      subagent_history_start_ordinal: 0
    })
  },
  userMessage(base: CodexRowBase & { text: string }): Record<string, unknown> {
    return codexRow(base, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: base.text }] })
  },
  assistantMessage(base: CodexRowBase & { text: string }): Record<string, unknown> {
    return codexRow(base, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: base.text }], phase: 'final' })
  },
  agentMessage(base: CodexRowBase & { text: string }): Record<string, unknown> {
    return codexRow(base, 'event_msg', { type: 'agent_message', message: base.text, phase: 'final' })
  },
  functionCallOutput(base: CodexRowBase & { callId: string; output: string }): Record<string, unknown> {
    return codexRow(base, 'response_item', { type: 'function_call_output', call_id: base.callId, output: base.output })
  },
  tokenCount(base: CodexRowBase & { total: CodexUsage; last: CodexUsage }): Record<string, unknown> {
    return codexRow(base, 'event_msg', {
      type: 'token_count',
      info: { total_token_usage: usageObject(base.total), last_token_usage: usageObject(base.last), model_context_window: 258400 },
      rate_limits: null
    })
  },
  compacted(base: CodexRowBase & { message: string }): Record<string, unknown> {
    return codexRow(base, 'compacted', base.ordinal === undefined
      ? { message: base.message }
      : { message: base.message, replacement_history: [], compaction_response_id: null, latest_token_usage_record: null })
  },
  contextCompactionEvent(base: CodexRowBase & { threadId: string; turnId: string; itemId: string }): Record<string, unknown> {
    return codexRow(base, 'event_msg', {
      type: 'item_completed',
      thread_id: base.threadId,
      turn_id: base.turnId,
      item: { type: 'ContextCompaction', id: base.itemId },
      completed_at_ms: Date.parse(base.timestamp)
    })
  }
}

/** Serialise records as JSONL (records separated by `\n`). */
export function jsonl(records: Array<Record<string, unknown> | string>, options: { trailingNewline?: boolean } = {}): string {
  const body = records.map((record) => typeof record === 'string' ? record : JSON.stringify(record)).join('\n')
  return options.trailingNewline === false ? body : `${body}\n`
}

export function writeSample(root: string, relative: string, content: string): string {
  const target = path.join(root, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
  return target
}

/** Claude project directory name for a synthetic cwd (Claude encodes `/` as `-`). */
export function claudeProjectDir(cwd: string): string {
  return cwd.replace(/[/.]/g, '-')
}

/** Codex rollout relative path for a synthetic id. */
export function codexRolloutPath(id: string, minute: number, container: 'sessions' | 'archived_sessions' = 'sessions'): string {
  const stamp = syntheticTime(minute).replace(/\.\d{3}Z$/, '').replace(/:/g, '-')
  const name = `rollout-${stamp}-${id}.jsonl`
  return container === 'sessions' ? path.join('.codex', 'sessions', '2026', '09', '20', name) : path.join('.codex', 'archived_sessions', name)
}
