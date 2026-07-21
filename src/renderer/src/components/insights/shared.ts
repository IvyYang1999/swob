export function formatTokenCount(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

export function formatDuration(ms: number): string {
  if (ms === 0) return '0m'
  const hours = Math.floor(ms / 3_600_000)
  const minutes = Math.floor((ms % 3_600_000) / 60_000)
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

export const SOURCE_COLORS: Record<string, string> = {
  'claude-code': '#f59e0b',
  codex: '#3b82f6',
  cursor: '#a1a1aa',
  opencode: '#10b981',
  zcode: '#10b981',
  'cc-mirror': '#f472b6',
  antigravity: '#a78bfa',
  grok: '#6b7280',
  pi: '#14b8a6',
  kimi: '#fb923c',
  hermes: '#8b5cf6',
}

export const PROJECT_COLORS = [
  '#8b5cf6', '#3b82f6', '#10b981', '#f59e0b', '#ef4444',
  '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#6366f1',
]

export interface ByModel {
  model: string
  totalTokens: number
  sessionCount: number
}

export interface InsightsData {
  totalTokens: number
  conversationOnlyTokens: number
  totalInputTokens: number
  totalOutputTokens: number
  totalSessions: number
  tokenAvailableSessions: number
  tokenUnavailableSessions: number
  totalTurns: number
  totalTime: number
  activeDays: number
  bySource: BySource[]
  byModel: ByModel[]
  byProject: ByProject[]
  byFolder: ByFolder[]
  byDate: ByDate[]
  heatmap: HeatmapCell[]
  // New dimensions
  totalCacheReadTokens: number
  totalCacheCreationTokens: number
  estimatedCostUsd: number
  hourlyDistribution: number[]     // 24 items, index = hour
  turnCountDistribution: number[]  // [1-5, 6-20, 21-50, 51-100, 101-500, 500+]
  topTools: Array<{ name: string; count: number }>
  codeChanges: { filesRead: number; filesWritten: number; filesEdited: number }
  bySession: Array<{
    sessionId: string
    projectPath: string
    source: string
    totalTokens: number | null
    conversationOnlyTokens: number | null
    provenance: string
  }>
  reconciliation: { global: number; projects: number; sessions: number; difference: number; ok: boolean }
}

export interface BySource {
  source: string
  label: string
  totalTokens: number
  inputTokens: number
  outputTokens: number
  sessionCount: number
  turnCount: number
  tokenAvailableSessions: number
  tokenUnavailableSessions: number
  tokenDataStatus: 'available' | 'partial' | 'unavailable' | 'no-data'
}

export interface ByProject {
  project: string
  fullPath: string
  totalTokens: number
  inputTokens: number
  outputTokens: number
  sessionCount: number
  turnCount: number
  sources: string[]
  tokenAvailableSessions: number
  tokenUnavailableSessions: number
}

export interface ByFolder {
  folderId: string
  folderName: string
  totalTokens: number
  inputTokens: number
  outputTokens: number
  sessionCount: number
  turnCount: number
  tokenAvailableSessions: number
  tokenUnavailableSessions: number
}

export interface ByDate {
  date: string
  totalTokens: number
  inputTokens: number
  outputTokens: number
  sessionCount: number
  turnCount: number
  bySource: Record<string, number>
  byProject: Record<string, number>
  totalTime: number
  byProjectTime: Record<string, number>
}

export interface HeatmapCell {
  date: string
  value: number
  level: 0 | 1 | 2 | 3 | 4
}
