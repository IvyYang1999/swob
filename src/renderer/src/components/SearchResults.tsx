import { useStore } from '../store'
import { Search } from 'lucide-react'

export function SearchResults() {
  const { searchResults, searchQuery, selectSession, clearSearch } = useStore()

  if (!searchQuery || searchResults.length === 0) return null

  return (
    <div className="absolute inset-0 bg-zinc-900/95 z-50 overflow-y-auto p-4">
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center justify-between mb-4">
          <div className="text-sm text-zinc-400">
            <Search size={14} className="inline mr-2" />
            搜索 &quot;{searchQuery}&quot; — {searchResults.length} 个 session 匹配
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
              <div className="text-sm text-zinc-200 font-medium truncate mb-2">
                {result.firstUserMessage.slice(0, 100) || result.sessionId.slice(0, 12)}
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
                  {match.text}
                </div>
              ))}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
