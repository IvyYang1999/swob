// swob chat-format —— framework-agnostic 对话解析/清洗层。可被外部 vendor（像素office 等），修改需同步。

/** Format timestamps as HH:MM today and M/D HH:MM on every other date. */
export function formatTime(iso: string, locale: string = 'zh-CN'): string {
  const date = new Date(iso)
  const now = new Date()
  const isToday = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate()

  if (isToday) {
    return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  }

  return date.toLocaleDateString(locale, { month: 'numeric', day: 'numeric' }) + ' '
    + date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
}

export function formatTokenCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`
  return String(count)
}
