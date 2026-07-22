import { translate } from '../../i18n'
import { useState, useEffect, useCallback, useRef } from 'react'
import { RefreshCw } from 'lucide-react'
import { useStore } from '../../store'
import { keyEventToAccelerator, formatAccelerator } from './sections'

interface AgentStatus {
  available: boolean
  binaryPath?: string
  reasonCode?: string
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
        {translate(zh ? 'zh-CN' : 'en', 'renderer.assistant_settings.assistant_shortcut')}
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
            ? (translate(zh ? 'zh-CN' : 'en', 'renderer.assistant_settings.press_a_shortcut'))
            : formatAccelerator(displayAccel)}
        </button>
        <span className="text-[10px] text-faint">
          {translate(zh ? 'zh-CN' : 'en', 'renderer.assistant_settings.toggle_assistant_floating_window_globally')}
        </span>
      </div>
      <p className="mt-1.5 text-[10px] text-faint">
        {translate(zh ? 'zh-CN' : 'en', 'renderer.assistant_settings.restart_app_to_apply_default_a')}
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
        {translate(zh ? 'zh-CN' : 'en', 'renderer.assistant_settings.float_on_top')}
      </label>
      <div className="flex items-center gap-2">
        <button
          disabled
          className="rounded-md border border-edge bg-surface px-3 py-1.5 text-xs text-muted opacity-50 cursor-not-allowed"
        >
          {translate(zh ? 'zh-CN' : 'en', 'renderer.assistant_settings.on')}
        </button>
        <span className="text-[10px] text-faint">
          {translate(zh ? 'zh-CN' : 'en', 'renderer.assistant_settings.requires_backend_support')}
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
      setStatus({ available: false, reasonCode: 'renderer.assistant_settings.failed_to_get_status' })
    }
    setLoading(false)
  }, [zh])

  useEffect(() => { void refresh() }, [refresh])

  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <label className="flex items-center gap-2 text-xs font-medium text-secondary">
          {translate(zh ? 'zh-CN' : 'en', 'renderer.assistant_settings.engine_status')}
        </label>
        <button
          onClick={() => void refresh()}
          disabled={loading}
          className="p-1 rounded hover:bg-hover text-muted hover:text-primary disabled:opacity-40"
          title={translate(zh ? 'zh-CN' : 'en', 'renderer.assistant_settings.refresh')}
        >
          <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {!status && loading && (
        <p className="text-[11px] text-muted">{translate(zh ? 'zh-CN' : 'en', 'renderer.assistant_settings.checking')}</p>
      )}

      {status && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-[11px]">
            <span className={`inline-block w-2 h-2 rounded-full ${status.available ? 'bg-green-400' : 'bg-red-400'}`} />
            <span className={status.available ? 'text-primary' : 'text-red-400'}>
              {status.available
                ? translate(zh ? 'zh-CN' : 'en', 'renderer.assistant_settings.available')
                : status.reasonCode
                  ? translate(zh ? 'zh-CN' : 'en', status.reasonCode)
                  : translate(zh ? 'zh-CN' : 'en', 'renderer.assistant_settings.unavailable')}
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
