import { useEffect, useRef, useState, useCallback } from 'react'
import { Globe, Keyboard, Palette, Sun, UserCircle, Check, X, ImageIcon } from 'lucide-react'
import { useStore } from '../../store'
import { useT } from '../../i18n'
import { SettingField, Segmented, useSettingsPreferences } from './shared'
import { RetentionSection, formatAccelerator, keyEventToAccelerator } from './sections'
import {
  getRegisteredSources,
  getHarnessPresentation,
  refreshHarnessIconOverrides
} from '../../utils/harness-presentation'

const api = (window as any).api

function IdentitySection() {
  const locale = useStore((s) => s.locale)
  const t = useT()
  const [displayName, setDisplayName] = useState('')
  const [saved, setSaved] = useState(false)
  const [loading, setLoading] = useState(true)
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null)
  const [avatarAvailable, setAvatarAvailable] = useState(false)
  const [avatarError, setAvatarError] = useState<string | null>(null)

  useEffect(() => {
    if (!api?.profileGetUserIdentity) {
      setLoading(false)
      return
    }
    api.profileGetUserIdentity().then(async (result: { ok: boolean; value?: { displayName: string; avatarRelPath?: string; avatarAvailable: boolean } }) => {
      if (result.ok && result.value) {
        if (result.value.displayName) setDisplayName(result.value.displayName)
        setAvatarAvailable(result.value.avatarAvailable)
        if (result.value.avatarAvailable && result.value.avatarRelPath) {
          // Load avatar image via libraryGetRoot + loadImage
          try {
            const root = await api.libraryGetRoot()
            if (root) {
              const absPath = `${root}/${result.value.avatarRelPath}`
              const imgResult = await api.loadImage(absPath)
              if (imgResult?.dataUrl) setAvatarPreview(imgResult.dataUrl)
            }
          } catch { /* avatar display failed gracefully */ }
        }
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

  const handleAvatarSelect = useCallback(async () => {
    if (!api?.profileSelectImage || !api?.profileSetUserIdentity) return
    setAvatarError(null)
    try {
      const selection = await api.profileSelectImage()
      if (!selection.ok || selection.value.canceled || !selection.value.filePath) return
      const result = await api.profileSetUserIdentity({
        displayName: displayName.trim() || 'User',
        avatarRelPath: selection.value.filePath
      })
      if (result.ok && result.value?.avatarAvailable) {
        setAvatarAvailable(true)
        // Reload image preview
        const root = await api.libraryGetRoot()
        if (root && result.value.avatarRelPath) {
          const absPath = `${root}/${result.value.avatarRelPath}`
          const imgResult = await api.loadImage(absPath)
          if (imgResult?.dataUrl) setAvatarPreview(imgResult.dataUrl)
        }
        setSaved(true)
        setTimeout(() => setSaved(false), 1500)
      } else if (!result.ok) {
        setAvatarError(result.error.code === 'FILE_TOO_LARGE'
          ? t('renderer.general_settings.avatar_too_large')
          : t('renderer.general_settings.avatar_invalid'))
      }
    } catch {
      setAvatarError(t('renderer.general_settings.avatar_invalid'))
    }
  }, [displayName, t])

  const handleAvatarRemove = useCallback(async () => {
    if (!api?.profileSetUserIdentity) return
    try {
      const result = await api.profileSetUserIdentity({
        displayName: displayName.trim() || 'User',
        avatarRelPath: ''
      })
      if (result.ok) {
        setAvatarPreview(null)
        setAvatarAvailable(false)
        setSaved(true)
        setTimeout(() => setSaved(false), 1500)
      }
    } catch { /* ignore */ }
  }, [displayName])

  if (loading) return null

  const initial = displayName.trim().charAt(0).toUpperCase() || 'U'

  return (
    <SettingField
      label={t('renderer.general_settings.identity')}
      hint={t('renderer.general_settings.identity_hint')}
      icon={<UserCircle size={12} />}
    >
      <div className="flex items-center gap-3">
        {/* Avatar preview + picker */}
        <div className="relative group shrink-0">
          {avatarPreview ? (
            <img
              src={avatarPreview}
              className="w-10 h-10 rounded-full object-cover border border-edge"
              alt=""
              onError={() => { setAvatarPreview(null); setAvatarAvailable(false) }}
            />
          ) : (
            <div className="w-10 h-10 rounded-full bg-[#5a8fb8] text-white flex items-center justify-center text-sm font-semibold border border-edge">
              {initial}
            </div>
          )}
          <button
            onClick={handleAvatarSelect}
            className="absolute inset-0 rounded-full bg-black/40 text-white opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
            title={t('renderer.general_settings.choose_avatar')}
          >
            <ImageIcon size={14} />
          </button>
          {avatarAvailable && (
            <button
              onClick={handleAvatarRemove}
              className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-soft-red text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
              title={t('renderer.general_settings.remove_avatar')}
            >
              <X size={10} />
            </button>
          )}
        </div>

        <div className="flex items-center gap-2 flex-1">
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
      </div>
      {avatarError && <p className="mt-1.5 text-[10px] text-soft-red">{avatarError}</p>}
    </SettingField>
  )
}

function HarnessIconSection() {
  const t = useT()
  const sources = getRegisteredSources()
  const [customSources, setCustomSources] = useState<Set<string>>(new Set())
  const [busySource, setBusySource] = useState<string | null>(null)
  const [, setRevision] = useState(0)

  useEffect(() => {
    if (!api?.profileGetHarnessIconOverrides) return
    void api.profileGetHarnessIconOverrides().then((result: any) => {
      if (!result.ok) return
      setCustomSources(new Set(result.value
        .filter((item: any) => item.iconAvailable)
        .map((item: any) => item.source)))
    })
  }, [])

  const chooseIcon = useCallback(async (source: string) => {
    if (!api?.profileSelectImage || !api?.profileSetHarnessIconOverride) return
    setBusySource(source)
    try {
      const selection = await api.profileSelectImage()
      if (!selection.ok || selection.value.canceled || !selection.value.filePath) return
      const result = await api.profileSetHarnessIconOverride({
        source,
        iconRelPath: selection.value.filePath
      })
      if (!result.ok) return
      await refreshHarnessIconOverrides(api)
      setCustomSources((current) => new Set(current).add(source))
      setRevision((revision) => revision + 1)
    } finally {
      setBusySource(null)
    }
  }, [])

  const removeIcon = useCallback(async (source: string) => {
    if (!api?.profileSetHarnessIconOverride) return
    setBusySource(source)
    try {
      const result = await api.profileSetHarnessIconOverride({ source, iconRelPath: '' })
      if (!result.ok) return
      await refreshHarnessIconOverrides(api)
      setCustomSources((current) => {
        const next = new Set(current)
        next.delete(source)
        return next
      })
      setRevision((revision) => revision + 1)
    } finally {
      setBusySource(null)
    }
  }, [])

  return (
    <SettingField
      label={t('renderer.general_settings.custom_icon')}
      hint={t('renderer.general_settings.custom_icon_hint')}
      icon={<ImageIcon size={12} />}
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {sources.map((source) => {
          const p = getHarnessPresentation(source)
          return (
            <div
              key={source}
              className="flex items-center gap-2 px-2 py-1.5 rounded-md border border-edge bg-surface text-xs"
            >
              {p.iconImage ? (
                <img src={p.iconImage} className="w-4 h-4 rounded-full" alt="" />
              ) : (
                <span className={`w-4 h-4 rounded-full flex items-center justify-center text-[8px] font-semibold ${p.badgeClass}`}>
                  {p.shortLabel}
                </span>
              )}
              <span className="text-secondary flex-1 truncate">{p.displayName}</span>
              <button
                type="button"
                disabled={busySource === source}
                onClick={() => { void chooseIcon(source) }}
                className="shrink-0 px-1.5 py-0.5 rounded text-[10px] text-accent hover:bg-accent/10 disabled:opacity-40"
              >
                {t('renderer.general_settings.choose_icon')}
              </button>
              {customSources.has(source) && (
                <button
                  type="button"
                  disabled={busySource === source}
                  onClick={() => { void removeIcon(source) }}
                  className="shrink-0 px-1.5 py-0.5 rounded text-[10px] text-soft-red hover:bg-soft-red/10 disabled:opacity-40"
                >
                  {t('renderer.general_settings.remove_icon')}
                </button>
              )}
            </div>
          )
        })}
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
      <HarnessIconSection />

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
