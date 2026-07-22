import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Download, RefreshCw, ChevronDown, ChevronUp, X } from 'lucide-react'

type UpdateState = 'idle' | 'available' | 'downloading' | 'ready' | 'not-available' | 'error'
type UpdateErrorKind = 'check' | 'download' | 'install'

export function UpdateBanner() {
  const [state, setState] = useState<UpdateState>('idle')
  const [version, setVersion] = useState('')
  const [notes, setNotes] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [errorKind, setErrorKind] = useState<UpdateErrorKind>('check')

  useEffect(() => {
    const api = (window as any).api
    api.onUpdateAvailable((v: string, n: string) => {
      setVersion(v)
      setNotes(n || '')
      setState('available')
    })
    api.onUpdateDownloading((v: string) => {
      setVersion(v)
      setState('downloading')
    })
    api.onUpdateReady((v: string, n: string) => {
      setVersion(v)
      setNotes(n || '')
      setState('ready')
    })
    api.onUpdateNotAvailable(() => {
      setVersion('')
      setState('not-available')
    })
    api.onUpdateError((kind: UpdateErrorKind, v: string) => {
      setErrorKind(kind)
      setVersion(v || '')
      setState('error')
    })
  }, [])

  if (state === 'idle') return null

  // 把 markdown 列表项（"- xxx"）解析成数组
  const noteLines = notes
    .split('\n')
    .map((l) => l.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean)

  return (
    <div
      data-testid="update-banner"
      className="fixed bottom-4 left-4 z-50 max-w-[calc(100vw-2rem)] rounded-lg bg-zinc-800 border border-zinc-600 shadow-lg text-sm text-zinc-200 sm:max-w-xs"
    >
      <div className="flex items-center gap-2 px-3 py-2 min-w-0">
        {state === 'downloading' && (
          <>
            <Download size={14} className="text-zinc-400 animate-pulse shrink-0" />
            <span className="text-zinc-400">正在下载 v{version}…</span>
          </>
        )}
        {state === 'available' && (
          <>
            <Download size={14} className="text-zinc-300 shrink-0" />
            <span>发现新版本 v{version}</span>
            <button
              onClick={() => (window as any).api.downloadUpdate()}
              className="ml-auto px-2 py-0.5 rounded bg-green-600 hover:bg-green-500 text-white text-xs font-medium transition-colors shrink-0"
            >
              更新
            </button>
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
        {state === 'not-available' && (
          <>
            <CheckCircle2 size={14} className="text-green-400 shrink-0" />
            <span className="min-w-0">当前已是最新版</span>
          </>
        )}
        {state === 'error' && (
          <>
            <AlertTriangle size={14} className="text-amber-400 shrink-0" />
            <span className="min-w-0 leading-snug">
              {errorKind === 'check' && '暂时无法检查更新'}
              {errorKind === 'download' && `${version ? `v${version} ` : ''}下载失败`}
              {errorKind === 'install' && '安全校验未通过，未安装新版'}
            </span>
            {errorKind === 'download' ? (
              <button
                onClick={() => (window as any).api.downloadUpdate()}
                className="ml-auto px-2 py-0.5 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-200 text-xs font-medium transition-colors shrink-0"
              >
                重试下载
              </button>
            ) : (
              <button
                onClick={() => (window as any).api.openUpdateDownloadPage()}
                className="ml-auto px-2 py-0.5 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-200 text-xs font-medium transition-colors shrink-0"
              >
                手动下载
              </button>
            )}
          </>
        )}
        {(state === 'not-available' || state === 'error') && (
          <button
            onClick={() => setState('idle')}
            aria-label="关闭更新提示"
            className="p-0.5 text-zinc-500 hover:text-zinc-300 shrink-0"
          >
            <X size={12} />
          </button>
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
