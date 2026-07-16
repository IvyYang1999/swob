import type { SessionSummary } from './types'

export interface SpotlightResult {
  session: SessionSummary
  score: number
  matchedFields: string[]
  customTitle?: string
  folderName?: string
}

const SOURCE_ALIASES: Record<string, string[]> = {
  'claude-code': ['cc', 'claude', 'claudecode', 'claude-code'],
  codex: ['codex', 'openai', 'gpt'],
  cursor: ['cursor'],
  opencode: ['opencode'],
  zcode: ['zcode', 'glm']
}

const TIME_ALIASES: Record<string, () => number> = {
  '今天': () => todayStart(),
  '昨天': () => todayStart() - 86400_000,
  '前天': () => todayStart() - 2 * 86400_000,
  '本周': () => weekStart(),
  '上周': () => weekStart() - 7 * 86400_000,
  '最新': () => 0,
  '最近': () => Date.now() - 3 * 86400_000,
  today: () => todayStart(),
  yesterday: () => todayStart() - 86400_000,
  'this week': () => weekStart(),
  latest: () => 0,
  recent: () => Date.now() - 3 * 86400_000
}

function todayStart(): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function weekStart(): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - d.getDay())
  return d.getTime()
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0)
}

function fuzzyMatch(text: string, token: string): boolean {
  return text.toLowerCase().includes(token)
}

interface SearchContext {
  sessionMeta: Record<string, { customTitle?: string }>
  folderMap: Map<string, string>
}

export function spotlightSearch(
  query: string,
  sessions: SessionSummary[],
  context: SearchContext,
  limit = 20
): SpotlightResult[] {
  if (!query.trim()) {
    return sessions.slice(0, limit).map((s) => ({
      session: s,
      score: 0,
      matchedFields: [],
      customTitle: context.sessionMeta[s.sessionId]?.customTitle,
      folderName: context.folderMap.get(s.sessionId)
    }))
  }

  const tokens = tokenize(query)
  if (tokens.length === 0) return []

  let sourceFilter: string | null = null
  let timeFilter: number | null = null
  let wantLatest = false
  const contentTokens: string[] = []

  for (const token of tokens) {
    // Check source aliases
    let isSource = false
    for (const [source, aliases] of Object.entries(SOURCE_ALIASES)) {
      if (aliases.includes(token)) {
        sourceFilter = source
        isSource = true
        break
      }
    }
    if (isSource) continue

    // Check time aliases
    let isTime = false
    for (const [alias, fn] of Object.entries(TIME_ALIASES)) {
      if (alias === token || alias.includes(token)) {
        if (alias === '最新' || alias === 'latest') {
          wantLatest = true
        } else {
          timeFilter = fn()
        }
        isTime = true
        break
      }
    }
    if (isTime) continue

    contentTokens.push(token)
  }

  const results: SpotlightResult[] = []

  for (const session of sessions) {
    // Source filter
    const sessionSource = session.source || 'claude-code'
    if (sourceFilter && sessionSource !== sourceFilter) continue

    // Time filter
    if (timeFilter) {
      const sessionTime = new Date(session.updatedAt).getTime()
      if (sessionTime < timeFilter) continue
    }

    const customTitle = context.sessionMeta[session.sessionId]?.customTitle
    const folderName = context.folderMap.get(session.sessionId)

    if (contentTokens.length === 0) {
      results.push({
        session,
        score: wantLatest ? new Date(session.updatedAt).getTime() : 100,
        matchedFields: sourceFilter ? ['source'] : [],
        customTitle,
        folderName
      })
      continue
    }

    let score = 0
    const matchedFields: string[] = []
    let allMatched = true

    for (const token of contentTokens) {
      let tokenMatched = false

      // Custom title (highest weight)
      if (customTitle && fuzzyMatch(customTitle, token)) {
        score += 50
        if (!matchedFields.includes('title')) matchedFields.push('title')
        tokenMatched = true
      }

      // First user message
      if (fuzzyMatch(session.firstUserMessage, token)) {
        score += 30
        if (!matchedFields.includes('message')) matchedFields.push('message')
        tokenMatched = true
      }

      // All user messages (full content search)
      if (!tokenMatched && session.allUserMessages && fuzzyMatch(session.allUserMessages, token)) {
        score += 20
        if (!matchedFields.includes('content')) matchedFields.push('content')
        tokenMatched = true
      }

      // Folder name
      if (folderName && fuzzyMatch(folderName, token)) {
        score += 25
        if (!matchedFields.includes('folder')) matchedFields.push('folder')
        tokenMatched = true
      }

      // CWDs / project path — also match last directory name for project name matching
      const allPaths = [...session.cwds, session.projectPath].join(' ')
      if (fuzzyMatch(allPaths, token)) {
        score += 15
        if (!matchedFields.includes('path')) matchedFields.push('path')
        tokenMatched = true
      }
      if (!tokenMatched) {
        const dirNames = [...session.cwds, session.projectPath]
          .map((p) => p.split('/').filter(Boolean).pop() || '')
          .join(' ')
        if (fuzzyMatch(dirNames, token)) {
          score += 20
          if (!matchedFields.includes('dirname')) matchedFields.push('dirname')
          tokenMatched = true
        }
      }

      // Tool usage keys
      const toolNames = Object.keys(session.toolUsage).join(' ')
      if (toolNames && fuzzyMatch(toolNames, token)) {
        score += 10
        if (!matchedFields.includes('tools')) matchedFields.push('tools')
        tokenMatched = true
      }

      if (!tokenMatched) {
        allMatched = false
        break
      }
    }

    if (!allMatched) continue

    // Time recency bonus (more recent = higher score)
    const ageHours = (Date.now() - new Date(session.updatedAt).getTime()) / 3600_000
    const recencyBonus = Math.max(0, 20 - ageHours * 0.1)
    score += recencyBonus

    // Turn count bonus (more turns = more substantial session)
    score += Math.min(session.turnCount * 0.5, 10)

    results.push({ session, score, matchedFields, customTitle, folderName })
  }

  if (wantLatest) {
    results.sort((a, b) => b.session.updatedAt.localeCompare(a.session.updatedAt))
  } else {
    results.sort((a, b) => b.score - a.score)
  }

  return results.slice(0, limit)
}
