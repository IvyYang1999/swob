import * as fs from 'fs'
import * as path from 'path'
import { parseSessionFile } from './session-loader'
import type { RawJsonlMessage } from './types'

export interface SessionSearchResult {
  sessionId: string
  filePath: string
  firstUserMessage: string
  matches: Array<{ text: string; timestamp: string }>
}

export interface SessionSearchSource {
  filePath: string
}

// Keep this cache separate from summary-cache.json. Searches may include library
// backups which are not part of the session-summary cache, and corrupt or stale
// search data must never invalidate summary/lineage data.
const SEARCH_CACHE_VERSION = 1
const DEFAULT_CACHE_DIR = path.join(process.env.HOME || '', '.claude-session-manager')

interface CachedSearchMessage {
  text: string
  timestamp: string
}

interface SearchCacheEntry {
  sig: string
  sessionId: string | null
  firstUserMessage: string
  messages: CachedSearchMessage[]
}

interface SearchDiskCache {
  version: number
  entries: Record<string, SearchCacheEntry>
}

interface InMemorySearchCache {
  file: string
  diskSig: string | null
  cache: SearchDiskCache
  persisted: boolean
}

let inMemoryCache: InMemorySearchCache | null = null
let cacheReleaseTimer: ReturnType<typeof setTimeout> | null = null
const CACHE_RELEASE_DELAY_MS = 30_000 // release search cache 30s after last search

function searchCacheFile(): string {
  // The override is intentionally only for isolated tests. Production always
  // uses the same private application cache directory as session-loader.
  return path.join(process.env.SWOB_SEARCH_CACHE_DIR || DEFAULT_CACHE_DIR, 'search-cache.json')
}

function loadSearchCache(file: string): SearchDiskCache | null {
  try {
    const cache = JSON.parse(fs.readFileSync(file, 'utf-8')) as SearchDiskCache
    if (cache.version === SEARCH_CACHE_VERSION && cache.entries && typeof cache.entries === 'object') {
      return cache
    }
  } catch { /* missing or corrupt cache: rebuild below */ }
  return null
}

function saveSearchCache(cache: SearchDiskCache): void {
  try {
    const file = searchCacheFile()
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const tempFile = `${file}.tmp`
    fs.writeFileSync(tempFile, JSON.stringify(cache), { mode: 0o600 })
    fs.renameSync(tempFile, file)
    inMemoryCache = { file, diskSig: computeFileSig(file), cache, persisted: true }
  } catch { /* cache is an optimization, never a search failure */ }
}

function computeFileSig(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath)
    return `${stat.mtimeMs}:${stat.size}`
  } catch {
    return null
  }
}

function getSearchCache(): InMemorySearchCache {
  const file = searchCacheFile()
  const diskSig = computeFileSig(file)
  if (inMemoryCache?.file === file && inMemoryCache.diskSig === diskSig) return inMemoryCache

  const loaded = loadSearchCache(file)
  inMemoryCache = {
    file,
    diskSig,
    cache: loaded || { version: SEARCH_CACHE_VERSION, entries: {} },
    persisted: Boolean(loaded)
  }
  return inMemoryCache
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

function buildSearchCacheEntry(raw: RawJsonlMessage[], sig: string): SearchCacheEntry {
  return {
    sig,
    sessionId: raw.find((m) => m.sessionId)?.sessionId || null,
    firstUserMessage: getFirstUserMessage(raw),
    messages: raw
      .filter((m) => m.type === 'user' || m.type === 'assistant')
      .map((m) => ({ text: extractContentText(m.message?.content), timestamp: m.timestamp }))
  }
}

function isUsableCacheEntry(entry: SearchCacheEntry | undefined, sig: string): entry is SearchCacheEntry {
  return Boolean(
    entry && entry.sig === sig && (typeof entry.sessionId === 'string' || entry.sessionId === null) &&
    typeof entry.firstUserMessage === 'string' && Array.isArray(entry.messages) &&
    entry.messages.every((message) => typeof message?.text === 'string' && typeof message.timestamp === 'string')
  )
}

export async function searchSessionFiles(
  query: string,
  sources: SessionSearchSource[]
): Promise<SessionSearchResult[]> {
  const results: SessionSearchResult[] = []
  const seenFiles = new Set<string>()
  const regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
  const memoryCache = getSearchCache()
  const entries = memoryCache.cache.entries
  let cacheChanged = !memoryCache.persisted

  for (const source of sources) {
    const file = source.filePath
    if (seenFiles.has(file)) continue
    seenFiles.add(file)

    try {
      const sig = computeFileSig(file)
      if (!sig) continue

      let entry = entries[file]
      if (!isUsableCacheEntry(entry, sig)) {
        entry = buildSearchCacheEntry(await parseSessionFile(file), sig)
        entries[file] = entry
        cacheChanged = true
      }

      const sessionId = entry.sessionId
      if (!sessionId) continue

      const matches: Array<{ text: string; timestamp: string }> = []
      for (const message of entry.messages) {
        const text = message.text
        if (regex.test(text)) {
          const matchIndex = text.search(regex)
          const start = Math.max(0, matchIndex - 60)
          const end = Math.min(text.length, matchIndex + query.length + 60)
          matches.push({
            text:
              (start > 0 ? '...' : '') +
              text.slice(start, end) +
              (end < text.length ? '...' : ''),
            timestamp: message.timestamp
          })
          regex.lastIndex = 0
        }
        if (matches.length >= 10) break
      }

      if (matches.length > 0) {
        results.push({
          sessionId,
          filePath: file,
          firstUserMessage: entry.firstUserMessage,
          matches
        })
      }
    } catch {
      /* skip */
    }
  }

  if (cacheChanged) saveSearchCache(memoryCache.cache)

  // Schedule cache release to avoid 164MB permanent heap retention
  if (cacheReleaseTimer) clearTimeout(cacheReleaseTimer)
  cacheReleaseTimer = setTimeout(() => {
    inMemoryCache = null
    cacheReleaseTimer = null
  }, CACHE_RELEASE_DELAY_MS)

  results.sort((a, b) => {
    if (b.matches.length !== a.matches.length) return b.matches.length - a.matches.length
    const aTime = new Date(a.matches[0]?.timestamp || 0).getTime()
    const bTime = new Date(b.matches[0]?.timestamp || 0).getTime()
    return bTime - aTime
  })

  return results
}
