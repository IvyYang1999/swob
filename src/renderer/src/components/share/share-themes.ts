/**
 * Three scoped CSS-variable themes for the share image renderer.
 * Each theme defines colors used within the rendered share card.
 * No arbitrary CSS injection — only these named variables.
 */

import type { InstalledSwobLensPackage, SwobLensShareTemplateDeclaration } from '../../../../shared/swoblens-manifest'

export interface ShareTheme {
  id: string
  label: string
  layout?: SwobLensShareTemplateDeclaration['layout']
  watermark?: string
  vars: {
    bg: string
    cardBg: string
    text: string
    textSecondary: string
    textMuted: string
    userAccent: string
    assistantAccent: string
    border: string
    watermark: string
    roleBg: string
  }
}

const BUILTIN_SHARE_THEMES: readonly ShareTheme[] = [
  {
    id: 'light',
    label: 'Light',
    vars: {
      bg: '#ffffff',
      cardBg: '#f8f9fa',
      text: '#1a1a2e',
      textSecondary: '#4a4a5e',
      textMuted: '#8a8a9e',
      userAccent: '#3878a8',
      assistantAccent: '#c88450',
      border: '#e4e4e7',
      watermark: '#c0c0c8',
      roleBg: '#f0f0f4',
    },
  },
  {
    id: 'dark',
    label: 'Dark',
    vars: {
      bg: '#18181b',
      cardBg: '#27272a',
      text: '#e4e4e7',
      textSecondary: '#a1a1aa',
      textMuted: '#71717a',
      userAccent: '#5a9fd4',
      assistantAccent: '#c88450',
      border: '#3f3f46',
      watermark: '#52525b',
      roleBg: '#3f3f46',
    },
  },
  {
    id: 'minimal',
    label: 'Minimal',
    vars: {
      bg: '#ffffff',
      cardBg: '#ffffff',
      text: '#3f3f46',
      textSecondary: '#71717a',
      textMuted: '#a1a1aa',
      userAccent: '#71717a',
      assistantAccent: '#71717a',
      border: '#e8e8ec',
      watermark: '#d0d0d8',
      roleBg: '#f8f8fa',
    },
  },
] as const

export const SHARE_THEMES: ShareTheme[] = [...BUILTIN_SHARE_THEMES]

function colorReference(value: string): string {
  return `var(--color-${value})`
}

export function replaceDeclarativeShareThemes(
  packages: readonly InstalledSwobLensPackage[],
  locale: 'zh-CN' | 'en'
): void {
  const external = packages
    .filter((item): item is InstalledSwobLensPackage & { declaration: SwobLensShareTemplateDeclaration } =>
      item.enabled && item.manifest.type === 'share-template')
    .map((item): ShareTheme => ({
      id: `swoblens:${item.manifest.id}`,
      label: item.declaration.label[locale],
      layout: item.declaration.layout,
      watermark: item.declaration.watermark,
      vars: {
        bg: colorReference(item.declaration.colors.bg),
        cardBg: colorReference(item.declaration.colors.cardBg),
        text: colorReference(item.declaration.colors.text),
        textSecondary: colorReference(item.declaration.colors.textSecondary),
        textMuted: colorReference(item.declaration.colors.textMuted),
        userAccent: colorReference(item.declaration.colors.userAccent),
        assistantAccent: colorReference(item.declaration.colors.assistantAccent),
        border: colorReference(item.declaration.colors.border),
        watermark: colorReference(item.declaration.colors.textMuted),
        roleBg: colorReference(item.declaration.colors.cardBg)
      }
    }))
  SHARE_THEMES.splice(0, SHARE_THEMES.length, ...BUILTIN_SHARE_THEMES, ...external)
}

export function getThemeById(id: string): ShareTheme {
  return SHARE_THEMES.find((t) => t.id === id) ?? SHARE_THEMES[0]
}
