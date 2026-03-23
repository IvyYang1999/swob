import { useStore } from '../store'
import { Search } from 'lucide-react'
import { useT } from '../i18n'

function HighlightText({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const regex = new RegExp(`(${escaped})`, 'gi')
  const parts = text.split(regex)
  return (
    <>
      {parts.map((part, i) =>
        regex.test(part) ? (
          <mark key={i} className="bg-soft-amber/25 text-soft-amber rounded-sm px-0.5">{part}</mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  )
}

export function SearchResults() {
  const { searchResults, searchQuery, selectSession, clearSearch, sessions } = useStore()
  const locale = useStore((s) => s.locale)
  const t = useT()

  if (!searchQuery || searchResults.length === 0) return null

  const totalMatches = searchResults.reduce((acc, r) => acc + r.matches.length, 0)

  return (
    <div className="absolute inset-0 bg-base/95 z-50 overflow-y-auto p-4">
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center justify-between mb-4">
          <div className="text-sm text-secondary">
            <Search size={14} className="inline mr-2" />
            {t('search.summary', { query: searchQuery, sessions: searchResults.length, matches: totalMatches })}
          </div>
          <button
            onClick={clearSearch}
            className="text-xs text-muted hover:text-body px-2 py-1 hover:bg-surface rounded"
          >
            {t('chat.close')}
          </button>
        </div>
        <div className="space-y-4">
          {searchResults.map((result) => (
            <button
              key={result.sessionId}
              onClick={() => {
                const s = sessions.find(s => s.sessionId === result.sessionId || s.id === result.sessionId)
                selectSession(result.filePath, s?.allFilePaths, s?.id, s?.branchParentFilePaths, s?.branchPointUuid)
                clearSearch()
              }}
              className="w-full text-left p-4 bg-surface hover:bg-hover/50 rounded-lg border border-edge hover:border-edge-strong transition-colors"
            >
              <div className="flex items-center justify-between mb-3">
                <div className="text-sm text-primary font-medium truncate flex-1 mr-3">
                  <HighlightText text={result.firstUserMessage.slice(0, 100) || result.sessionId.slice(0, 12)} query={searchQuery} />
                </div>
                <span className="text-[10px] text-muted bg-hover px-1.5 py-0.5 rounded shrink-0">{t('search.matches', { n: result.matches.length })}</span>
              </div>
              <div className="space-y-1.5">
                {result.matches.map((match, i) => (
                  <div
                    key={i}
                    className="text-xs text-secondary font-mono bg-base rounded px-2.5 py-1.5 leading-relaxed"
                  >
                    <span className="text-faint mr-2 text-[10px]">
                      {new Date(match.timestamp).toLocaleString(locale, {
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit'
                      })}
                    </span>
                    <HighlightText text={match.text} query={searchQuery} />
                  </div>
                ))}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
