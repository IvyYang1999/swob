import { useEffect, useState, useCallback, useRef, Component, type ReactNode, type ErrorInfo } from 'react'
import { useStore, type ToastMessage } from './store'
import { useT } from './i18n'
import { Sidebar } from './components/Sidebar'
import { Toolbar } from './components/Toolbar'
import { UpdateBanner } from './components/UpdateBanner'
import { Onboarding } from './components/Onboarding'
import { LibraryHealthBanner } from './components/LibraryHealthBanner'
import { useFeedbackToast } from './hooks/useFeedbackToast'
import { BUILTIN_VIEW_IDS, builtinViewRegistry } from './registry/builtin-view-registry'
import { X, CheckCircle, AlertCircle, Info } from 'lucide-react'
import { HARNESS_PRESENTATION_CHANGED_EVENT } from './utils/harness-presentation'
import { useLensEnabled } from './hooks/useLens'
import { RuntimeSafetyMarker } from './components/RuntimeSafetyMarker'

function ErrorDisplay({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const t = useT()
  return (
    <div className="h-screen flex items-center justify-center bg-base text-body p-8">
      <div className="max-w-lg text-center">
        <div className="text-lg font-medium text-soft-red mb-3">{t('error.render')}</div>
        <pre className="text-xs text-muted bg-surface rounded p-3 mb-4 text-left overflow-auto max-h-40">
          {error.message}{'\n'}{error.stack}
        </pre>
        <button
          onClick={onRetry}
          className="px-4 py-2 bg-hover hover:bg-pressed rounded text-sm"
        >
          {t('error.retry')}
        </button>
      </div>
    </div>
  )
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack)
  }
  render() {
    if (this.state.error) {
      return <ErrorDisplay error={this.state.error} onRetry={() => this.setState({ error: null })} />
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
      className="w-[3px] h-full cursor-col-resize group relative shrink-0 border-l border-edge"
      onMouseDown={onMouseDown}
    >
      <div className="absolute inset-0 transition-opacity duration-150 opacity-0 group-hover:opacity-100 bg-muted/40" />
    </div>
  )
}

function ToastContainer() {
  const toasts = useStore((s) => s.toasts)
  const dismissToast = useStore((s) => s.dismissToast)
  if (toasts.length === 0) return null
  const iconMap = { info: Info, success: CheckCircle, error: AlertCircle }
  const styleMap = {
    info: 'bg-soft-blue/10 text-soft-blue border-soft-blue/20',
    success: 'bg-soft-green/10 text-soft-green border-soft-green/20',
    error: 'bg-soft-red/10 text-soft-red border-soft-red/20'
  }
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
      {toasts.map((t) => {
        const Icon = iconMap[t.type]
        return (
          <div
            key={t.id}
            className={`flex items-center gap-2.5 px-3.5 py-2.5 rounded-lg border text-sm shadow-lg ${styleMap[t.type]}`}
            style={{ animation: 'toast-in 0.25s ease-out' }}
          >
            <Icon size={16} className="shrink-0" />
            <span className="flex-1">{t.text}</span>
            {t.action && (
              <button
                onClick={() => { t.action?.onClick(); dismissToast(t.id) }}
                className="shrink-0 px-2 py-1 rounded border border-current/20 hover:bg-base/30 text-[11px] font-medium"
              >
                {t.action.label}
              </button>
            )}
            <button onClick={() => dismissToast(t.id)} className="ml-1 opacity-50 hover:opacity-100 shrink-0">
              <X size={14} />
            </button>
          </div>
        )
      })}
    </div>
  )
}

export default function App() {
  const [, setHarnessPresentationRevision] = useState(0)
  const { initialize, loading, searchQuery, infoPanelOpen, settingsOpen, workspaceView } = useStore()
  const galaxyLensEnabled = useLensEnabled('galaxy')
  const tokenInsightsLensEnabled = useLensEnabled('token-insights')
  const auditLensEnabled = useLensEnabled('audit')
  const [sidebarWidth, setSidebarWidth] = useState(240)
  const [infoPanelWidth, setInfoPanelWidth] = useState(320)
  const [onboarding, setOnboarding] = useState<{ needed: boolean; defaultPath: string } | null>(null)
  const [windowWidth, setWindowWidth] = useState(window.innerWidth)
  const narrowWindow = windowWidth <= 640

  // Track window width for responsive layout
  useEffect(() => {
    const handleResize = () => setWindowWidth(window.innerWidth)
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  useFeedbackToast()

  useEffect(() => {
    const refresh = () => setHarnessPresentationRevision((revision) => revision + 1)
    window.addEventListener(HARNESS_PRESENTATION_CHANGED_EVENT, refresh)
    return () => window.removeEventListener(HARNESS_PRESENTATION_CHANGED_EVENT, refresh)
  }, [])

  useEffect(() => {
    initialize()
    window.api.onboardingGetState?.()
      .then((state) => setOnboarding({ needed: state.needed, defaultPath: state.defaultPath }))
      .catch(() => setOnboarding({ needed: false, defaultPath: '' }))
  }, [initialize])

  useEffect(() => {
    const routeInvalid = (workspaceView === 'galaxy' && !galaxyLensEnabled) ||
      (workspaceView === 'insights' && !tokenInsightsLensEnabled && !auditLensEnabled)
    if (routeInvalid) useStore.setState({ workspaceView: 'chat' })
  }, [workspaceView, galaxyLensEnabled, tokenInsightsLensEnabled, auditLensEnabled])

  // External file drop navigation is prevented by main process will-navigate handler

  const handleSidebarResize = useCallback((delta: number) => {
    setSidebarWidth(w => Math.max(180, Math.min(400, w + delta)))
  }, [])

  const handleInfoPanelResize = useCallback((delta: number) => {
    setInfoPanelWidth(w => Math.max(240, Math.min(600, w + delta)))
  }, [])

  const viewContext = {
    infoPanelWidth,
    onInfoNavigate: (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
  const activeViewId = workspaceView === 'galaxy'
    ? BUILTIN_VIEW_IDS.lineage
    : workspaceView === 'insights'
      ? BUILTIN_VIEW_IDS.insights
      : BUILTIN_VIEW_IDS.chat

  if (onboarding?.needed) {
    return (
      <ErrorBoundary>
        <RuntimeSafetyMarker floating />
        <Onboarding
          defaultPath={onboarding.defaultPath}
          onDone={() => setOnboarding({ needed: false, defaultPath: onboarding.defaultPath })}
        />
        <ToastContainer />
      </ErrorBoundary>
    )
  }

  if (loading) {
    return (
      <>
        <RuntimeSafetyMarker floating />
        <div className="h-screen flex items-center justify-center bg-base text-secondary">
          <div className="text-center">
            <div className="animate-spin w-8 h-8 border-2 border-edge-strong border-t-body rounded-full mx-auto mb-3" />
            <div className="text-sm">Loading sessions...</div>
          </div>
        </div>
      </>
    )
  }

  return (
    <ErrorBoundary>
      <div className="h-screen flex flex-col bg-base text-primary">
        <Toolbar />
        <LibraryHealthBanner />
        <div className="flex-1 flex overflow-hidden relative">
          <Sidebar width={sidebarWidth} />
          <ResizeHandle side="left" onResize={handleSidebarResize} />
          {builtinViewRegistry.require(activeViewId).render(viewContext)}
          {infoPanelOpen && !narrowWindow && !settingsOpen && workspaceView === 'chat' && (
            <>
              <ResizeHandle side="right" onResize={handleInfoPanelResize} />
              {builtinViewRegistry.require(BUILTIN_VIEW_IDS.info).render(viewContext)}
            </>
          )}
          {settingsOpen && builtinViewRegistry.require(BUILTIN_VIEW_IDS.settings).render(viewContext)}
          {searchQuery && builtinViewRegistry.require(BUILTIN_VIEW_IDS.searchResults).render(viewContext)}
        </div>
        <UpdateBanner />
        <ToastContainer />
      </div>
    </ErrorBoundary>
  )
}
