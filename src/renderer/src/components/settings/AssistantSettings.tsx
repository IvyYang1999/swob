import { useState, useEffect, useCallback, useRef } from 'react'
import { RefreshCw } from 'lucide-react'
import { useStore } from '../../store'
import { keyEventToAccelerator, formatAccelerator } from './sections'

interface AgentStatus {
  available: boolean
  binaryPath?: string
  reason?: string
  sessionId?: string | null
  busy?: boolean
}

export function AssistantSettings() {
  const locale = useStore((s) => s.locale)
  const savePreferences = useStore((s) => s.savePreferences)
  const preferences = useStore((s) => s.config?.preferences)
  const zh = locale === 'zh-CN'

  return (
    <section className="space-y-6">
      <ShortcutSection zh={zh} preferences={preferences} savePreferences={savePreferences} />
      <AlwaysOnTopSection zh={zh} />
      <EngineStatusSection zh={zh} />
    </section>
  )
}

/* ── Shortcut section ── */

function ShortcutSection({ zh, preferences, savePreferences }: {
  zh: boolean
  preferences: Record<string, unknown> | undefined
  savePreferences: (prefs: Record<string, unknown>) => Promise<void>
}) {
  const currentAccel = (preferences as any)?.agentShortcut as string | undefined
  const displayAccel = currentAccel || 'CommandOrControl+Shift+A'
  const [recording, setRecording] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!recording) return
    const handler = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const accel = keyEventToAccelerator(e)
      if (!accel) return
      setRecording(false)
      void savePreferences({ agentShortcut: accel })
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [recording, savePreferences])

  return (
    <section>
      <label className="flex items-center gap-2 text-xs font-medium text-secondary mb-2">
        {zh ? '助手快捷键' : 'Assistant Shortcut'}
      </label>
      <div className="flex items-center gap-2">
        <button
          ref={buttonRef}
          onClick={() => setRecording(true)}
          className={`rounded-md border px-3 py-1.5 text-xs font-mono transition-colors ${
            recording
              ? 'border-soft-blue bg-soft-blue/10 text-soft-blue animate-pulse'
              : 'border-edge bg-surface text-primary hover:border-soft-blue'
          }`}
        >
          {recording
            ? (zh ? '请按下快捷键…' : 'Press a shortcut…')
            : formatAccelerator(displayAccel)}
        </button>
        <span className="text-[10px] text-faint">
          {zh ? '全局唤起/隐藏助手悬浮窗' : 'Toggle assistant floating window globally'}
        </span>
      </div>
      <p className="mt-1.5 text-[10px] text-faint">
        {zh ? '更改后需重启应用生效。默认：⌘⇧A' : 'Restart app to apply. Default: ⌘⇧A'}
      </p>
    </section>
  )
}

/* ── Always on top section ── */

function AlwaysOnTopSection({ zh }: { zh: boolean }) {
  // TODO: needs backend IPC (agentSetAlwaysOnTop) — render disabled for now
  return (
    <section>
      <label className="flex items-center gap-2 text-xs font-medium text-secondary mb-2">
        {zh ? '悬浮窗置顶' : 'Float on top'}
      </label>
      <div className="flex items-center gap-2">
        <button
          disabled
          className="rounded-md border border-edge bg-surface px-3 py-1.5 text-xs text-muted opacity-50 cursor-not-allowed"
        >
          {zh ? '开启' : 'On'}
        </button>
        <span className="text-[10px] text-faint">
          {zh ? '需要后端支持' : 'Requires backend support'}
        </span>
      </div>
    </section>
  )
}

/* ── Engine status section ── */

function EngineStatusSection({ zh }: { zh: boolean }) {
  const [status, setStatus] = useState<AgentStatus | null>(null)
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const s = await window.api.agentGetStatus()
      setStatus(s as AgentStatus)
    } catch {
      setStatus({ available: false, reason: zh ? '获取状态失败' : 'Failed to get status' })
    }
    setLoading(false)
  }, [zh])

  useEffect(() => { void refresh() }, [refresh])

  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <label className="flex items-center gap-2 text-xs font-medium text-secondary">
          {zh ? '引擎状态' : 'Engine Status'}
        </label>
        <button
          onClick={() => void refresh()}
          disabled={loading}
          className="p-1 rounded hover:bg-hover text-muted hover:text-primary disabled:opacity-40"
          title={zh ? '刷新' : 'Refresh'}
        >
          <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {!status && loading && (
        <p className="text-[11px] text-muted">{zh ? '检测中…' : 'Checking…'}</p>
      )}

      {status && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-[11px]">
            <span className={`inline-block w-2 h-2 rounded-full ${status.available ? 'bg-green-400' : 'bg-red-400'}`} />
            <span className={status.available ? 'text-primary' : 'text-red-400'}>
              {status.available ? (zh ? '可用' : 'Available') : (status.reason || (zh ? '不可用' : 'Unavailable'))}
            </span>
          </div>
          {status.binaryPath && (
            <code className="block text-[10px] font-mono text-faint truncate" title={status.binaryPath}>
              {status.binaryPath}
            </code>
          )}
        </div>
      )}
    </section>
  )
}
