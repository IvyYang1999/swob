import { parseSessionFile } from './session-loader'

export interface SessionSearchResult {
  sessionId: string
  filePath: string
  firstUserMessage: string
  matches: Array<{ text: string; timestamp: string }>
}

export interface SessionSearchSource {
  filePath: string
}

function extractContentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  let text = ''
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const p = part as Record<string, unknown>
    if (p.type === 'text') text += (text ? ' ' : '') + String(p.text || '')
    if (p.type === 'tool_result' && typeof p.content === 'string') text += ' ' + p.content
    if (p.type === 'tool_use' && p.input && typeof p.input === 'object') {
      const input = p.input as Record<string, unknown>
      if (input.command) text += ' ' + String(input.command)
      if (input.file_path) text += ' ' + String(input.file_path)
      if (input.pattern) text += ' ' + String(input.pattern)
      if (input.content) text += ' ' + String(input.content).slice(0, 500)
    }
  }
  return text
}

function getFirstUserMessage(raw: Array<{ type: string; message?: { content?: unknown } }>): string {
  const firstUser = raw.find((m) => m.type === 'user')
  return extractContentText(firstUser?.message?.content).slice(0, 200)
}

export async function searchSessionFiles(
  query: string,
  sources: SessionSearchSource[]
): Promise<SessionSearchResult[]> {
  const results: SessionSearchResult[] = []
  const seenFiles = new Set<string>()
  const regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')

  for (const source of sources) {
    const file = source.filePath
    if (seenFiles.has(file)) continue
    seenFiles.add(file)

    try {
      const raw = await parseSessionFile(file)
      const sessionId = raw.find((m) => m.sessionId)?.sessionId
      if (!sessionId) continue

      const matches: Array<{ text: string; timestamp: string }> = []
      for (const msg of raw) {
        if (msg.type !== 'user' && msg.type !== 'assistant') continue
        const text = extractContentText(msg.message?.content)
        if (regex.test(text)) {
          const matchIndex = text.search(regex)
          const start = Math.max(0, matchIndex - 60)
          const end = Math.min(text.length, matchIndex + query.length + 60)
          matches.push({
            text:
              (start > 0 ? '...' : '') +
              text.slice(start, end) +
              (end < text.length ? '...' : ''),
            timestamp: msg.timestamp
          })
          regex.lastIndex = 0
        }
        if (matches.length >= 10) break
      }

      if (matches.length > 0) {
        results.push({
          sessionId,
          filePath: file,
          firstUserMessage: getFirstUserMessage(raw),
          matches
        })
      }
    } catch {
      /* skip */
    }
  }

  results.sort((a, b) => {
    if (b.matches.length !== a.matches.length) return b.matches.length - a.matches.length
    const aTime = new Date(a.matches[0]?.timestamp || 0).getTime()
    const bTime = new Date(b.matches[0]?.timestamp || 0).getTime()
    return bTime - aTime
  })

  return results
}
