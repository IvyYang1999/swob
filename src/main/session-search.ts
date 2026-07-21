import {
  searchFTS,
  synchronizeSearchSources,
  type SearchIndexResult,
  type SearchIndexSource
} from './search-index'

export type SessionSearchResult = SearchIndexResult
export type SessionSearchSource = SearchIndexSource

/**
 * Keep the public API stable for IPC and CLI callers while replacing the old
 * 109 MB JSON cache with a persistent SQLite FTS5 index.
 */
export async function searchSessionFiles(
  query: string,
  sources: SessionSearchSource[]
): Promise<SessionSearchResult[]> {
  if (!query.trim()) return []
  await synchronizeSearchSources(sources)
  return searchFTS(query, 50)
}

/** Hot query path used by the UI after the startup/index-change warmers run. */
export function searchIndexedSessions(query: string): SessionSearchResult[] {
  if (!query.trim()) return []
  return searchFTS(query, 50)
}
