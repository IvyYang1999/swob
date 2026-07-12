// swob chat-format —— framework-agnostic 对话解析/清洗层。可被外部 vendor（像素office 等），修改需同步。

export const TOOL_COLORS: Record<string, string> = {
  Bash: 'bg-soft-green/10 text-soft-green border-soft-green/20',
  Read: 'bg-soft-blue/10 text-soft-blue border-soft-blue/20',
  Write: 'bg-soft-amber/10 text-soft-amber border-soft-amber/20',
  Edit: 'bg-soft-amber/10 text-soft-amber border-soft-amber/20',
  Grep: 'bg-soft-purple/10 text-soft-purple border-soft-purple/20',
  Glob: 'bg-soft-purple/10 text-soft-purple border-soft-purple/20',
  Agent: 'bg-soft-cyan/10 text-soft-cyan border-soft-cyan/20',
  WebSearch: 'bg-soft-indigo/10 text-soft-indigo border-soft-indigo/20',
  WebFetch: 'bg-soft-indigo/10 text-soft-indigo border-soft-indigo/20',
  Skill: 'bg-soft-pink/10 text-soft-pink border-soft-pink/20',
}

export const DEFAULT_TOOL_COLOR = 'bg-surface/60 text-secondary border-edge/40'

/** Extract the one-line summary shown next to a compact tool-call label. */
export function getToolPreview(name: string, input: Record<string, unknown>): string {
  if (name === 'Bash' && input.command) return String(input.command).slice(0, 120)
  if ((name === 'Read' || name === 'Write' || name === 'Edit') && input.file_path) return String(input.file_path)
  if ((name === 'Grep' || name === 'Glob') && input.pattern) return String(input.pattern)
  if (name === 'Skill' && input.skill) return String(input.skill)
  if (name === 'Agent' && input.prompt) return String(input.prompt).slice(0, 80)
  return ''
}
