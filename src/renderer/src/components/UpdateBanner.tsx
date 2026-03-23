import { useEffect, useState } from 'react'
import { Download, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react'

type UpdateState = 'idle' | 'downloading' | 'ready'

export function UpdateBanner() {
  const [state, setState] = useState<UpdateState>('idle')
  const [version, setVersion] = useState('')
  const [notes, setNotes] = useState('')
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    const api = (window as any).api
    api.onUpdateDownloading((v: string) => {
      setVersion(v)
      setState('downloading')
    })
    api.onUpdateReady((v: string, n: string) => {
      setVersion(v)
      setNotes(n || '')
      setState('ready')
    })
  }, [])

  if (state === 'idle') return null

  // 把 markdown 列表项（"- xxx"）解析成数组
  const noteLines = notes
    .split('\n')
    .map((l) => l.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean)

  return (
    <div className="fixed bottom-4 left-4 z-50 max-w-xs rounded-lg bg-zinc-800 border border-zinc-600 shadow-lg text-sm text-zinc-200">
      <div className="flex items-center gap-2 px-3 py-2">
        {state === 'downloading' && (
          <>
            <Download size={14} className="text-zinc-400 animate-pulse shrink-0" />
            <span className="text-zinc-400">正在下载 v{version}…</span>
          </>
        )}
        {state === 'ready' && (
          <>
            <RefreshCw size={14} className="text-green-400 shrink-0" />
            <span>v{version} 已就绪</span>
            <button
              onClick={() => (window as any).api.installUpdate()}
              className="ml-auto px-2 py-0.5 rounded bg-green-600 hover:bg-green-500 text-white text-xs font-medium transition-colors shrink-0"
            >
              重启更新
            </button>
          </>
        )}
      </div>
      {state === 'ready' && noteLines.length > 0 && (
        <>
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1 px-3 py-1 text-xs text-zinc-400 hover:text-zinc-300 w-full border-t border-zinc-700"
          >
            {expanded ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
            <span>更新内容</span>
          </button>
          {expanded && (
            <ul className="px-3 pb-2 text-xs text-zinc-400 space-y-0.5">
              {noteLines.map((line, i) => (
                <li key={i} className="flex gap-1.5">
                  <span className="text-zinc-500 shrink-0">·</span>
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
