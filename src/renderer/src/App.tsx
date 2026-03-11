import { useEffect, useState, useCallback, useRef, Component, type ReactNode, type ErrorInfo } from 'react'
import { useStore } from './store'
import { Sidebar } from './components/Sidebar'
import { ChatViewer } from './components/ChatViewer'
import { InfoPanel } from './components/InfoPanel'
import { Toolbar } from './components/Toolbar'
import { SearchResults } from './components/SearchResults'

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack)
  }
  render() {
    if (this.state.error) {
      return (
        <div className="h-screen flex items-center justify-center bg-zinc-900 text-zinc-300 p-8">
          <div className="max-w-lg text-center">
            <div className="text-lg font-medium text-red-400 mb-3">渲染错误</div>
            <pre className="text-xs text-zinc-500 bg-zinc-800 rounded p-3 mb-4 text-left overflow-auto max-h-40">
              {this.state.error.message}{'\n'}{this.state.error.stack}
            </pre>
            <button
              onClick={() => this.setState({ error: null })}
              className="px-4 py-2 bg-zinc-700 hover:bg-zinc-600 rounded text-sm"
            >
              重试
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

function ResizeHandle({ side, onResize }: { side: 'left' | 'right'; onResize: (delta: number) => void }) {
  const dragging = useRef(false)
  const lastX = useRef(0)

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
    lastX.current = e.clientX
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [])

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return
      const delta = e.clientX - lastX.current
      lastX.current = e.clientX
      onResize(side === 'left' ? delta : -delta)
    }
    const onMouseUp = () => {
      if (!dragging.current) return
      dragging.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [onResize, side])

  return (
    <div
      className="w-[3px] h-full cursor-col-resize group relative shrink-0 border-l border-zinc-700"
      onMouseDown={onMouseDown}
    >
      <div className="absolute inset-0 transition-opacity duration-150 opacity-0 group-hover:opacity-100 bg-zinc-500/40" />
    </div>
  )
}

export default function App() {
  const { initialize, loading, searchQuery, infoPanelOpen } = useStore()
  const [sidebarWidth, setSidebarWidth] = useState(240)
  const [infoPanelWidth, setInfoPanelWidth] = useState(320)

  useEffect(() => {
    initialize()
  }, [initialize])

  useEffect(() => {
    const preventDrop = (e: DragEvent) => { e.preventDefault() }
    const preventDragOver = (e: DragEvent) => { e.preventDefault() }
    document.addEventListener('drop', preventDrop)
    document.addEventListener('dragover', preventDragOver)
    return () => {
      document.removeEventListener('drop', preventDrop)
      document.removeEventListener('dragover', preventDragOver)
    }
  }, [])

  const handleSidebarResize = useCallback((delta: number) => {
    setSidebarWidth(w => Math.max(180, Math.min(400, w + delta)))
  }, [])

  const handleInfoPanelResize = useCallback((delta: number) => {
    setInfoPanelWidth(w => Math.max(240, Math.min(600, w + delta)))
  }, [])

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-zinc-900 text-zinc-400">
        <div className="text-center">
          <div className="animate-spin w-8 h-8 border-2 border-zinc-600 border-t-zinc-300 rounded-full mx-auto mb-3" />
          <div className="text-sm">Loading sessions...</div>
        </div>
      </div>
    )
  }

  return (
    <ErrorBoundary>
      <div className="h-screen flex flex-col bg-zinc-900 text-white">
        <Toolbar />
        <div className="flex-1 flex overflow-hidden relative">
          <Sidebar width={sidebarWidth} />
          <ResizeHandle side="left" onResize={handleSidebarResize} />
          <ChatViewer />
          {infoPanelOpen && (
            <>
              <ResizeHandle side="right" onResize={handleInfoPanelResize} />
              <InfoPanel width={infoPanelWidth} />
            </>
          )}
          {searchQuery && <SearchResults />}
        </div>
      </div>
    </ErrorBoundary>
  )
}
