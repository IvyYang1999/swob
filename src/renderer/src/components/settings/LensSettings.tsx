/**
 * tF30: Lens management settings page.
 *
 * Displays all built-in Lenses as toggleable cards with scene badges,
 * up/down reorder buttons, and a marketplace teaser.
 */
import { useCallback } from 'react'
import {
  Highlighter, Image, FileOutput, BarChart3, GitBranch, ShieldCheck, Share2,
  ChevronUp, ChevronDown
} from 'lucide-react'
import { useStore } from '../../store'
import { useT } from '../../i18n'
import { BUILTIN_LENSES, type LensContribution, type SceneTag } from '../../../../shared/lens-registry'

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
            onClick={onMoveUp}
            disabled={isFirst}
            className="p-0.5 rounded hover:bg-hover text-muted hover:text-primary disabled:opacity-30 disabled:cursor-not-allowed"
            aria-label="Move up"
          >
            <ChevronUp size={12} />
          </button>
          <button
            onClick={onMoveDown}
            disabled={isLast}
            className="p-0.5 rounded hover:bg-hover text-muted hover:text-primary disabled:opacity-30 disabled:cursor-not-allowed"
            aria-label="Move down"
          >
            <ChevronDown size={12} />
          </button>
        </div>

        {/* Toggle switch */}
        <button
          role="switch"
          aria-checked={enabled}
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

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function LensSettings() {
  const t = useT()
  const locale = useStore((state) => state.locale)
  const config = useStore((state) => state.config)
  const toggleLens = useStore((state) => state.toggleLens)
  const reorderLenses = useStore((state) => state.reorderLenses)

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

      {/* Marketplace teaser */}
      <div className="text-center py-4 border border-dashed border-edge rounded-lg">
        <p className="text-xs text-muted">{t('renderer.lens.marketplace_teaser')}</p>
      </div>
    </div>
  )
}
