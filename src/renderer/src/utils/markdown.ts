import type { SessionDetail, ParsedMessage } from '../store'
import { translate, type Locale } from '../i18n'

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

export interface TocEntry {
  level: number
  text: string
  id: string
}

export const COMPACT_SUMMARY_PREFIX = 'This session is being continued from a previous conversation that ran out of context.'

// --- Section computation ---

export function computeSections(session: SessionDetail, locale: Locale = 'zh-CN'): CompactSection[] {
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
      const turnCount = filteredShared.filter((m) => m.type === 'user').length
      sharedSection.push({
        label: translate(locale, 'section.shared_context', { n: turnCount }),
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
    const turnCount = firstSection.filter((m) => m.type === 'user').length
    result.push({ label: translate(locale, 'section.original', { n: turnCount }), messages: firstSection, isCurrent: false })
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
        const turnCount = sectionMsgs.filter((m) => m.type === 'user').length
        result.push({ label: translate(locale, 'section.compact_after', { i: i + 1, n: turnCount }), messages: sectionMsgs, isCurrent: false })
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
    // Skip system-injected messages (type=user but not real user input)
    if (msg.subtype === 'task-notification' || msg.subtype === 'skill-output') continue
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
    if (hasText) segments.push({ type: 'text', text: msg.textContent, isSidechain: msg.isSidechain })
    if (hasTools) {
      const prev = segments[segments.length - 1]
      if (prev && prev.type === 'tools') prev.toolCalls!.push(...msg.toolCalls)
      else segments.push({ type: 'tools', toolCalls: [...msg.toolCalls], isSidechain: msg.isSidechain })
    }
  }
  return segments
}

// --- Chat TOC (compact/full modes) ---

export function computeChatTocEntries(sections: CompactSection[], locale: Locale = 'zh-CN'): TocEntry[] {
  const entries: TocEntry[] = []
  sections.forEach((section, sIdx) => {
    const label = section.isCurrent
      ? (sections.length > 1 ? translate(locale, 'section.current') : '')
      : section.label
    if (label) {
      entries.push({ level: 2, text: label, id: `section-${sIdx}` })
    }
    const turns = groupIntoTurns(section.messages)
    turns.forEach(turn => {
      if (!turn.userMsg) return
      const text = turn.userMsg.textContent.trim()
      if (text.startsWith(COMPACT_SUMMARY_PREFIX)) return
      const snippet = text.split('\n')[0].slice(0, 50)
      entries.push({ level: 5, text: snippet, id: `turn-${turn.userMsg.uuid}` })
    })
  })
  return entries
}

// --- Markdown generation ---

function demoteHeadings(text: string): string {
  const lines = text.split('\n')
  let inCodeBlock = false
  return lines.map(line => {
    if (line.startsWith('```')) { inCodeBlock = !inCodeBlock; return line }
    if (inCodeBlock) return line
    const match = line.match(/^#{1,6}\s+(.+)$/)
    if (match) return `**${match[1].replace(/\*\*/g, '')}**`
    return line
  }).join('\n')
}

function toolToMarkdown(tc: ToolCallInfo): string {
  const lines: string[] = []
  if (tc.name === 'Bash' && tc.input.command) {
    lines.push('```bash', `$ ${tc.input.command}`)
    if (tc.result) lines.push(tc.result.slice(0, 2000))
    lines.push('```')
  } else if (tc.name === 'Read' && tc.input.file_path) {
    lines.push(`> Read \`${tc.input.file_path}\``)
  } else if (tc.name === 'Write' && tc.input.file_path) {
    lines.push(`> Write \`${tc.input.file_path}\``)
    if (tc.input.content) { lines.push('```', String(tc.input.content).slice(0, 1000), '```') }
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
    if (tc.result) { lines.push('```', tc.result.slice(0, 1000), '```') }
  } else if (tc.name === 'Agent') {
    lines.push(`> Agent: ${tc.input.prompt ? String(tc.input.prompt).slice(0, 100) : 'subagent'}`)
    if (tc.result) { lines.push('```', tc.result.slice(0, 2000), '```') }
  } else {
    lines.push(`> ${tc.name}`, '```json', JSON.stringify(tc.input, null, 2).slice(0, 500), '```')
  }
  return lines.join('\n')
}

export function turnToMarkdown(turn: Turn, locale: Locale = 'zh-CN'): string {
  const lines: string[] = []

  if (turn.userMsg) {
    const text = turn.userMsg.textContent.trim()
    if (text.startsWith(COMPACT_SUMMARY_PREFIX)) {
      // Compact summary: no heading, code block
      const summary = text.slice(COMPACT_SUMMARY_PREFIX.length).trim()
      lines.push(`${translate(locale, 'section.compact_summary_md')}\n`)
      lines.push('```')
      lines.push(summary.slice(0, 3000))
      lines.push('```')
      lines.push('')
    } else {
      // Normal user query: H5 snippet heading + blockquote body
      const firstLine = text.split('\n')[0].slice(0, 50)
      const snippet = firstLine + (text.length > firstLine.length ? '...' : '')
      lines.push(`##### ${snippet}\n`)
      // User text in blockquote
      const demoted = demoteHeadings(text)
      lines.push(demoted.split('\n').map(l => `> ${l}`).join('\n'))
      lines.push('')
    }
  }

  if (turn.assistantMsgs.length > 0) {
    const segments = buildSegments(turn.assistantMsgs)
    for (const seg of segments) {
      if (seg.type === 'text') { lines.push(demoteHeadings(seg.text!.trim()), '') }
      else if (seg.type === 'tools') {
        for (const tc of seg.toolCalls!) { lines.push(toolToMarkdown(tc), '') }
      }
    }
  }

  lines.push('---\n')
  return lines.join('\n')
}

export function sessionToMarkdown(
  session: SessionDetail,
  sections: CompactSection[],
  customTitle?: string,
  locale: Locale = 'zh-CN'
): string {
  const lines: string[] = []
  const title = customTitle || session.firstUserMessage?.slice(0, 60) || session.sessionId
  lines.push(`# ${title}\n`)

  const created = new Date(session.createdAt).toLocaleString(locale)
  const toolSummary = Object.entries(session.toolUsage)
    .sort(([, a], [, b]) => b - a).slice(0, 6)
    .map(([name, count]) => `${name}(${count})`).join(', ')
  lines.push(`> ${created} | ${translate(locale, 'section.turns_label', { n: session.turnCount })}`)
  if (toolSummary) lines.push(`> Tools: ${toolSummary}`)
  lines.push('')

  for (const section of sections) {
    if (section.isCurrent && sections.length > 1) lines.push(`## ${translate(locale, 'section.current')}\n`)
    else if (section.label) lines.push(`## ${section.label}\n`)
    const turns = groupIntoTurns(section.messages)
    for (const turn of turns) lines.push(turnToMarkdown(turn, locale))
  }

  return lines.join('\n')
}

// --- TOC extraction (for MD mode) ---

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'heading'
}

export function extractToc(markdown: string): TocEntry[] {
  const entries: TocEntry[] = []
  const lines = markdown.split('\n')
  let inCodeBlock = false
  const idCounts = new Map<string, number>()
  for (const line of lines) {
    if (line.startsWith('```')) { inCodeBlock = !inCodeBlock; continue }
    if (inCodeBlock) continue
    const match = line.match(/^(#{1,6})\s+(.+)$/)
    if (match) {
      const level = match[1].length
      const text = match[2].replace(/\*\*/g, '').replace(/`/g, '').trim()
      const baseId = slugify(text)
      const count = idCounts.get(baseId) || 0
      idCounts.set(baseId, count + 1)
      const id = count > 0 ? `${baseId}-${count}` : baseId
      entries.push({ level, text, id })
    }
  }
  return entries
}

// Source view: pre-compute line metadata for heading IDs + syntax highlight
export interface SourceLine {
  text: string
  isHeading: boolean
  id?: string
}

export function computeSourceLines(markdown: string, tocEntries: TocEntry[]): SourceLine[] {
  const lines = markdown.split('\n')
  let inCodeBlock = false
  let hIdx = 0
  return lines.map(line => {
    if (line.startsWith('```')) { inCodeBlock = !inCodeBlock }
    const isHeading = !inCodeBlock && /^#{1,6}\s/.test(line)
    const id = isHeading ? tocEntries[hIdx++]?.id : undefined
    return { text: line, isHeading, id }
  })
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
