/**
 * Synthetic Codex rollout rows in the real key order (F1b).
 *
 * Key orders come from the dispatcher's key-order census of 807 local
 * rollouts, which lists field names and counts only, never values
 * (swob-core/任务书/2026-09-26/附录-Codex键序普查-2026-09-26.md). Every real
 * row carries `ordinal`, so the outer order is always
 * { timestamp, ordinal, type, payload }. The census does not expand nested
 * event_msg payloads or `session_meta.source`; those follow the accepted C1a
 * self-test samples (src/checkup/self-test/samples.ts). All values are
 * synthetic.
 */

export type CodexFixtureRow = Record<string, unknown>

export interface CodexRowBase {
  timestamp: string
  ordinal: number
}

export interface CodexFixtureUsage {
  input: number
  cached: number
  output: number
  reasoning?: number
}

function row(base: CodexRowBase, type: string, payload: CodexFixtureRow): CodexFixtureRow {
  return { timestamp: base.timestamp, ordinal: base.ordinal, type, payload }
}

function usageObject(usage: CodexFixtureUsage): CodexFixtureRow {
  return {
    input_tokens: usage.input,
    cached_input_tokens: usage.cached,
    cache_write_input_tokens: 0,
    output_tokens: usage.output,
    reasoning_output_tokens: usage.reasoning ?? 0,
    total_tokens: usage.input + usage.output
  }
}

const CLI_VERSION = '0.0.0-synthetic'
const BASE_INSTRUCTIONS = { text: 'synthetic base instructions' }

export const codexRow = {
  /** session_meta, top-level signature (136 rows). */
  topLevelMeta(base: CodexRowBase & { id: string; cwd: string }): CodexFixtureRow {
    return row(base, 'session_meta', {
      session_id: base.id,
      id: base.id,
      timestamp: base.timestamp,
      cwd: base.cwd,
      originator: 'codex_cli_rs',
      cli_version: CLI_VERSION,
      source: 'cli',
      thread_source: 'user',
      model_provider: 'openai',
      base_instructions: BASE_INSTRUCTIONS,
      history_mode: 'full',
      context_window: 258400
    })
  },

  /** session_meta, forked thread-spawn subagent signature (91 rows). */
  threadSpawnMeta(base: CodexRowBase & {
    id: string
    parentId: string
    cwd: string
    depth: number
    historyStartOrdinal: number
    nickname?: string
  }): CodexFixtureRow {
    const nickname = base.nickname ?? 'Worker'
    const agentPath = `/root/${nickname.toLowerCase()}`
    return row(base, 'session_meta', {
      session_id: base.id,
      id: base.id,
      forked_from_id: base.parentId,
      parent_thread_id: base.parentId,
      timestamp: base.timestamp,
      cwd: base.cwd,
      originator: 'codex_cli_rs',
      cli_version: CLI_VERSION,
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: base.parentId,
            depth: base.depth,
            agent_path: agentPath,
            agent_nickname: nickname,
            agent_role: null
          }
        }
      },
      thread_source: 'subagent',
      agent_nickname: nickname,
      agent_path: agentPath,
      model_provider: 'openai',
      base_instructions: BASE_INSTRUCTIONS,
      history_mode: 'full',
      subagent_history_start_ordinal: base.historyStartOrdinal,
      multi_agent_version: 2,
      context_window: 258400
    })
  },

  /** session_meta, subagent without fork or nickname (48 rows); used for the guardian. */
  guardianMeta(base: CodexRowBase & { id: string; parentId: string; cwd: string }): CodexFixtureRow {
    return row(base, 'session_meta', {
      session_id: base.id,
      id: base.id,
      parent_thread_id: base.parentId,
      timestamp: base.timestamp,
      cwd: base.cwd,
      originator: 'codex_cli_rs',
      cli_version: CLI_VERSION,
      source: { subagent: { other: 'guardian' } },
      thread_source: 'subagent',
      model_provider: 'openai',
      base_instructions: BASE_INSTRUCTIONS,
      history_mode: 'full',
      subagent_history_start_ordinal: 0,
      multi_agent_version: 2,
      context_window: 258400
    })
  },

  /** turn_context, most common signature (1,908 rows). */
  turnContext(base: CodexRowBase & { turnId: string; cwd: string; model: string }): CodexFixtureRow {
    return row(base, 'turn_context', {
      turn_id: base.turnId,
      cwd: base.cwd,
      workspace_roots: [base.cwd],
      current_date: base.timestamp.slice(0, 10),
      timezone: 'UTC',
      approval_policy: 'on-request',
      approvals_reviewer: 'user',
      sandbox_policy: { type: 'workspace-write' },
      permission_profile: 'default',
      model: base.model,
      comp_hash: 'synthetic-comp-hash',
      personality: 'default',
      collaboration_mode: 'default',
      multi_agent_version: 2,
      realtime_active: false,
      effort: 'medium',
      summary: 'auto'
    })
  },

  userMessage(base: CodexRowBase & { text: string }): CodexFixtureRow {
    return row(base, 'response_item', {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: base.text }]
    })
  },

  assistantMessage(base: CodexRowBase & { text: string }): CodexFixtureRow {
    return row(base, 'response_item', {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: base.text }],
      phase: 'final'
    })
  },

  /** event_msg/token_count without turn_id, as real rollouts write it. */
  tokenCount(base: CodexRowBase & { total: CodexFixtureUsage; last: CodexFixtureUsage }): CodexFixtureRow {
    return row(base, 'event_msg', {
      type: 'token_count',
      info: {
        total_token_usage: usageObject(base.total),
        last_token_usage: usageObject(base.last),
        model_context_window: 258400
      },
      rate_limits: null
    })
  },

  /**
   * Top-level `compacted` row, dominant signature (724 of 1,137 rows).
   * `replacement_history` stands for the whole replaced history.
   */
  compacted(base: CodexRowBase & { message: string; window: number }): CodexFixtureRow {
    return row(base, 'compacted', {
      message: base.message,
      replacement_history: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: `carried-over request ${base.window}` }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `carried-over answer ${base.window}` }] }
      ],
      window_number: base.window,
      first_window_id: 'synthetic-window-0',
      previous_window_id: `synthetic-window-${base.window - 1}`,
      window_id: `synthetic-window-${base.window}`,
      compaction_response_id: `synthetic-compaction-response-${base.window}`,
      latest_token_usage_record: null
    })
  },

  /** response_item/compaction, the new format (7 rows). */
  compactionItem(base: CodexRowBase & { id: string }): CodexFixtureRow {
    return row(base, 'response_item', {
      type: 'compaction',
      id: base.id,
      encrypted_content: `synthetic-encrypted-${base.id}`,
      internal_chat_message_metadata_passthrough: null
    })
  },

  /** event_msg/item_completed with item.type = ContextCompaction (cross-check only). */
  contextCompactionEvent(base: CodexRowBase & { threadId: string; turnId: string; itemId: string }): CodexFixtureRow {
    return row(base, 'event_msg', {
      type: 'item_completed',
      thread_id: base.threadId,
      turn_id: base.turnId,
      item: { type: 'ContextCompaction', id: base.itemId },
      completed_at_ms: Date.parse(base.timestamp)
    })
  },

  /** event_msg/context_compacted, as in unified-session-adapter-v2.test.ts. */
  contextCompactedEvent(base: CodexRowBase): CodexFixtureRow {
    return row(base, 'event_msg', { type: 'context_compacted' })
  }
}

/** ISO timestamp `offsetMs` after `startIso`. */
export function codexTime(startIso: string, offsetMs: number): string {
  return new Date(Date.parse(startIso) + offsetMs).toISOString()
}

/** Consecutive row bases for one file: one second apart, ordinals counting up. */
export function codexClock(startIso: string, firstOrdinal = 0): () => CodexRowBase {
  let ordinal = firstOrdinal
  return () => {
    const base = { timestamp: codexTime(startIso, (ordinal - firstOrdinal) * 1000), ordinal }
    ordinal++
    return base
  }
}

/**
 * Rows a forked child writes for the history it inherits: identical payloads,
 * rewritten timestamps (the child's own clock) and the child's own ordinals.
 * Real forks keep no copied timestamp (7,872 duplicate groups, 0 with an equal
 * timestamp; design §4.5).
 */
export function copiedPrefix(
  rows: readonly CodexFixtureRow[],
  options: { startIso: string; firstOrdinal: number }
): CodexFixtureRow[] {
  return rows.map((source, index) => ({
    timestamp: codexTime(options.startIso, index),
    ordinal: options.firstOrdinal + index,
    type: source.type,
    payload: structuredClone(source.payload)
  }))
}

/** JSONL text, one record per line. */
export function codexJsonl(rows: readonly CodexFixtureRow[]): string {
  return rows.map((record) => JSON.stringify(record)).join('\n')
}
