import type { RawJsonlMessage } from './types'

const SYSTEM_USER_MESSAGES = [
  'Continue from where you left off.',
  'Tool loaded.',
  'No response requested.'
]

const SYSTEM_USER_PREFIXES = [
  '<task-notification>',
  '<local-command-caveat>',
  '<local-command-stdout>',
  '<command-name>',
  '<command-message>',
  '<command-args>',
  '<user-prompt-submit-hook>',
  'Base directory for this skill:'
]

export function isSystemText(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return true
  if (SYSTEM_USER_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) return true
  if (trimmed.startsWith('This session is being continued')) return true
  if (trimmed.startsWith('<system-reminder>') &&
    !trimmed.replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, '').trim()) return true
  if (/^\[Image: source: [^\]]+\](\s*\[Image: source: [^\]]+\])*\s*$/.test(trimmed)) return true
  return SYSTEM_USER_MESSAGES.includes(trimmed)
}

/** Pure classifier shared by session loading and read-only resume verification. */
export function isRealUserMessage(message: RawJsonlMessage): boolean {
  if (message.type !== 'user' || !message.message) return false
  const content = message.message.content
  if (typeof content === 'string') return !isSystemText(content)
  if (!Array.isArray(content) || content.some((part) => part.type === 'tool_result')) return false

  const texts = content
    .filter((part) => part.type === 'text' && part.text)
    .map((part) => part.text!)
  return texts.length > 0 && texts.some((text) => !isSystemText(text))
}
