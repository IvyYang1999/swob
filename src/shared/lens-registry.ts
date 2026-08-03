/**
 * Lens Contribution API — tF30
 *
 * Makes first-party features declaratively toggleable as "Lens" plugins.
 * All Lenses are built-in; third-party plugin loading is NOT in scope
 * (SWOB_PLUGIN_EXECUTION_ENABLED stays false).
 *
 * Theme preview is handled by tF22 (separate worktree).
 */

import type { SwobLensPresetDeclaration } from './swoblens-manifest'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SceneTag = 'knowledge' | 'developer' | 'team'

export interface LensContribution {
  readonly id: string
  readonly name: { readonly 'zh-CN': string; readonly en: string }
  readonly icon: string // lucide icon name
  readonly description: { readonly 'zh-CN': string; readonly en: string }
  readonly sceneTags: readonly SceneTag[]
  readonly contributions: {
    readonly sidebarSection?: string
    readonly inspectorTab?: string
    readonly insightsCard?: readonly string[]
    readonly shareTemplate?: string
    readonly galaxyView?: boolean
  }
  readonly builtIn: true
}

// ---------------------------------------------------------------------------
// Built-in Lens declarations
// ---------------------------------------------------------------------------

export const BUILTIN_LENSES: readonly LensContribution[] = [
  {
    id: 'highlights',
    name: { 'zh-CN': '金句划线', en: 'Highlights' },
    icon: 'Highlighter',
    description: {
      'zh-CN': '在会话中划线收藏重要句段',
      en: 'Highlight and save important passages in sessions'
    },
    sceneTags: ['knowledge'],
    contributions: { inspectorTab: 'highlights' },
    builtIn: true
  },
  {
    id: 'image-index',
    name: { 'zh-CN': '图片索引', en: 'Image Index' },
    icon: 'Image',
    description: {
      'zh-CN': '浏览会话中上传的所有图片',
      en: 'Browse all images uploaded in sessions'
    },
    sceneTags: ['knowledge'],
    contributions: { inspectorTab: 'images' },
    builtIn: true
  },
  {
    id: 'outputs',
    name: { 'zh-CN': 'Output 列表', en: 'Outputs' },
    icon: 'FileOutput',
    description: {
      'zh-CN': '查看会话产出的文件和操作记录',
      en: 'View files produced and operations in sessions'
    },
    sceneTags: ['developer'],
    contributions: { inspectorTab: 'outputs' },
    builtIn: true
  },
  {
    id: 'token-insights',
    name: { 'zh-CN': 'Token 洞察', en: 'Token Insights' },
    icon: 'BarChart3',
    description: {
      'zh-CN': '按来源、模型、项目分析 Token 用量与成本',
      en: 'Analyze token usage and cost by source, model, and project'
    },
    sceneTags: ['developer'],
    contributions: { insightsCard: ['overview', 'cost', 'sessions', 'workflow', 'quality'] },
    builtIn: true
  },
  {
    id: 'galaxy',
    name: { 'zh-CN': '会话图谱', en: 'Session Galaxy' },
    icon: 'GitBranch',
    description: {
      'zh-CN': '以星图方式可视化所有会话关系',
      en: 'Visualize all session relationships as a galaxy graph'
    },
    sceneTags: ['developer'],
    contributions: { galaxyView: true },
    builtIn: true
  },
  {
    id: 'audit',
    name: { 'zh-CN': '审计报告', en: 'Audit Report' },
    icon: 'ShieldCheck',
    description: {
      'zh-CN': '跨会话质量审计、健康度与反模式检测',
      en: 'Cross-session quality audit, health scores, and anti-pattern detection'
    },
    sceneTags: ['developer'],
    contributions: { inspectorTab: 'audit' },
    builtIn: true
  },
  {
    id: 'share-templates',
    name: { 'zh-CN': '分享图模板', en: 'Share Templates' },
    icon: 'Share2',
    description: {
      'zh-CN': '将会话片段生成精美分享图',
      en: 'Generate styled share images from session excerpts'
    },
    sceneTags: ['knowledge', 'developer'],
    contributions: { shareTemplate: 'default' },
    builtIn: true
  }
] as const

// ---------------------------------------------------------------------------
// Preference-aware helpers
// ---------------------------------------------------------------------------

interface LensPreferences {
  enabledLenses?: string[] | null
  lensOrder?: string[] | null
}

/**
 * Returns all Lenses the user has enabled, in their preferred order.
 * When `enabledLenses` is null/undefined, ALL built-in lenses are enabled
 * (backwards-compatible default).
 */
export function getEnabledLenses(preferences: LensPreferences): readonly LensContribution[] {
  const { enabledLenses, lensOrder } = preferences

  // Filter by enabled
  const enabled = enabledLenses == null
    ? [...BUILTIN_LENSES]
    : BUILTIN_LENSES.filter((lens) => enabledLenses.includes(lens.id))

  // Apply custom order if present
  if (lensOrder && lensOrder.length > 0) {
    const orderMap = new Map(lensOrder.map((id, index) => [id, index]))
    return [...enabled].sort((a, b) => {
      const oa = orderMap.get(a.id) ?? Infinity
      const ob = orderMap.get(b.id) ?? Infinity
      return oa - ob
    })
  }

  return enabled
}

/**
 * Check whether a specific Lens is currently enabled.
 */
export function isLensEnabled(lensId: string, preferences: LensPreferences): boolean {
  const { enabledLenses } = preferences
  // null/undefined = all enabled
  if (enabledLenses == null) return true
  return enabledLenses.includes(lensId)
}

/**
 * Returns the list of Lens IDs for a given scene preset.
 */
export function lensIdsForScene(scene: 'knowledge' | 'developer' | 'both'): string[] {
  if (scene === 'both') return BUILTIN_LENSES.map((l) => l.id)
  const tags: SceneTag[] = scene === 'knowledge'
    ? ['knowledge']
    : ['developer']
  return BUILTIN_LENSES
    .filter((l) => l.sceneTags.some((t) => tags.includes(t)))
    .map((l) => l.id)
}

/** Convert a main-process-validated declarative preset into persisted Lens preferences. */
export function preferencesForLensPreset(
  preset: SwobLensPresetDeclaration
): { enabledLenses: string[]; lensOrder: string[] } {
  const known = new Set(BUILTIN_LENSES.map((lens) => lens.id))
  return {
    enabledLenses: preset.enabledLenses.filter((id) => known.has(id)),
    lensOrder: preset.order.filter((id) => known.has(id))
  }
}
