import type { RawJsonlMessage, SessionSource, TranscriptOrigin } from './types'

const SUPPORTED_ORIGINS = new Set<TranscriptOrigin>([
  'human',
  'task-notification',
  'hook',
  'command',
  'tool',
  'unknown'
])

const STRUCTURED_HUMAN_PROMPT_SOURCES = new Set([
  'typed',
  'queued',
  'suggestion_accepted',
  // User-input entrypoints outside the terminal typing path. Empirically these
  // carry real human prompts (desktop app / remote control = 'external',
  // SDK-launched interactive sessions = 'sdk'). Machine-injected content in
  // these sessions still gets caught by the tag/prefix checks above this list.
  'external',
  'sdk'
])

const COMMAND_TAGS = new Set([
  'command-name',
  'command-message',
  'command-args',
  'local-command-stdout',
  'local-command-caveat',
  'bash-input',
  'bash-stdout'
])

const HOOK_TAGS = new Set([
  'system-reminder',
  'user-prompt-submit-hook'
])

const ORDINARY_HUMAN_CONTENT_TYPES = new Set([
  'text',
  'image',
  'document'
])

const UNKNOWN_MACHINE_PREFIXES = [
  'This session is being continued',
  'Base directory for this skill:',
  '[Request interrupted',
  'Conversation compacted'
]

const UNKNOWN_MACHINE_MESSAGES = new Set([
  'Continue from where you left off.',
  'Tool loaded.',
  'No response requested.'
])

const IMAGE_SOURCE_PLACEHOLDERS = /^(?:\[Image: source: [^\]]+\]\s*)+$/

function hasOwnOrigin(message: RawJsonlMessage): boolean {
  return Object.prototype.hasOwnProperty.call(message, 'origin')
}

function structuredOrigin(message: RawJsonlMessage): TranscriptOrigin | null {
  if (!hasOwnOrigin(message)) return null
  const kind = typeof message.origin === 'string' ? message.origin : message.origin?.kind
  if (typeof kind === 'string' && SUPPORTED_ORIGINS.has(kind as TranscriptOrigin)) {
    return kind as TranscriptOrigin
  }
  return 'unknown'
}

function firstContentText(message: RawJsonlMessage): string {
  const content = message.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  for (const part of content as unknown[]) {
    if (typeof part === 'string' && part.trim()) return part
    if (part && typeof part === 'object') {
      const item = part as { type?: unknown; text?: unknown }
      if (item.type === 'text' && typeof item.text === 'string' && item.text.trim()) return item.text
    }
  }
  return ''
}

function leadingTag(text: string): string | null {
  return text.trimStart().match(/^<([A-Za-z][A-Za-z0-9-]*)(?:\s[^>]*)?>/)?.[1] || null
}

function isOrdinaryHumanContent(message: RawJsonlMessage): boolean {
  const content = message.message?.content
  if (typeof content === 'string') return content.trim().length > 0
  if (!Array.isArray(content) || content.length === 0) return false

  let hasMeaningfulPart = false
  for (const part of content as unknown[]) {
    if (typeof part === 'string') {
      if (part.trim()) hasMeaningfulPart = true
      continue
    }
    if (!part || typeof part !== 'object') return false
    const item = part as { type?: unknown; text?: unknown }
    if (typeof item.type !== 'string' || !ORDINARY_HUMAN_CONTENT_TYPES.has(item.type)) return false
    if (item.type !== 'text' || (typeof item.text === 'string' && item.text.trim())) {
      hasMeaningfulPart = true
    }
  }
  return hasMeaningfulPart
}

/**
 * Classify the source of a transcript input record.
 *
 * `origin.kind` is authoritative when present. Legacy label matching is restricted
 * to the start of the first non-blank text part so quoted tags in a human message stay human.
 */
export function detectTranscriptOrigin(
  message: RawJsonlMessage,
  source: SessionSource = 'claude-code'
): TranscriptOrigin {
  if (source !== 'claude-code') return 'unknown'
  if (message.type !== 'user' || !message.message) return 'unknown'

  const explicitOrigin = structuredOrigin(message)
  if (explicitOrigin) return explicitOrigin

  const content = message.message.content
  if (Array.isArray(content) && content.some((part) => typeof part === 'object' && part?.type === 'tool_result')) {
    return 'tool'
  }
  if ((typeof message.sourceToolAssistantUUID === 'string' && message.sourceToolAssistantUUID.trim()) ||
    message.toolUseResult !== undefined) {
    return 'tool'
  }

  const promptSource = message.promptSource
  const ordinaryContent = isOrdinaryHumanContent(message)
  const text = firstContentText(message).trimStart()
  const tag = leadingTag(text)
  if (tag === 'task-notification') return 'task-notification'
  if (tag && COMMAND_TAGS.has(tag)) return 'command'
  if (tag && HOOK_TAGS.has(tag)) return 'hook'
  if (text.startsWith('UserPromptSubmit hook success')) return 'hook'

  if (message.isMeta === true || promptSource === 'system') return 'unknown'
  if (UNKNOWN_MACHINE_PREFIXES.some((prefix) => text.startsWith(prefix))) return 'unknown'
  if (UNKNOWN_MACHINE_MESSAGES.has(text.trim())) return 'unknown'
  if (IMAGE_SOURCE_PLACEHOLDERS.test(text.trim())) return 'unknown'
  if (tag) return 'unknown'

  if (promptSource && STRUCTURED_HUMAN_PROMPT_SOURCES.has(promptSource)) {
    return ordinaryContent ? 'human' : 'unknown'
  }

  // Legacy transcripts (pre-promptSource Claude Code) have no promptSource field
  // at all. At this point every machine marker above has already been ruled out,
  // so ordinary content without the field is a human prompt, not an injection.
  // A present-but-unrecognized promptSource value still falls through to unknown.
  if (promptSource === undefined && ordinaryContent) {
    return 'human'
  }

  return 'unknown'
}

export function formatTranscriptOriginHeader(origin: TranscriptOrigin): string | null {
  if (origin === 'human') return null
  if (origin === 'unknown') return '〔来源未判定〕'
  return `〔机器注入 · ${origin}〕`
}
