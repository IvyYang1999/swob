import type { SessionDetail, ParsedMessage } from '../store'

export type ToolCallInfo = { id?: string; name: string; input: Record<string, unknown>; result?: string }

export interface CompactSection {
  label: string
  messages: ParsedMessage[]
  isCurrent: boolean
  isSharedContext?: boolean
}

export interface Turn {
  userMsg: ParsedMessage | null
  assistantMsgs: ParsedMessage[]
}

export interface Segment {
  type: 'text' | 'tools'
  text?: string
  toolCalls?: ToolCallInfo[]
  isSidechain?: boolean
}

export const COMPACT_SUMMARY_PREFIX = 'This session is being continued from a previous conversation that ran out of context.'

// --- Section computation ---

export function computeSections(session: SessionDetail): CompactSection[] {
  const sharedMsgs = session.messages.filter((m) => m.isSharedContext)
  const ownMsgs = session.messages.filter((m) => !m.isSharedContext)

  const allMsgs = ownMsgs.filter((m) => {
    if (m.type === 'system' && m.subtype === 'compact_boundary') return true
    return m.type === 'user' || m.type === 'assistant'
  })

  const boundaryIndices: number[] = []
  allMsgs.forEach((m, i) => {
    if (m.type === 'system' && m.subtype === 'compact_boundary') boundaryIndices.push(i)
  })

  const sharedSection: CompactSection[] = []
  if (sharedMsgs.length > 0) {
    const filteredShared = sharedMsgs.filter((m) => m.type === 'user' || m.type === 'assistant')
    if (filteredShared.length > 0) {
      const count = filteredShared.length
      sharedSection.push({
        label: `共享上下文 — 分支前的对话 (${count} 条消息)`,
        messages: filteredShared,
        isCurrent: false,
        isSharedContext: true
      })
    }
  }

  if (boundaryIndices.length === 0) {
    return [...sharedSection, { label: '', messages: allMsgs, isCurrent: true }]
  }

  const result: CompactSection[] = []
  const firstSection = allMsgs.slice(0, boundaryIndices[0])
  if (firstSection.length > 0) {
    const count = firstSection.filter((m) => m.type === 'user' || m.type === 'assistant').length
    result.push({
      label: `原始对话 (${count} 条消息)`,
      messages: firstSection,
      isCurrent: false
    })
  }

  for (let i = 0; i < boundaryIndices.length; i++) {
    const start = boundaryIndices[i] + 1
    const end = i + 1 < boundaryIndices.length ? boundaryIndices[i + 1] : allMsgs.length
    const sectionMsgs = allMsgs.slice(start, end)
    const isLast = i === boundaryIndices.length - 1

    if (sectionMsgs.length > 0) {
      if (isLast) {
        result.push({ label: '', messages: sectionMsgs, isCurrent: true })
      } else {
        const count = sectionMsgs.filter((m) => m.type === 'user' || m.type === 'assistant').length
        result.push({
          label: `Compact #${i + 1} 后 (${count} 条消息)`,
          messages: sectionMsgs,
          isCurrent: false
        })
      }
    }
  }

  return [...sharedSection, ...result]
}

// --- Turn & segment grouping ---

export function groupIntoTurns(messages: ParsedMessage[]): Turn[] {
  const turns: Turn[] = []
  let current: Turn | null = null

  for (const msg of messages) {
    if (msg.type === 'system') continue
    const hasText = msg.textContent.trim().length > 0
    const hasTools = msg.toolCalls.length > 0

    if (msg.type === 'user') {
      if (!hasText) continue
      if (current) turns.push(current)
      current = { userMsg: msg, assistantMsgs: [] }
    } else if (msg.type === 'assistant') {
      if (!hasText && !hasTools) continue
      if (!current) current = { userMsg: null, assistantMsgs: [] }
      current.assistantMsgs.push(msg)
    }
  }
  if (current) turns.push(current)
  return turns
}

export function buildSegments(msgs: ParsedMessage[]): Segment[] {
  const segments: Segment[] = []
  for (const msg of msgs) {
    const hasText = msg.textContent.trim().length > 0
    const hasTools = msg.toolCalls.length > 0
    if (hasText) {
      segments.push({ type: 'text', text: msg.textContent, isSidechain: msg.isSidechain })
    }
    if (hasTools) {
      const prev = segments[segments.length - 1]
      if (prev && prev.type === 'tools') {
        prev.toolCalls!.push(...msg.toolCalls)
      } else {
        segments.push({ type: 'tools', toolCalls: [...msg.toolCalls], isSidechain: msg.isSidechain })
      }
    }
  }
  return segments
}

// --- Markdown generation (fixed hierarchy) ---

/**
 * Shift all headings in AI response text to H6,
 * so they don't exceed the user query level (H5).
 */
function shiftHeadings(text: string): string {
  return text.replace(/^(#{1,5})\s/gm, '###### ')
}

function toolToMarkdown(tc: ToolCallInfo): string {
  const lines: string[] = []

  if (tc.name === 'Bash' && tc.input.command) {
    lines.push('```bash')
    lines.push(`$ ${tc.input.command}`)
    if (tc.result) lines.push(tc.result.slice(0, 2000))
    lines.push('```')
  } else if (tc.name === 'Read' && tc.input.file_path) {
    lines.push(`> Read \`${tc.input.file_path}\``)
  } else if (tc.name === 'Write' && tc.input.file_path) {
    lines.push(`> Write \`${tc.input.file_path}\``)
    if (tc.input.content) {
      lines.push('```')
      lines.push(String(tc.input.content).slice(0, 1000))
      lines.push('```')
    }
  } else if (tc.name === 'Edit' && tc.input.file_path) {
    lines.push(`> Edit \`${tc.input.file_path}\``)
    if (tc.input.old_string) {
      lines.push('```diff')
      lines.push(String(tc.input.old_string).split('\n').map(l => `- ${l}`).join('\n'))
      lines.push(String(tc.input.new_string || '').split('\n').map(l => `+ ${l}`).join('\n'))
      lines.push('```')
    }
  } else if ((tc.name === 'Grep' || tc.name === 'Glob') && tc.input.pattern) {
    lines.push(`> ${tc.name} \`${tc.input.pattern}\``)
    if (tc.result) {
      lines.push('```')
      lines.push(tc.result.slice(0, 1000))
      lines.push('```')
    }
  } else if (tc.name === 'Agent') {
    lines.push(`> Agent: ${tc.input.prompt ? String(tc.input.prompt).slice(0, 100) : 'subagent'}`)
    if (tc.result) {
      lines.push('```')
      lines.push(tc.result.slice(0, 2000))
      lines.push('```')
    }
  } else {
    lines.push(`> ${tc.name}`)
    lines.push('```json')
    lines.push(JSON.stringify(tc.input, null, 2).slice(0, 500))
    lines.push('```')
  }

  return lines.join('\n')
}

function turnToMarkdown(turn: Turn): string {
  const lines: string[] = []

  if (turn.userMsg) {
    lines.push(`##### User\n`)
    lines.push(turn.userMsg.textContent.trim())
    lines.push('')
  }

  if (turn.assistantMsgs.length > 0) {
    const segments = buildSegments(turn.assistantMsgs)
    for (const seg of segments) {
      if (seg.type === 'text') {
        lines.push(shiftHeadings(seg.text!.trim()))
        lines.push('')
      } else if (seg.type === 'tools') {
        for (const tc of seg.toolCalls!) {
          lines.push(toolToMarkdown(tc))
          lines.push('')
        }
      }
    }
  }

  return lines.join('\n')
}

export function sessionToMarkdown(
  session: SessionDetail,
  sections: CompactSection[]
): string {
  const lines: string[] = []

  const title = session.firstUserMessage?.slice(0, 60) || session.sessionId
  lines.push(`# ${title}\n`)

  // Summary metadata
  const created = new Date(session.createdAt).toLocaleString('zh-CN')
  const toolSummary = Object.entries(session.toolUsage)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 6)
    .map(([name, count]) => `${name}(${count})`)
    .join(', ')
  lines.push(`> ${created} | ${session.messageCount} 条消息 | ${session.turnCount} 轮对话`)
  if (toolSummary) lines.push(`> Tools: ${toolSummary}`)
  lines.push('')

  for (const section of sections) {
    if (section.isCurrent && sections.length > 1) {
      lines.push(`## 当前对话\n`)
    } else if (section.label) {
      lines.push(`## ${section.label}\n`)
    }

    const turns = groupIntoTurns(section.messages)
    for (const turn of turns) {
      lines.push(turnToMarkdown(turn))
    }
  }

  return lines.join('\n')
}

// --- File helpers ---

export function downloadMarkdown(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function generateFilename(session: SessionDetail): string {
  const title = session.firstUserMessage?.slice(0, 30) || session.sessionId
  const safeName = title.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_').slice(0, 30)
  const date = new Date(session.createdAt).toISOString().slice(0, 10)
  return `transcript-${date}-${safeName}`
}
