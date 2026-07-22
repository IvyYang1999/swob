import { useEffect, useRef, useState } from 'react'
import { Globe, Keyboard, Sun } from 'lucide-react'
import { useStore } from '../../store'
import { useT } from '../../i18n'
import { copy, SettingField, Segmented, useSettingsPreferences } from './shared'
import { RetentionSection, formatAccelerator, keyEventToAccelerator } from './sections'

export function GeneralSettings() {
  const { locale, setLocale, themeMode, setThemeMode, savePreferences } = useStore()
  const t = useT()
  const preferences = useSettingsPreferences()
  const [recording, setRecording] = useState(false)
  const [pendingShortcut, setPendingShortcut] = useState<string | null>(null)
  const shortcutButton = useRef<HTMLButtonElement>(null)
  const currentShortcut = String(preferences.spotlightShortcut || 'CommandOrControl+Shift+Space')

  useEffect(() => {
    if (!recording) return
    const handleKeyDown = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopPropagation()
      const accelerator = keyEventToAccelerator(event)
      if (!accelerator) return
      setPendingShortcut(accelerator)
      setRecording(false)
      savePreferences({ spotlightShortcut: accelerator })
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [recording, savePreferences])

  return (
    <>
      <SettingField label={copy(locale, '主题', 'Theme', 'テーマ')} icon={<Sun size={12} />}>
        <Segmented
          ariaLabel={copy(locale, '主题', 'Theme', 'テーマ')}
          value={themeMode}
          onChange={setThemeMode}
          options={[
            { value: 'light', label: t('settings.theme_light') },
            { value: 'dark', label: t('settings.theme_dark') },
            { value: 'system', label: t('settings.theme_system') }
          ]}
        />
      </SettingField>

      <SettingField label={t('settings.language')} icon={<Globe size={12} />}>
        <Segmented
          ariaLabel={t('settings.language')}
          value={locale}
          onChange={(value) => { void setLocale(value) }}
          options={[
            { value: 'zh-CN', label: '中文' },
            { value: 'en', label: 'English' }
          ]}
        />
      </SettingField>

      <SettingField label={t('settings.spotlight_shortcut')} hint={t('settings.spotlight_shortcut_hint')} icon={<Keyboard size={12} />}>
        <div className="flex items-center gap-2">
          <button
            ref={shortcutButton}
            onClick={() => { setRecording(true); setPendingShortcut(null) }}
            className={`flex-1 max-w-64 px-3 py-1.5 rounded-md text-xs border text-left font-mono ${recording ? 'border-accent text-accent bg-accent/5' : 'border-edge bg-surface text-primary hover:border-edge-focus'}`}
          >
            {recording ? t('settings.spotlight_shortcut_recording') : formatAccelerator(pendingShortcut || currentShortcut)}
          </button>
          {(pendingShortcut || currentShortcut !== 'CommandOrControl+Shift+Space') && (
            <button onClick={() => { setPendingShortcut(null); savePreferences({ spotlightShortcut: 'CommandOrControl+Shift+Space' }) }} className="text-[11px] text-muted hover:text-primary">
              {t('settings.reset_shortcut')}
            </button>
          )}
        </div>
      </SettingField>

      <RetentionSection />
    </>
  )
}
