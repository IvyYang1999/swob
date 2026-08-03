/**
 * tF30: Lens management settings page.
 *
 * Displays all built-in Lenses as toggleable cards with scene badges,
 * up/down reorder buttons, and a marketplace teaser.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  Highlighter, Image, FileOutput, BarChart3, GitBranch, ShieldCheck, Share2,
  ChevronUp, ChevronDown, PackageOpen, Trash2, Upload, Palette, ListChecks, LayoutTemplate
} from 'lucide-react'
import { useStore } from '../../store'
import { useT } from '../../i18n'
import {
  BUILTIN_LENSES,
  preferencesForLensPreset,
  type LensContribution,
  type SceneTag
} from '../../../../shared/lens-registry'
import {
  SWOBLENS_THEME_TOKEN_KEYS,
  type InstalledSwobLensPackage,
  type SwobLensPackagePreview,
  type SwobLensPresetDeclaration,
  type SwobLensThemeDeclaration
} from '../../../../shared/swoblens-manifest'
import { replaceDeclarativeShareThemes } from '../share/share-themes'

// ---------------------------------------------------------------------------
// Icon resolver — maps string icon names to lucide components
// ---------------------------------------------------------------------------

const ICON_MAP: Record<string, typeof Highlighter> = {
  Highlighter,
  Image,
  FileOutput,
  BarChart3,
  GitBranch,
  ShieldCheck,
  Share2
}

function LensIcon({ name, size = 16, className }: { name: string; size?: number; className?: string }) {
  const Icon = ICON_MAP[name]
  if (!Icon) return null
  return <Icon size={size} className={className} />
}

// ---------------------------------------------------------------------------
// Scene badge
// ---------------------------------------------------------------------------

const SCENE_LABEL_KEYS: Record<SceneTag, string> = {
  knowledge: 'renderer.lens.scene_knowledge',
  developer: 'renderer.lens.scene_developer',
  team: 'renderer.lens.scene_team'
}

const SCENE_COLORS: Record<SceneTag, string> = {
  knowledge: 'bg-soft-blue/15 text-soft-blue',
  developer: 'bg-soft-purple/15 text-soft-purple',
  team: 'bg-soft-green/15 text-soft-green'
}

function SceneBadge({ tag }: { tag: SceneTag }) {
  const t = useT()
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${SCENE_COLORS[tag]}`}>
      {t(SCENE_LABEL_KEYS[tag])}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Single Lens card
// ---------------------------------------------------------------------------

function LensCard({
  lens,
  enabled,
  onToggle,
  onMoveUp,
  onMoveDown,
  isFirst,
  isLast,
  locale
}: {
  lens: LensContribution
  enabled: boolean
  onToggle: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  isFirst: boolean
  isLast: boolean
  locale: 'zh-CN' | 'en'
}) {
  const t = useT()
  return (
    <div className={`flex items-start gap-3 p-3 rounded-lg border transition-colors ${
      enabled ? 'border-edge bg-surface' : 'border-edge/50 bg-surface/50 opacity-60'
    }`}>
      {/* Icon */}
      <div className="mt-0.5 shrink-0 w-8 h-8 rounded-md bg-accent/10 flex items-center justify-center">
        <LensIcon name={lens.icon} size={16} className="text-accent" />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-sm font-medium text-primary">{lens.name[locale]}</span>
          <span className="text-[10px] px-1 py-px rounded bg-edge/80 text-muted font-medium">
            {t('renderer.lens.built_in')}
          </span>
        </div>
        <p className="text-xs text-secondary mb-1.5">{lens.description[locale]}</p>
        <div className="flex items-center gap-1">
          {lens.sceneTags.map((tag) => (
            <SceneBadge key={tag} tag={tag} />
          ))}
        </div>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-1 shrink-0">
        {/* Reorder buttons */}
        <div className="flex flex-col gap-px mr-1">
          <button
            type="button"
            onClick={onMoveUp}
            disabled={isFirst}
            className="p-0.5 rounded hover:bg-hover text-muted hover:text-primary disabled:opacity-30 disabled:cursor-not-allowed"
            aria-label={`${lens.name[locale]} ↑`}
          >
            <ChevronUp size={12} />
          </button>
          <button
            type="button"
            onClick={onMoveDown}
            disabled={isLast}
            className="p-0.5 rounded hover:bg-hover text-muted hover:text-primary disabled:opacity-30 disabled:cursor-not-allowed"
            aria-label={`${lens.name[locale]} ↓`}
          >
            <ChevronDown size={12} />
          </button>
        </div>

        {/* Toggle switch */}
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={lens.name[locale]}
          onClick={onToggle}
          className={`relative w-9 h-5 rounded-full transition-colors ${
            enabled ? 'bg-accent' : 'bg-edge-strong'
          }`}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${
              enabled ? 'translate-x-4' : 'translate-x-0'
            }`}
          />
        </button>
      </div>
    </div>
  )
}

function PackageTypeIcon({ type }: { type: InstalledSwobLensPackage['manifest']['type'] }) {
  if (type === 'theme') return <Palette size={15} />
  if (type === 'lens-preset') return <ListChecks size={15} />
  return <LayoutTemplate size={15} />
}

function syncDeclarativePackageEffects(
  packages: readonly InstalledSwobLensPackage[],
  locale: 'zh-CN' | 'en',
  theme: 'dark' | 'light'
): void {
  replaceDeclarativeShareThemes(packages, locale)
  for (const token of SWOBLENS_THEME_TOKEN_KEYS) document.documentElement.style.removeProperty(`--color-${token}`)
  const activeTheme = packages.find((item) => item.enabled && item.manifest.type === 'theme')
  if (!activeTheme) return
  const declaration = activeTheme.declaration as SwobLensThemeDeclaration
  if (declaration.mode !== 'both' && declaration.mode !== theme) return
  for (const [token, value] of Object.entries(declaration.tokens)) {
    document.documentElement.style.setProperty(`--color-${token}`, value)
  }
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function LensSettings() {
  const t = useT()
  const locale = useStore((state) => state.locale)
  const config = useStore((state) => state.config)
  const toggleLens = useStore((state) => state.toggleLens)
  const reorderLenses = useStore((state) => state.reorderLenses)
  const savePreferences = useStore((state) => state.savePreferences)
  const theme = useStore((state) => state.theme)
  const [packages, setPackages] = useState<readonly InstalledSwobLensPackage[]>([])
  const [packageErrors, setPackageErrors] = useState(0)
  const [preview, setPreview] = useState<SwobLensPackagePreview | null>(null)
  const [packageError, setPackageError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const allIds = BUILTIN_LENSES.map((l) => l.id)
  const enabledIds = config?.preferences.enabledLenses ?? allIds
  const orderIds = config?.preferences.lensOrder ?? allIds

  // Sorted list of lenses by custom order
  const sortedLenses = [...BUILTIN_LENSES].sort((a, b) => {
    const ia = orderIds.indexOf(a.id)
    const ib = orderIds.indexOf(b.id)
    return (ia === -1 ? Infinity : ia) - (ib === -1 ? Infinity : ib)
  })

  const handleMoveUp = useCallback((lensId: string) => {
    const ids = sortedLenses.map((l) => l.id)
    const idx = ids.indexOf(lensId)
    if (idx <= 0) return
    const next = [...ids]
    ;[next[idx - 1], next[idx]] = [next[idx], next[idx - 1]]
    reorderLenses(next)
  }, [sortedLenses, reorderLenses])

  const handleMoveDown = useCallback((lensId: string) => {
    const ids = sortedLenses.map((l) => l.id)
    const idx = ids.indexOf(lensId)
    if (idx < 0 || idx >= ids.length - 1) return
    const next = [...ids]
    ;[next[idx], next[idx + 1]] = [next[idx + 1], next[idx]]
    reorderLenses(next)
  }, [sortedLenses, reorderLenses])

  const displayLocale = locale === 'zh-CN' ? 'zh-CN' : 'en'

  const refreshPackages = useCallback(async () => {
    if (typeof window.api.swobLensList !== 'function') return [] as readonly InstalledSwobLensPackage[]
    const result = await window.api.swobLensList()
    if (!result.ok) {
      setPackageError(result.error.message)
      return [] as readonly InstalledSwobLensPackage[]
    }
    setPackages(result.value.packages)
    setPackageErrors(result.value.errors.length)
    syncDeclarativePackageEffects(result.value.packages, displayLocale, theme)
    return result.value.packages
  }, [displayLocale, theme])

  useEffect(() => {
    void refreshPackages()
  }, [refreshPackages])

  const selectPackage = useCallback(async () => {
    setBusy('select')
    setPackageError(null)
    try {
      const result = await window.api.swobLensSelectAndPreview()
      if (!result.ok) setPackageError(result.error.message)
      else setPreview(result.value)
    } finally {
      setBusy(null)
    }
  }, [])

  const applyPreset = useCallback(async (installed: InstalledSwobLensPackage) => {
    if (installed.enabled && installed.manifest.type === 'lens-preset') {
      await savePreferences(preferencesForLensPreset(installed.declaration as SwobLensPresetDeclaration))
    }
  }, [savePreferences])

  const installPreview = useCallback(async () => {
    if (!preview) return
    setBusy('install')
    setPackageError(null)
    try {
      const result = await window.api.swobLensInstall({ sourcePath: preview.sourcePath, digest: preview.digest })
      if (!result.ok) {
        setPackageError(result.error.message)
        return
      }
      await applyPreset(result.value)
      setPreview(null)
      await refreshPackages()
    } finally {
      setBusy(null)
    }
  }, [applyPreset, preview, refreshPackages])

  const togglePackage = useCallback(async (installed: InstalledSwobLensPackage) => {
    setBusy(installed.manifest.id)
    setPackageError(null)
    try {
      const result = await window.api.swobLensSetEnabled({
        id: installed.manifest.id,
        enabled: !installed.enabled
      })
      if (!result.ok) {
        setPackageError(result.error.message)
        return
      }
      await applyPreset(result.value)
      await refreshPackages()
    } finally {
      setBusy(null)
    }
  }, [applyPreset, refreshPackages])

  const uninstallPackage = useCallback(async (installed: InstalledSwobLensPackage) => {
    setBusy(installed.manifest.id)
    setPackageError(null)
    try {
      const result = await window.api.swobLensUninstall(installed.manifest.id)
      if (!result.ok) setPackageError(result.error.message)
      else await refreshPackages()
    } finally {
      setBusy(null)
    }
  }, [refreshPackages])

  return (
    <div className="space-y-4">
      {/* Lens cards */}
      <div className="space-y-2">
        {sortedLenses.map((lens, idx) => (
          <LensCard
            key={lens.id}
            lens={lens}
            enabled={enabledIds.includes(lens.id)}
            onToggle={() => toggleLens(lens.id)}
            onMoveUp={() => handleMoveUp(lens.id)}
            onMoveDown={() => handleMoveDown(lens.id)}
            isFirst={idx === 0}
            isLast={idx === sortedLenses.length - 1}
            locale={displayLocale}
          />
        ))}
      </div>

      <section data-swoblens-packages className="rounded-lg border border-edge bg-surface/40 p-3 space-y-3">
        <div className="flex flex-col items-start gap-3 sm:flex-row sm:justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-primary">
              <PackageOpen size={15} className="text-accent" />
              {t('renderer.lens.packages_title')}
            </div>
            <p className="mt-1 text-[11px] text-muted">{t('renderer.lens.packages_hint')}</p>
          </div>
          <button
            type="button"
            onClick={() => void selectPackage()}
            disabled={busy !== null}
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md bg-accent px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-50"
          >
            <Upload size={13} />
            {t('renderer.lens.install_file')}
          </button>
        </div>

        {packageError && (
          <div role="alert" className="rounded-md border border-soft-red/30 bg-soft-red/10 px-2.5 py-2 text-xs text-soft-red">
            {packageError}
          </div>
        )}
        {packageErrors > 0 && (
          <div role="status" className="rounded-md border border-soft-amber/30 bg-soft-amber/10 px-2.5 py-2 text-xs text-soft-amber">
            {t('renderer.lens.invalid_packages', { n: packageErrors })}
          </div>
        )}

        {preview && (
          <div className="rounded-lg border border-accent/40 bg-accent/5 p-3">
            <div className="flex items-center gap-2">
              <PackageTypeIcon type={preview.manifest.type} />
              <span className="text-xs font-semibold text-primary">{t('renderer.lens.preview_title')}</span>
              <span className="text-[10px] text-muted">{preview.manifest.type}</span>
            </div>
            <div className="mt-2 text-sm font-medium text-primary">{preview.manifest.name[displayLocale]}</div>
            <div className="mt-0.5 text-[11px] text-muted">
              {preview.manifest.author} · v{preview.manifest.version} · SHA-256 {preview.digest.slice(0, 12)}…
            </div>
            {preview.manifest.type === 'theme' && (
              <div className="mt-2 flex gap-1.5">
                {Object.values((preview.declaration as SwobLensThemeDeclaration).tokens).slice(0, 8).map((color) => (
                  <span key={color} className="h-5 w-5 rounded border border-edge" style={{ backgroundColor: color }} />
                ))}
              </div>
            )}
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" onClick={() => setPreview(null)} className="rounded px-2 py-1 text-xs text-secondary hover:bg-hover">
                {t('renderer.lens.cancel')}
              </button>
              <button
                type="button"
                onClick={() => void installPreview()}
                disabled={busy !== null}
                className="rounded bg-accent px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50"
              >
                {t('renderer.lens.install')}
              </button>
            </div>
          </div>
        )}

        {packages.length === 0 ? (
          <p className="py-2 text-center text-xs text-muted">{t('renderer.lens.no_packages')}</p>
        ) : (
          <div className="space-y-2">
            {packages.map((installed) => (
              <div key={installed.manifest.id} className="flex items-center gap-3 rounded-md border border-edge/70 bg-base/40 px-2.5 py-2">
                <span className="text-accent"><PackageTypeIcon type={installed.manifest.type} /></span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-primary">{installed.manifest.name[displayLocale]}</div>
                  <div className="text-[10px] text-muted">{installed.manifest.type} · v{installed.manifest.version}</div>
                </div>
                <button
                  type="button"
                  onClick={() => void togglePackage(installed)}
                  disabled={busy !== null}
                  className="rounded px-2 py-1 text-[11px] text-secondary hover:bg-hover disabled:opacity-50"
                >
                  {t(installed.enabled ? 'renderer.lens.disable' : 'renderer.lens.enable')}
                </button>
                <button
                  type="button"
                  onClick={() => void uninstallPackage(installed)}
                  disabled={busy !== null}
                  aria-label={t('renderer.lens.uninstall')}
                  className="rounded p-1 text-muted hover:bg-soft-red/10 hover:text-soft-red disabled:opacity-50"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Marketplace teaser */}
      <div className="text-center py-4 border border-dashed border-edge rounded-lg">
        <p className="text-xs text-muted">{t('renderer.lens.marketplace_teaser')}</p>
      </div>
    </div>
  )
}
