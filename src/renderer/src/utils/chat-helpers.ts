/**
 * 从 ChatViewer.tsx 提取出的纯逻辑函数
 * 这些函数不依赖 React、DOM，可以直接用 vitest 测试
 */

// --- Tool color palette ---

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

/**
 * 从工具调用的 input 中提取一行预览文本
 * 用于在精简模式下显示工具标签旁边的摘要
 */
export function getToolPreview(name: string, input: Record<string, unknown>): string {
  if (name === 'Bash' && input.command) return String(input.command).slice(0, 120)
  if ((name === 'Read' || name === 'Write' || name === 'Edit') && input.file_path) return String(input.file_path)
  if ((name === 'Grep' || name === 'Glob') && input.pattern) return String(input.pattern)
  if (name === 'Skill' && input.skill) return String(input.skill)
  if (name === 'Agent' && input.prompt) return String(input.prompt).slice(0, 80)
  return ''
}

/**
 * 格式化时间：当天只显示 HH:MM，非当天显示 M/D HH:MM
 */
export function formatTime(iso: string, locale: string = 'zh-CN'): string {
  const d = new Date(iso)
  const now = new Date()
  const isToday = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  if (isToday) {
    return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  }
  return d.toLocaleDateString(locale, { month: 'numeric', day: 'numeric' }) + ' ' +
    d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
}

/**
 * 生成 session 的 Markdown 头部信息
 * 用于 Markdown 视图和源码视图的标题区域
 */
export function sessionHeaderMd(
  session: { firstUserMessage?: string; sessionId: string; createdAt: string; turnCount: number; toolUsage: Record<string, number> },
  t: (key: string, params?: Record<string, string | number>) => string,
  locale: string,
  customTitle?: string
): string {
  const title = customTitle || session.firstUserMessage?.slice(0, 60) || session.sessionId
  const created = new Date(session.createdAt).toLocaleString(locale)
  const toolSummary = Object.entries(session.toolUsage)
    .sort(([, a], [, b]) => b - a).slice(0, 6)
    .map(([name, count]) => `${name}(${count})`).join(', ')
  const lines = [`# ${title}\n`]
  lines.push(`> ${created} | ${t('chat.turns_count', { n: session.turnCount })}`)
  if (toolSummary) lines.push(`> Tools: ${toolSummary}`)
  lines.push('')
  return lines.join('\n')
}
