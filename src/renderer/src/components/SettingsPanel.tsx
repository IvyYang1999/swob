import { useState, useCallback, useEffect, useRef } from 'react'
import { useStore } from '../store'
import { useT } from '../i18n'
import { X, Sun, Moon, Monitor, Globe, Keyboard, Server } from 'lucide-react'

const ELECTRON_MODIFIER_MAP: Record<string, string> = {
  Meta: 'CommandOrControl',
  Control: 'CommandOrControl',
  Alt: 'Alt',
  Shift: 'Shift'
}

const DISPLAY_MODIFIER_MAP: Record<string, string> = {
  CommandOrControl: '⌘',
  Alt: '⌥',
  Shift: '⇧'
}

function keyEventToAccelerator(e: KeyboardEvent): string | null {
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return null

  const parts: string[] = []
  if (e.metaKey || e.ctrlKey) parts.push('CommandOrControl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')

  if (parts.length === 0) return null

  let key = e.key.length === 1 ? e.key.toUpperCase() : e.key
  if (key === ' ') key = 'Space'
  parts.push(key)
  return parts.join('+')
}

function formatAccelerator(accel: string): string {
  return accel
    .split('+')
    .map((p) => DISPLAY_MODIFIER_MAP[p] || p)
    .join('')
}

export function SettingsPanel() {
  const {
    settingsOpen, toggleSettings,
    locale, setLocale,
    themeMode, setThemeMode,
    config, savePreferences,
    sshConfig, setSshConfig
  } = useStore()
  const t = useT()

  const currentShortcut = config?.preferences?.spotlightShortcut || 'CommandOrControl+Shift+Space'
  const [recording, setRecording] = useState(false)
  const [pendingShortcut, setPendingShortcut] = useState<string | null>(null)
  const shortcutRef = useRef<HTMLButtonElement>(null)

  const [sshHost, setSshHost] = useState(sshConfig?.host || '')
  const [sshUser, setSshUser] = useState(sshConfig?.user || '')
  const [sshRemotePath, setSshRemotePath] = useState(sshConfig?.remotePath || '')

  useEffect(() => {
    setSshHost(sshConfig?.host || '')
    setSshUser(sshConfig?.user || '')
    setSshRemotePath(sshConfig?.remotePath || '')
  }, [sshConfig])

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (!recording) return
    e.preventDefault()
    e.stopPropagation()
    const accel = keyEventToAccelerator(e)
    if (accel) {
      setPendingShortcut(accel)
      setRecording(false)
      savePreferences({ spotlightShortcut: accel })
    }
  }, [recording, savePreferences])

  useEffect(() => {
    if (recording) {
      window.addEventListener('keydown', handleKeyDown, true)
      return () => window.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [recording, handleKeyDown])

  const handleSshSave = useCallback(async () => {
    if (!sshHost.trim() || !sshUser.trim()) return
    await setSshConfig({ host: sshHost.trim(), user: sshUser.trim(), remotePath: sshRemotePath.trim() || undefined })
  }, [sshHost, sshUser, sshRemotePath, setSshConfig])

  if (!settingsOpen) return null

  return (
    <div className="w-72 border-l border-edge bg-base flex flex-col h-full shrink-0 overflow-y-auto">
      <div className="flex items-center justify-between px-4 py-3 border-b border-edge">
        <h2 className="text-sm font-medium text-primary">{t('settings.title')}</h2>
        <button onClick={toggleSettings} className="p-1 rounded hover:bg-hover text-muted hover:text-primary">
          <X size={14} />
        </button>
      </div>

      <div className="p-4 space-y-4">
        {/* Theme */}
        <section>
          <label className="flex items-center gap-2 text-xs font-medium text-secondary mb-2">
            <Sun size={12} />
            {t('settings.theme')}
          </label>
          <div className="flex gap-1">
            {(['light', 'dark', 'system'] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setThemeMode(mode)}
                className={`flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-md text-xs transition-colors ${
                  themeMode === mode
                    ? 'bg-accent/15 text-accent'
                    : 'bg-surface text-muted hover:text-primary hover:bg-hover'
                }`}
              >
                {mode === 'light' && <Sun size={11} />}
                {mode === 'dark' && <Moon size={11} />}
                {mode === 'system' && <Monitor size={11} />}
                {t(`settings.theme_${mode}`)}
              </button>
            ))}
          </div>
        </section>

        {/* Language */}
        <section>
          <label className="flex items-center gap-2 text-xs font-medium text-secondary mb-2">
            <Globe size={12} />
            {t('settings.language')}
          </label>
          <div className="flex gap-1">
            {([['zh-CN', '中文'], ['en', 'English']] as const).map(([code, label]) => (
              <button
                key={code}
                onClick={() => setLocale(code)}
                className={`flex-1 px-2 py-1.5 rounded-md text-xs transition-colors ${
                  locale === code
                    ? 'bg-accent/15 text-accent'
                    : 'bg-surface text-muted hover:text-primary hover:bg-hover'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </section>

        {/* Spotlight shortcut */}
        <section>
          <label className="flex items-center gap-2 text-xs font-medium text-secondary mb-2">
            <Keyboard size={12} />
            {t('settings.spotlight_shortcut')}
          </label>
          <div className="flex items-center gap-2">
            <button
              ref={shortcutRef}
              onClick={() => { setRecording(true); setPendingShortcut(null) }}
              className={`flex-1 px-3 py-1.5 rounded-md text-xs border transition-colors text-left font-mono ${
                recording
                  ? 'border-accent text-accent bg-accent/5'
                  : 'border-edge bg-surface text-primary hover:border-edge-focus'
              }`}
            >
              {recording
                ? t('settings.spotlight_shortcut_recording')
                : formatAccelerator(pendingShortcut || currentShortcut)
              }
            </button>
            {(pendingShortcut || currentShortcut !== 'CommandOrControl+Shift+Space') && (
              <button
                onClick={() => {
                  setPendingShortcut(null)
                  savePreferences({ spotlightShortcut: 'CommandOrControl+Shift+Space' })
                }}
                className="text-[11px] text-muted hover:text-primary"
              >
                {t('settings.reset_shortcut')}
              </button>
            )}
          </div>
          <p className="text-[11px] text-faint mt-1">{t('settings.spotlight_shortcut_hint')}</p>
        </section>

        {/* SSH */}
        <section>
          <label className="flex items-center gap-2 text-xs font-medium text-secondary mb-2">
            <Server size={12} />
            {t('settings.ssh')}
          </label>
          <div className="space-y-2">
            <input
              value={sshHost}
              onChange={(e) => setSshHost(e.target.value)}
              placeholder={t('settings.ssh_host')}
              className="w-full px-2 py-1.5 text-xs bg-surface border border-edge rounded-md text-primary placeholder:text-muted focus:outline-none focus:border-edge-focus"
            />
            <input
              value={sshUser}
              onChange={(e) => setSshUser(e.target.value)}
              placeholder={t('settings.ssh_user')}
              className="w-full px-2 py-1.5 text-xs bg-surface border border-edge rounded-md text-primary placeholder:text-muted focus:outline-none focus:border-edge-focus"
            />
            <input
              value={sshRemotePath}
              onChange={(e) => setSshRemotePath(e.target.value)}
              placeholder={t('settings.ssh_remote_path')}
              className="w-full px-2 py-1.5 text-xs bg-surface border border-edge rounded-md text-primary placeholder:text-muted focus:outline-none focus:border-edge-focus"
            />
            <div className="flex gap-2">
              <button
                onClick={handleSshSave}
                disabled={!sshHost.trim() || !sshUser.trim()}
                className="flex-1 px-2 py-1.5 rounded-md text-xs bg-accent/15 text-accent hover:bg-accent/25 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {t('settings.ssh_save')}
              </button>
              {sshConfig && (
                <button
                  onClick={() => setSshConfig(null)}
                  className="px-2 py-1.5 rounded-md text-xs text-muted hover:text-danger hover:bg-danger/10 transition-colors"
                >
                  {t('settings.ssh_clear')}
                </button>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
