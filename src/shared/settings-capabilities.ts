export type SettingsLocale = import('./i18n').Locale
export type DefaultSort = 'updated' | 'created' | 'turns' | 'name'
export type DefaultGrouping = 'none' | 'project' | 'date' | 'harness'
export type SingleTurnBehavior = 'show' | 'hide' | 'collapse'
export type UpdateChannel = 'stable' | 'development'
export type ResumeMethod =
  | 'terminal'
  | 'codex-desktop'
  | 'claude-desktop'
  | 'zcode-desktop'
  | 'remote-control'

export interface ResumeChoice {
  id: ResumeMethod
  label: string
  support: 'stable' | 'experimental' | 'unsupported'
  reason?: string
}

export interface HarnessCapability {
  id: string
  name: string
  sourceIds: string[]
  choices: ResumeChoice[]
  defaultMethod: ResumeMethod
}

const terminal = (label = '终端'): ResumeChoice => ({ id: 'terminal', label, support: 'stable' })
const unsupported = (id: ResumeMethod, label: string, reason: string): ResumeChoice => ({
  id, label, support: 'unsupported', reason
})

export const HARNESS_CAPABILITIES: HarnessCapability[] = [
  {
    id: 'claude-code', name: 'Claude Code', sourceIds: ['claude-code', 'cc-mirror'], defaultMethod: 'terminal',
    choices: [
      terminal(),
      { id: 'claude-desktop', label: 'Claude Desktop', support: 'experimental', reason: '需开启实验导入；可能改写 transcript' },
      { id: 'remote-control', label: 'Remote Control', support: 'stable' }
    ]
  },
  {
    id: 'codex', name: 'Codex', sourceIds: ['codex'], defaultMethod: 'codex-desktop',
    choices: [terminal(), { id: 'codex-desktop', label: 'Codex App', support: 'stable' }]
  },
  {
    id: 'cursor', name: 'Cursor Agent', sourceIds: ['cursor'], defaultMethod: 'terminal',
    choices: [terminal(), unsupported('codex-desktop', 'Cursor App', '官方未提供按会话直达')]
  },
  {
    id: 'opencode', name: 'OpenCode', sourceIds: ['opencode'], defaultMethod: 'terminal',
    choices: [terminal(), unsupported('codex-desktop', 'OpenCode Desktop', '官方未提供按会话直达')]
  },
  {
    id: 'zcode', name: 'ZCode', sourceIds: ['zcode'], defaultMethod: 'zcode-desktop',
    choices: [
      unsupported('terminal', '终端', '没有公开 CLI Resume'),
      { id: 'zcode-desktop', label: 'ZCode App', support: 'stable', reason: '仅打开工作区，不保证恢复指定会话' }
    ]
  },
  {
    id: 'antigravity', name: 'Antigravity', sourceIds: ['antigravity'], defaultMethod: 'terminal',
    choices: [terminal(), unsupported('codex-desktop', 'Antigravity App', '官方未提供按会话直达')]
  },
  { id: 'grok', name: 'Grok Build', sourceIds: ['grok'], defaultMethod: 'terminal', choices: [terminal()] },
  { id: 'hermes', name: 'Hermes', sourceIds: ['hermes'], defaultMethod: 'terminal', choices: [terminal()] },
  { id: 'pi', name: 'Pi', sourceIds: ['pi'], defaultMethod: 'terminal', choices: [terminal()] },
  { id: 'kimi', name: 'Kimi Code', sourceIds: ['kimi'], defaultMethod: 'terminal', choices: [terminal()] }
]

export interface MigratedSettingsPreferences extends Record<string, unknown> {
  settingsSchemaVersion: 1
  defaultTerminalId: string
  resumeMethodByHarness: Record<string, ResumeMethod>
  defaultSort: DefaultSort
  defaultGrouping: DefaultGrouping
  singleTurnBehavior: SingleTurnBehavior
  autoCheckUpdates: boolean
  updateChannel: UpdateChannel
}

function migratedTerminalId(preferences: Record<string, unknown>): string {
  if (typeof preferences.defaultTerminalId === 'string' && preferences.defaultTerminalId.trim()) {
    return preferences.defaultTerminalId
  }
  const legacy = preferences.resumeTerminal || preferences.terminalApp
  if (legacy === 'iterm' || legacy === 'iTerm' || legacy === 'iTerm2') return 'iterm2'
  if (legacy === 'custom') return 'custom'
  return 'apple-terminal'
}

function resumeDefaults(value: unknown): Record<string, ResumeMethod> {
  const result: Record<string, ResumeMethod> = {}
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, method] of Object.entries(value)) {
      if (['terminal', 'codex-desktop', 'claude-desktop', 'zcode-desktop', 'remote-control'].includes(String(method))) {
        result[key] = method as ResumeMethod
      }
    }
  }
  for (const harness of HARNESS_CAPABILITIES) {
    if (!result[harness.id]) result[harness.id] = harness.defaultMethod
  }
  return result
}

export function migrateSettingsPreferences(input?: Record<string, unknown> | null): MigratedSettingsPreferences {
  const preferences = { ...(input || {}) }
  return {
    ...preferences,
    settingsSchemaVersion: 1,
    defaultTerminalId: migratedTerminalId(preferences),
    resumeMethodByHarness: resumeDefaults(preferences.resumeMethodByHarness),
    defaultSort: ['updated', 'created', 'turns', 'name'].includes(String(preferences.defaultSort))
      ? preferences.defaultSort as DefaultSort : 'updated',
    defaultGrouping: ['none', 'project', 'date', 'harness'].includes(String(preferences.defaultGrouping))
      ? preferences.defaultGrouping as DefaultGrouping : 'none',
    singleTurnBehavior: ['show', 'hide', 'collapse'].includes(String(preferences.singleTurnBehavior))
      ? preferences.singleTurnBehavior as SingleTurnBehavior : 'collapse',
    autoCheckUpdates: preferences.autoCheckUpdates !== false,
    updateChannel: preferences.updateChannel === 'development' ? 'development' : 'stable'
  }
}

export function harnessForSource(source?: string): HarnessCapability {
  return HARNESS_CAPABILITIES.find((item) => item.sourceIds.includes(source || 'claude-code')) || HARNESS_CAPABILITIES[0]
}

export function enabledResumeChoices(
  harness: HarnessCapability,
  experimentalClaudeDesktopImport: boolean
): ResumeChoice[] {
  return harness.choices.filter((choice) =>
    choice.support === 'stable' || (choice.id === 'claude-desktop' && experimentalClaudeDesktopImport)
  )
}

export function defaultResumeMethodForSource(
  preferences: Record<string, unknown> | null | undefined,
  source?: string
): ResumeMethod {
  const harness = harnessForSource(source)
  const migrated = migrateSettingsPreferences(preferences)
  const requested = migrated.resumeMethodByHarness[harness.id] || harness.defaultMethod
  const enabled = enabledResumeChoices(harness, migrated.experimentalClaudeDesktopImport === true)
  return enabled.some((choice) => choice.id === requested) ? requested : harness.defaultMethod
}
