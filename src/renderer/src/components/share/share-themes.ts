/**
 * Three scoped CSS-variable themes for the share image renderer.
 * Each theme defines colors used within the rendered share card.
 * No arbitrary CSS injection — only these named variables.
 */

export interface ShareTheme {
  id: 'light' | 'dark' | 'minimal'
  label: string
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

export const SHARE_THEMES: readonly ShareTheme[] = [
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

export function getThemeById(id: string): ShareTheme {
  return SHARE_THEMES.find((t) => t.id === id) ?? SHARE_THEMES[0]
}
