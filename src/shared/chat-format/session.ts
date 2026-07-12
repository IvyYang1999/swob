// swob chat-format —— framework-agnostic 对话解析/清洗层。可被外部 vendor（像素office 等），修改需同步。

export function resolveResumeCwd(session: { resumeCwd?: string; cwds?: string[] }): string | undefined {
  return session.resumeCwd || session.cwds?.[0]
}

/** Build the metadata header shared by the Markdown and source views. */
export function sessionHeaderMd(
  session: {
    firstUserMessage?: string
    sessionId: string
    createdAt: string
    turnCount: number
    toolUsage: Record<string, number>
  },
  translate: (key: string, params?: Record<string, string | number>) => string,
  locale: string,
  customTitle?: string
): string {
  const title = customTitle || session.firstUserMessage?.slice(0, 60) || session.sessionId
  const created = new Date(session.createdAt).toLocaleString(locale)
  const toolSummary = Object.entries(session.toolUsage)
    .sort(([, countA], [, countB]) => countB - countA)
    .slice(0, 6)
    .map(([name, count]) => `${name}(${count})`)
    .join(', ')
  const lines = [`# ${title}\n`]
  lines.push(`> ${created} | ${translate('chat.turns_count', { n: session.turnCount })}`)
  if (toolSummary) lines.push(`> Tools: ${toolSummary}`)
  lines.push('')
  return lines.join('\n')
}
