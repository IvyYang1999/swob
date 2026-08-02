import {
  searchFTS,
  type SearchIndexResult,
  type SearchIndexSource
} from './search-index'
import { getSearchIndexWriteCoordinator } from './search-index-writer'
import type { SessionSummary } from './types'

export type SessionSearchResult = SearchIndexResult
export type SessionSearchSource = SearchIndexSource

/**
 * Codex internal rollouts remain valid raw evidence, but only files represented
 * by a top-level summary may enter the user-facing search index.
 */
export function filterVisibleSearchSources(
  sources: SessionSearchSource[],
  sessions: SessionSummary[]
): SessionSearchSource[] {
  const visibleCodexPaths = new Set(
    sessions
      .filter((session) => session.source === 'codex')
      .flatMap((session) => session.allFilePaths || [session.filePath])
  )
  return sources.filter((source) =>
    source.source !== 'codex' || visibleCodexPaths.has(source.filePath)
  )
}

/**
 * Keep the public API stable for IPC and CLI callers while replacing the old
 * 109 MB JSON cache with a persistent SQLite FTS5 index.
 */
export async function searchSessionFiles(
  query: string,
  sources: SessionSearchSource[]
): Promise<SessionSearchResult[]> {
  if (!query.trim()) return []
  await getSearchIndexWriteCoordinator().scheduleLegacySnapshot(sources)
  return searchFTS(query, 50)
}

/** Hot query path used by the UI after the startup/index-change warmers run. */
export function searchIndexedSessions(query: string): SessionSearchResult[] {
  if (!query.trim()) return []
  return searchFTS(query, 50)
}
