import { useEffect, useRef, useState, useCallback } from 'react'
import {
  Globe, Keyboard, Palette, Sun, UserCircle, Check, X, ImageIcon, HardDrive, FolderPlus, Trash2
} from 'lucide-react'
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

function CodexHomesSection() {
  const t = useT()
  const codexApi = (window as any).api
  const [homes, setHomes] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    if (!codexApi?.getCodexHomes) {
      setLoading(false)
      return () => { active = false }
    }
    void codexApi.getCodexHomes().then((configured: string[]) => {
      if (active) setHomes(configured)
    }).catch(() => {
      if (active) setError(t('renderer.general_settings.codex_homes_load_error'))
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [])

  const persist = useCallback(async (next: string[]) => {
    if (!codexApi?.setCodexHomes) return
    setSaving(true)
    setError(null)
    try {
      setHomes(await codexApi.setCodexHomes(next))
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('renderer.general_settings.codex_homes_save_error'))
    } finally {
      setSaving(false)
    }
  }, [t])

  const addHomes = useCallback(async () => {
    if (!codexApi?.selectCodexHomes) return
    const selected = await codexApi.selectCodexHomes() as string[]
    if (selected.length === 0) return
    await persist([...new Set([...homes, ...selected])])
  }, [homes, persist])

  return (
    <SettingField
      label={t('renderer.general_settings.codex_homes')}
      hint={t('renderer.general_settings.codex_homes_hint')}
      icon={<HardDrive size={12} />}
    >
      <div className="max-w-[486px] rounded-md border border-edge bg-surface overflow-hidden">
        {loading ? (
          <div className="px-3 py-2 text-[11px] text-muted">
            {t('renderer.general_settings.codex_homes_loading')}
          </div>
        ) : homes.length === 0 ? (
          <div className="px-3 py-2 text-[11px] text-muted">
            {t('renderer.general_settings.codex_homes_empty')}
          </div>
        ) : homes.map((home) => (
          <div key={home} className="flex items-center gap-2 px-3 py-2 border-b border-edge last:border-b-0">
            <code className="min-w-0 flex-1 truncate text-[11px] text-secondary" title={home}>{home}</code>
            <button
              type="button"
              aria-label={t('renderer.general_settings.codex_home_remove', { value0: home })}
              disabled={saving}
              onClick={() => { void persist(homes.filter((candidate) => candidate !== home)) }}
              className="shrink-0 p-1 rounded text-muted hover:text-soft-red hover:bg-soft-red/10 disabled:opacity-40"
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        disabled={loading || saving}
        onClick={() => { void addHomes() }}
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-edge bg-surface text-xs text-secondary hover:text-primary hover:border-edge-focus disabled:opacity-40"
      >
        <FolderPlus size={12} />
        {saving
          ? t('renderer.general_settings.codex_homes_saving')
          : t('renderer.general_settings.codex_homes_add')}
      </button>
      {error && <p role="alert" className="text-[11px] text-soft-red break-words">{error}</p>}
    </SettingField>
  )
}

/* ── Theme families data ── */

interface FamilyColors {
  base: string; sidebar: string; surface: string
  text: string; accent: string; line: string
}

interface ThemeFamily {
  id: 'default' | 'paper' | 'nord'
  light: FamilyColors
  dark: FamilyColors
}

const THEME_FAMILIES: ThemeFamily[] = [
  {
    id: 'default',
    light: { base: '#ffffff', sidebar: '#e4e4e7', surface: '#f4f4f5', text: '#a1a1aa', accent: '#7a60a8', line: '#d4d4d8' },
    dark: { base: '#18181b', sidebar: '#27272a', surface: '#1e1e22', text: '#52525b', accent: '#8c72b8', line: '#3f3f46' },
  },
  {
    id: 'paper',
    light: { base: '#faf8f5', sidebar: '#e5e1db', surface: '#f0ede8', text: '#8a847e', accent: '#7452a8', line: '#d8d3cc' },
    dark: { base: '#1e1c1a', sidebar: '#2a2725', surface: '#2a2725', text: '#706a63', accent: '#a88fd0', line: '#3a3633' },
  },
  {
    id: 'nord',
    light: { base: '#eceff4', sidebar: '#d8dee9', surface: '#e5e9f0', text: '#6a7b96', accent: '#426b96', line: '#d8dee9' },
    dark: { base: '#2e3440', sidebar: '#3b4252', surface: '#3b4252', text: '#6a7b96', accent: '#88c0d0', line: '#434c5e' },
  },
]

type SchemeId = 'default' | 'paper' | 'nord'

function sLabel(id: string, t: (k: string) => string): string {
  const map: Record<string, string> = { default: t('settings.scheme_default'), paper: t('settings.scheme_paper'), nord: t('settings.scheme_nord') }
  return map[id] || id
}

/* ── Neutral app frame preview (no macOS traffic lights) ── */

function AppPreview({ colors, className }: { colors: FamilyColors; className?: string }) {
  return (
    <div className={`overflow-hidden flex flex-col ${className || ''}`} style={{ background: colors.base }}>
      {/* Toolbar */}
      <div className="h-[8px] flex items-center px-[4px] gap-[3px]" style={{ background: colors.sidebar }}>
        <div className="h-[3px] rounded-sm flex-1" style={{ background: colors.line, maxWidth: '40%' }} />
      </div>
      {/* Body */}
      <div className="flex-1 flex min-h-0">
        <div className="w-[26%] p-[3px] space-y-[2px]" style={{ background: colors.sidebar }}>
          <div className="h-[3px] rounded-sm" style={{ background: colors.accent, width: '65%', opacity: 0.5 }} />
          <div className="h-[3px] rounded-sm" style={{ background: colors.line, width: '80%' }} />
          <div className="h-[3px] rounded-sm" style={{ background: colors.line, width: '55%' }} />
        </div>
        <div className="flex-1 p-[4px] flex flex-col gap-[3px]" style={{ background: colors.surface }}>
          <div className="h-[4px] rounded-sm" style={{ background: colors.accent, width: '35%' }} />
          <div className="h-[4px] rounded-sm" style={{ background: colors.text, width: '70%' }} />
          <div className="h-[4px] rounded-sm" style={{ background: colors.text, width: '50%', opacity: 0.5 }} />
        </div>
      </div>
    </div>
  )
}

/* ── Shared: radio keyboard navigation for card groups ── */

function useRadioKeyboard(items: string[], selected: string, onSelect: (v: string) => void) {
  return useCallback((e: React.KeyboardEvent) => {
    const idx = items.indexOf(selected)
    if (idx < 0) return
    let next = -1
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (idx + 1) % items.length
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (idx - 1 + items.length) % items.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = items.length - 1
    if (next >= 0) {
      e.preventDefault()
      onSelect(items[next])
      const buttons = e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')
      requestAnimationFrame(() => buttons[next]?.focus())
    }
  }, [items, selected, onSelect])
}

const GRID_CLASS = 'flex flex-wrap gap-2.5 max-w-[486px]'
const CARD_W = 'w-[152px] flex-none'

/* ── Mode picker ── */

const MODE_IDS: Array<'light' | 'dark' | 'system'> = ['light', 'dark', 'system']

function ThemeModePicker({ value, onChange, t }: {
  value: string
  onChange: (v: 'light' | 'dark' | 'system') => void
  t: (key: string) => string
}) {
  const light = THEME_FAMILIES[0].light
  const dark = THEME_FAMILIES[0].dark
  const onKey = useRadioKeyboard(MODE_IDS, value, onChange as (v: string) => void)

  return (
    <div className={GRID_CLASS} role="radiogroup" aria-label={t('renderer.general_settings.theme_2')} onKeyDown={onKey}>
      {MODE_IDS.map((mode) => {
        const selected = value === mode
        return (
          <button
            key={mode}
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(mode)}
            className={`${CARD_W} rounded-md border-[1.5px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
              selected ? 'border-accent' : 'border-edge hover:border-edge-strong'
            }`}
          >
            <div className="h-[90px] rounded-t-[5px] overflow-hidden">
              {mode === 'system' ? (
                <div className="relative h-full">
                  <div className="absolute inset-0" style={{ clipPath: 'inset(0 50% 0 0)' }}>
                    <AppPreview colors={light} className="h-full" />
                  </div>
                  <div className="absolute inset-0" style={{ clipPath: 'inset(0 0 0 50%)' }}>
                    <AppPreview colors={dark} className="h-full" />
                  </div>
                </div>
              ) : (
                <AppPreview colors={mode === 'light' ? light : dark} className="h-full" />
              )}
            </div>
            <div className="flex items-center justify-center gap-1.5 py-1">
              <div className={`w-3 h-3 rounded-full border-[1.5px] flex items-center justify-center shrink-0 ${
                selected ? 'border-accent' : 'border-edge-strong'
              }`}>
                {selected && <div className="w-1.5 h-1.5 rounded-full bg-accent" />}
              </div>
              <span className={`text-xs ${selected ? 'text-accent font-medium' : 'text-primary'}`}>
                {t(`settings.theme_${mode}`)}
              </span>
            </div>
          </button>
        )
      })}
    </div>
  )
}

/* ── Theme family picker — checkmark, same width as mode cards ── */

const FAMILY_IDS = THEME_FAMILIES.map((f) => f.id)

function ColorSchemePicker({ value, onChange, isCustomPair, t }: {
  value: SchemeId
  onChange: (v: SchemeId) => void
  isCustomPair: boolean
  t: (key: string) => string
}) {
  const themeMode = useStore((s) => s.themeMode)
  const isSystem = themeMode === 'system'
  const isDark = themeMode === 'dark' || (isSystem && window.matchMedia('(prefers-color-scheme: dark)').matches)
  const onKey = useRadioKeyboard(FAMILY_IDS, value, onChange as (v: string) => void)

  return (
    <div className={GRID_CLASS} role="radiogroup" aria-label={t('settings.color_scheme')} onKeyDown={onKey}>
      {THEME_FAMILIES.map((family) => {
        const selected = !isCustomPair && value === family.id
        const focusAnchor = value === family.id
        return (
          <button
            key={family.id}
            role="radio"
            aria-checked={selected}
            tabIndex={focusAnchor ? 0 : -1}
            onClick={() => onChange(family.id)}
            className={`${CARD_W} rounded-md border-[1.5px] transition-colors relative focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
              selected ? 'border-accent' : 'border-edge hover:border-edge-strong'
            }`}
          >
            {selected && (
              <div className="absolute top-1 right-1 w-4 h-4 rounded-full bg-accent flex items-center justify-center z-10">
                <Check size={10} style={{ color: isDark ? '#18181b' : '#ffffff' }} />
              </div>
            )}
            <div className="h-[76px] rounded-t-[5px] overflow-hidden">
              {isSystem ? (
                <div className="relative h-full">
                  <div className="absolute inset-0" style={{ clipPath: 'inset(0 50% 0 0)' }}>
                    <AppPreview colors={family.light} className="h-full" />
                  </div>
                  <div className="absolute inset-0" style={{ clipPath: 'inset(0 0 0 50%)' }}>
                    <AppPreview colors={family.dark} className="h-full" />
                  </div>
                </div>
              ) : (
                <AppPreview colors={isDark ? family.dark : family.light} className="h-full" />
              )}
            </div>
            <div className="py-1 px-2 text-left">
              <span className={`text-xs ${selected ? 'text-accent font-medium' : 'text-primary'}`}>
                {sLabel(family.id, t)}
              </span>
            </div>
          </button>
        )
      })}
    </div>
  )
}

/* ── "分别设置" expandable section ── */

function CustomPairSection({ t, savePreferences, preferences, onFamilySelect }: {
  t: (k: string) => string
  savePreferences: (prefs: Record<string, unknown>) => Promise<void>
  preferences: Record<string, unknown>
  onFamilySelect: (id: SchemeId) => void
}) {
  const [open, setOpen] = useState(false)
  const colorScheme = useStore((s) => s.colorScheme)
  const setColorScheme = useStore((s) => s.setColorScheme)
  const lightScheme = (preferences.lightScheme as SchemeId) || colorScheme
  const darkScheme = (preferences.darkScheme as SchemeId) || colorScheme
  const isCustom = lightScheme !== darkScheme

  const handleChange = useCallback((slot: 'light' | 'dark', scheme: SchemeId) => {
    const next = { lightScheme: slot === 'light' ? scheme : lightScheme, darkScheme: slot === 'dark' ? scheme : darkScheme }
    void savePreferences(next)
    const tm = useStore.getState().themeMode
    const effectiveDark = tm === 'dark' || (tm === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    setColorScheme(effectiveDark ? next.darkScheme : next.lightScheme)
  }, [lightScheme, darkScheme, savePreferences, setColorScheme])

  const resetToFamily = useCallback(() => {
    void savePreferences({ lightScheme: colorScheme, darkScheme: colorScheme })
    onFamilySelect(colorScheme)
    setOpen(false)
  }, [colorScheme, savePreferences, onFamilySelect])

  const fam = (id: SchemeId) => THEME_FAMILIES.find((f) => f.id === id)!

  return (
    <div className="rounded-md border border-edge max-w-[486px]">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-secondary hover:text-primary"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}>
          <path d="M3 1l4 4-4 4" stroke="currentColor" strokeWidth="1.5" fill="none" />
        </svg>
        <span>{t('settings.custom_pair')}</span>
        {isCustom && !open && (
          <span className="text-[11px] text-muted ml-auto">
            {sLabel(lightScheme, t)} · {sLabel(darkScheme, t)}
          </span>
        )}
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {(['light', 'dark'] as const).map((slot) => {
              const current = slot === 'light' ? lightScheme : darkScheme
              return (
                <div key={slot} className="space-y-1.5">
                  <div className="text-[11px] font-medium text-secondary">
                    {t(`settings.${slot}_theme_slot`)}
                  </div>
                  <div className="text-[11px] text-muted">{t(`settings.${slot}_theme_slot_hint`)}</div>
                  <select
                    value={current}
                    onChange={(e) => handleChange(slot, e.target.value as SchemeId)}
                    className="w-full rounded border border-edge bg-surface px-2 py-1.5 text-xs text-primary outline-none focus:border-accent"
                  >
                    {THEME_FAMILIES.map((f) => <option key={f.id} value={f.id}>{sLabel(f.id, t)}</option>)}
                  </select>
                  <AppPreview colors={fam(current)[slot]} className="h-10 rounded border border-edge" />
                </div>
              )
            })}
          </div>
          {isCustom && (
            <button onClick={resetToFamily} className="text-[11px] text-muted hover:text-accent">
              {t('settings.reset_to_family')}
            </button>
          )}
        </div>
      )}
    </div>
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
      <CodexHomesSection />

      <SettingField label={t('settings.appearance_mode')} hint={t('settings.appearance_mode_hint')} icon={<Sun size={12} />}>
        <ThemeModePicker value={themeMode} onChange={setThemeMode} t={t} />
      </SettingField>

      <SettingField label={t('settings.color_scheme')} hint={t('settings.color_scheme_hint')} icon={<Palette size={12} />}>
        <ColorSchemePicker
          value={colorScheme}
          isCustomPair={
            themeMode === 'system' &&
            typeof preferences.lightScheme === 'string' &&
            typeof preferences.darkScheme === 'string' &&
            preferences.lightScheme !== preferences.darkScheme
          }
          onChange={(id) => {
            setColorScheme(id)
            void savePreferences({ lightScheme: id, darkScheme: id })
          }}
          t={t}
        />
        {themeMode === 'system' && (
          <div className="mt-3">
            <CustomPairSection t={t} savePreferences={savePreferences} preferences={preferences} onFamilySelect={setColorScheme} />
          </div>
        )}
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
