/**
 * 从 ChatViewer.tsx 提取出的纯逻辑函数
 * 这些函数不依赖 React、DOM，可以直接用 vitest 测试
 */

// --- Tool color palette ---

export const TOOL_COLORS: Record<string, string> = {
  Bash: 'bg-green-900/50 text-green-400 border-green-700/40',
  Read: 'bg-blue-900/50 text-blue-400 border-blue-700/40',
  Write: 'bg-amber-900/50 text-amber-400 border-amber-700/40',
  Edit: 'bg-amber-900/50 text-amber-400 border-amber-700/40',
  Grep: 'bg-violet-900/50 text-violet-400 border-violet-700/40',
  Glob: 'bg-violet-900/50 text-violet-400 border-violet-700/40',
  Agent: 'bg-cyan-900/50 text-cyan-400 border-cyan-700/40',
  WebSearch: 'bg-indigo-900/50 text-indigo-400 border-indigo-700/40',
  WebFetch: 'bg-indigo-900/50 text-indigo-400 border-indigo-700/40',
  Skill: 'bg-pink-900/50 text-pink-400 border-pink-700/40',
}
export const DEFAULT_TOOL_COLOR = 'bg-zinc-800/60 text-zinc-400 border-zinc-700/40'

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
