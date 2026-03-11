import { useStore } from '../store'
import { Search } from 'lucide-react'

function HighlightText({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const regex = new RegExp(`(${escaped})`, 'gi')
  const parts = text.split(regex)
  return (
    <>
      {parts.map((part, i) =>
        regex.test(part) ? (
          <mark key={i} className="bg-amber-500/30 text-amber-300 rounded-sm px-0.5">{part}</mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  )
}

export function SearchResults() {
  const { searchResults, searchQuery, selectSession, clearSearch } = useStore()

  if (!searchQuery || searchResults.length === 0) return null

  const totalMatches = searchResults.reduce((acc, r) => acc + r.matches.length, 0)

  return (
    <div className="absolute inset-0 bg-zinc-900/95 z-50 overflow-y-auto p-4">
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center justify-between mb-4">
          <div className="text-sm text-zinc-400">
            <Search size={14} className="inline mr-2" />
            搜索 &quot;{searchQuery}&quot; — {searchResults.length} 个 session，{totalMatches} 处匹配
          </div>
          <button
            onClick={clearSearch}
            className="text-xs text-zinc-500 hover:text-zinc-300 px-2 py-1 hover:bg-zinc-800 rounded"
          >
            关闭
          </button>
        </div>
        <div className="space-y-3">
          {searchResults.map((result) => (
            <button
              key={result.sessionId}
              onClick={() => {
                selectSession(result.filePath)
                clearSearch()
              }}
              className="w-full text-left p-3 bg-zinc-800 hover:bg-zinc-700/50 rounded-lg border border-zinc-700 hover:border-zinc-600 transition-colors"
            >
              <div className="flex items-center justify-between mb-2">
                <div className="text-sm text-zinc-200 font-medium truncate flex-1 mr-2">
                  <HighlightText text={result.firstUserMessage.slice(0, 100) || result.sessionId.slice(0, 12)} query={searchQuery} />
                </div>
                <span className="text-[10px] text-zinc-600 shrink-0">{result.matches.length} 处匹配</span>
              </div>
              {result.matches.map((match, i) => (
                <div
                  key={i}
                  className="text-xs text-zinc-400 mt-1 font-mono bg-zinc-900 rounded px-2 py-1"
                >
                  <span className="text-zinc-600 mr-2">
                    {new Date(match.timestamp).toLocaleString('zh-CN', {
                      month: '2-digit',
                      day: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit'
                    })}
                  </span>
                  <HighlightText text={match.text} query={searchQuery} />
                </div>
              ))}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
