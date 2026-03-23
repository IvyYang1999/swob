import { useEffect, useState } from 'react'
import { Download, RefreshCw } from 'lucide-react'

type UpdateState = 'idle' | 'downloading' | 'ready'

export function UpdateBanner() {
  const [state, setState] = useState<UpdateState>('idle')
  const [version, setVersion] = useState('')

  useEffect(() => {
    const api = (window as any).api
    api.onUpdateDownloading((v: string) => {
      setVersion(v)
      setState('downloading')
    })
    api.onUpdateReady((v: string) => {
      setVersion(v)
      setState('ready')
    })
  }, [])

  if (state === 'idle') return null

  return (
    <div className="fixed bottom-4 left-4 z-50 flex items-center gap-2 px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-600 shadow-lg text-sm text-zinc-200 animate-in fade-in slide-in-from-bottom-2">
      {state === 'downloading' && (
        <>
          <Download size={14} className="text-zinc-400 animate-pulse" />
          <span className="text-zinc-400">正在下载 v{version}…</span>
        </>
      )}
      {state === 'ready' && (
        <>
          <RefreshCw size={14} className="text-green-400" />
          <span>v{version} 已就绪</span>
          <button
            onClick={() => (window as any).api.installUpdate()}
            className="ml-1 px-2 py-0.5 rounded bg-green-600 hover:bg-green-500 text-white text-xs font-medium transition-colors"
          >
            重启更新
          </button>
        </>
      )}
    </div>
  )
}
