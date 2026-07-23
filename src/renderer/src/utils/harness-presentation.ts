/**
 * HarnessPresentationRegistry
 *
 * Single source of truth for how each AI harness/source is displayed
 * throughout the app: name, icon, and color.
 *
 */

import claudeIcon from '../assets/icons/claude-neutral.svg'
import openaiIcon from '../assets/icons/openai-neutral.svg'
import cursorIcon from '../assets/icons/cursor-neutral.svg'

export interface HarnessPresentation {
  /** Human-readable label shown in UI */
  displayName: string
  /** Short 1-2 char abbreviation for compact badges */
  shortLabel: string
  /** Bundled image path, or null for text-based avatars */
  iconImage: string | null
  /** Tailwind bg/text classes for text-based badges (when iconImage is null) */
  badgeClass: string
  /** Hex color for charts / insights (matches SOURCE_COLORS in shared.ts) */
  chartColor: string
}

const REGISTRY: Record<string, HarnessPresentation> = {
  'claude-code': {
    displayName: 'Claude Code',
    shortLabel: 'CC',
    iconImage: claudeIcon,
    badgeClass: 'bg-[#c88450]/15 text-[#c88450]',
    chartColor: '#f59e0b',
  },
  codex: {
    displayName: 'Codex',
    shortLabel: 'CDX',
    iconImage: openaiIcon,
    badgeClass: 'bg-[#5a9fd4]/15 text-[#5a9fd4]',
    chartColor: '#3b82f6',
  },
  cursor: {
    displayName: 'Cursor',
    shortLabel: 'CUR',
    iconImage: cursorIcon,
    badgeClass: 'bg-[#a1a1aa]/15 text-[#a1a1aa]',
    chartColor: '#a1a1aa',
  },
  opencode: {
    displayName: 'OpenCode',
    shortLabel: 'OC',
    iconImage: null,
    badgeClass: 'bg-soft-emerald/15 text-soft-emerald',
    chartColor: '#10b981',
  },
  zcode: {
    displayName: 'ZCode',
    shortLabel: 'ZC',
    iconImage: null,
    badgeClass: 'bg-soft-cyan/15 text-soft-cyan',
    chartColor: '#10b981',
  },
  'cc-mirror': {
    displayName: 'CC Mirror',
    shortLabel: 'CM',
    iconImage: null,
    badgeClass: 'bg-soft-pink/15 text-soft-pink',
    chartColor: '#f472b6',
  },
  antigravity: {
    displayName: 'Antigravity',
    shortLabel: 'AG',
    iconImage: null,
    badgeClass: 'bg-soft-purple/15 text-soft-purple',
    chartColor: '#a78bfa',
  },
  grok: {
    displayName: 'Grok',
    shortLabel: 'GR',
    iconImage: null,
    badgeClass: 'bg-soft-blue/15 text-soft-blue',
    chartColor: '#6b7280',
  },
  pi: {
    displayName: 'Pi',
    shortLabel: 'PI',
    iconImage: null,
    badgeClass: 'bg-soft-pink/15 text-soft-pink',
    chartColor: '#14b8a6',
  },
  kimi: {
    displayName: 'Kimi',
    shortLabel: 'KM',
    iconImage: null,
    badgeClass: 'bg-soft-orange/15 text-soft-orange',
    chartColor: '#fb923c',
  },
  hermes: {
    displayName: 'Hermes',
    shortLabel: 'HM',
    iconImage: null,
    badgeClass: 'bg-soft-amber/15 text-soft-amber',
    chartColor: '#8b5cf6',
  },
}

const FALLBACK: HarnessPresentation = {
  displayName: 'AI Assistant',
  shortLabel: 'AI',
  iconImage: claudeIcon,
  badgeClass: 'bg-surface text-secondary',
  chartColor: '#71717a',
}

const iconOverrides: Record<string, string> = {}
export const HARNESS_PRESENTATION_CHANGED_EVENT = 'swob:harnessPresentationChanged'

export function replaceHarnessIconOverrides(next: Record<string, string>): void {
  for (const source of Object.keys(iconOverrides)) delete iconOverrides[source]
  Object.assign(iconOverrides, next)
  window.dispatchEvent(new Event(HARNESS_PRESENTATION_CHANGED_EVENT))
}

export async function refreshHarnessIconOverrides(
  api: Pick<Window['api'], 'profileGetHarnessIconOverrides' | 'libraryGetRoot' | 'loadImage'> = window.api
): Promise<void> {
  const result = await api.profileGetHarnessIconOverrides()
  if (!result.ok) return
  const root = await api.libraryGetRoot()
  if (!root) return
  const loaded: Record<string, string> = {}
  await Promise.all(result.value.map(async (override) => {
    if (!override.iconAvailable || !override.iconRelPath) return
    try {
      const image = await api.loadImage(`${root}/${override.iconRelPath}`)
      if (image?.dataUrl) loaded[override.source] = image.dataUrl
    } catch { /* a missing/corrupt override falls back to the bundled glyph */ }
  }))
  replaceHarnessIconOverrides(loaded)
}

/**
 * Look up presentation metadata for a source/harness client ID.
 * Unknown IDs get a safe fallback.
 */
export function getHarnessPresentation(source: string | undefined): HarnessPresentation {
  const key = source || 'claude-code'
  const presentation = REGISTRY[key] ?? FALLBACK
  const iconImage = iconOverrides[key]
  return iconImage ? { ...presentation, iconImage } : presentation
}

/**
 * Return all registered source IDs (useful for settings / dropdowns).
 */
export function getRegisteredSources(): string[] {
  return Object.keys(REGISTRY)
}
