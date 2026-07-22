import { useEffect, useRef, useState, useCallback } from 'react'
import { Globe, Keyboard, Palette, Sun, UserCircle, Check } from 'lucide-react'
import { useStore } from '../../store'
import { useT } from '../../i18n'
import { SettingField, Segmented, useSettingsPreferences } from './shared'
import { RetentionSection, formatAccelerator, keyEventToAccelerator } from './sections'

const api = (window as any).api

function IdentitySection() {
  const locale = useStore((s) => s.locale)
  const t = useT()
  const [displayName, setDisplayName] = useState('')
  const [saved, setSaved] = useState(false)
  const [loading, setLoading] = useState(true)
  const zh = locale === 'zh-CN'

  useEffect(() => {
    if (!api?.profileGetUserIdentity) {
      setLoading(false)
      return
    }
    api.profileGetUserIdentity().then((result: { ok: boolean; value?: { displayName: string } }) => {
      if (result.ok && result.value?.displayName) {
        setDisplayName(result.value.displayName)
      }
    }).catch(() => { /* ignore */ }).finally(() => setLoading(false))
  }, [])

  const handleSave = useCallback(() => {
    if (!api?.profileSetUserIdentity) return
    const trimmed = displayName.trim()
    api.profileSetUserIdentity({ displayName: trimmed }).then((result: { ok: boolean }) => {
      if (result.ok) {
        setSaved(true)
        setTimeout(() => setSaved(false), 1500)
      }
    }).catch(() => { /* ignore */ })
  }, [displayName])

  if (loading) return null

  return (
    <SettingField
      label={t('renderer.general_settings.identity')}
      hint={t('renderer.general_settings.identity_hint')}
      icon={<UserCircle size={12} />}
    >
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder={t('renderer.general_settings.display_name')}
          className="flex-1 max-w-64 px-3 py-1.5 rounded-md text-xs border border-edge bg-surface text-primary placeholder:text-faint focus:border-edge-focus focus:outline-none"
        />
        <button
          onClick={handleSave}
          disabled={!displayName.trim()}
          className="px-3 py-1.5 rounded-md text-xs bg-accent/15 text-accent hover:bg-accent/25 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1"
        >
          {saved ? <Check size={11} /> : null}
          {saved ? t('renderer.general_settings.saved') : t('renderer.general_settings.save')}
        </button>
      </div>
    </SettingField>
  )
}

export function GeneralSettings() {
  const { locale, setLocale, themeMode, setThemeMode, colorScheme, setColorScheme, savePreferences } = useStore()
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
      <IdentitySection />

      <SettingField label={t('renderer.general_settings.theme')} icon={<Sun size={12} />}>
        <Segmented
          ariaLabel={t('renderer.general_settings.theme_2')}
          value={themeMode}
          onChange={setThemeMode}
          options={[
            { value: 'light', label: t('settings.theme_light') },
            { value: 'dark', label: t('settings.theme_dark') },
            { value: 'system', label: t('settings.theme_system') }
          ]}
        />
      </SettingField>

      <SettingField label={t('settings.color_scheme')} icon={<Palette size={12} />}>
        <Segmented
          ariaLabel={t('settings.color_scheme')}
          value={colorScheme}
          onChange={setColorScheme}
          options={[
            { value: 'default', label: t('settings.scheme_default') },
            { value: 'paper', label: t('settings.scheme_paper') },
            { value: 'nord', label: t('settings.scheme_nord') }
          ]}
        />
        <p className="mt-2 text-faint text-[10px]">{t('settings.theme_ecosystem_teaser')}</p>
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
