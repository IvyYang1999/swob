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
  label?: string
  labelKey?: string
  support: 'stable' | 'experimental' | 'unsupported'
  reasonCode?: string
  /** Dynamic reason injected from the Provider capability registry; overrides reasonCode when present. */
  reason?: string
}

export interface HarnessCapability {
  id: string
  name: string
  sourceIds: string[]
  choices: ResumeChoice[]
  defaultMethod: ResumeMethod
}

const terminal = (): ResumeChoice => ({
  id: 'terminal', labelKey: 'settings_capability.terminal', support: 'stable'
})
const experimentalTerminal = (reasonCode: string): ResumeChoice => ({
  id: 'terminal', labelKey: 'settings_capability.terminal', support: 'experimental', reasonCode
})
const unsupported = (id: ResumeMethod, label: string, reasonCode: string): ResumeChoice => ({
  id, label, support: 'unsupported', reasonCode
})

const BASE_HARNESS_CAPABILITIES: HarnessCapability[] = [
  {
    id: 'claude-code', name: 'Claude Code', sourceIds: ['claude-code'], defaultMethod: 'terminal',
    choices: [
      terminal(),
      { id: 'claude-desktop', label: 'Claude Desktop', support: 'experimental', reasonCode: 'settings_capability.claude_desktop_warning' },
      { id: 'remote-control', label: 'Remote Control', support: 'stable' }
    ]
  },
  {
    id: 'cc-mirror', name: 'CC-Mirror', sourceIds: ['cc-mirror'], defaultMethod: 'terminal',
    choices: [terminal(), unsupported('claude-desktop', 'Claude Desktop', 'settings_capability.no_mirror_desktop_entry')]
  },
  {
    id: 'codex', name: 'Codex', sourceIds: ['codex'], defaultMethod: 'codex-desktop',
    choices: [terminal(), { id: 'codex-desktop', label: 'Codex App', support: 'stable' }]
  },
  {
    id: 'cursor', name: 'Cursor Agent', sourceIds: ['cursor'], defaultMethod: 'terminal',
    choices: [terminal(), unsupported('codex-desktop', 'Cursor App', 'settings_capability.no_session_deep_link')]
  },
  {
    id: 'opencode', name: 'OpenCode', sourceIds: ['opencode'], defaultMethod: 'terminal',
    choices: [terminal(), unsupported('codex-desktop', 'OpenCode Desktop', 'settings_capability.no_session_deep_link')]
  },
  {
    id: 'zcode', name: 'ZCode', sourceIds: ['zcode'], defaultMethod: 'zcode-desktop',
    choices: [
      { ...terminal(), support: 'unsupported', reasonCode: 'settings_capability.no_public_cli_resume' },
      { id: 'zcode-desktop', label: 'ZCode App', support: 'experimental', reasonCode: 'settings_capability.workspace_only' }
    ]
  },
  {
    id: 'antigravity', name: 'Antigravity', sourceIds: ['antigravity'], defaultMethod: 'terminal',
    choices: [experimentalTerminal('settings_capability.unaudited_resume_mapping'), unsupported('codex-desktop', 'Antigravity App', 'settings_capability.no_session_deep_link')]
  },
  { id: 'grok', name: 'Grok Build', sourceIds: ['grok'], defaultMethod: 'terminal', choices: [experimentalTerminal('settings_capability.unaudited_resume_mapping')] },
  { id: 'hermes', name: 'Hermes', sourceIds: ['hermes'], defaultMethod: 'terminal', choices: [experimentalTerminal('settings_capability.unaudited_resume_mapping')] },
  { id: 'pi', name: 'Pi', sourceIds: ['pi'], defaultMethod: 'terminal', choices: [experimentalTerminal('settings_capability.unaudited_resume_mapping')] },
  { id: 'kimi', name: 'Kimi Code', sourceIds: ['kimi'], defaultMethod: 'terminal', choices: [experimentalTerminal('settings_capability.unaudited_resume_mapping')] },
  { id: 'qoder', name: 'Qoder', sourceIds: ['qoder'], defaultMethod: 'terminal', choices: [experimentalTerminal('settings_capability.unaudited_resume_mapping')] },
  {
    id: 'trae', name: 'Trae', sourceIds: ['trae'], defaultMethod: 'terminal',
    choices: [unsupported('terminal', 'Terminal', 'settings_capability.no_public_cli_resume')]
  }
]

function choiceCapability(choice: ResumeChoice): 'terminal-resume' | 'native-resume' | null {
  if (choice.id === 'terminal') return 'terminal-resume'
  if (choice.id === 'remote-control') return null
  return 'native-resume'
}

function resumeSupport(declaration: CapabilityDeclaration): ResumeChoice['support'] {
  if (declaration.status === 'available') return 'stable'
  if (declaration.status === 'experimental') return 'experimental'
  return 'unsupported'
}

function synchronizeHarnessResumeTruth(harness: HarnessCapability): HarnessCapability {
  const source = harness.sourceIds[0]
  const capabilities = providerCapabilitiesForSource(source)
  if (!capabilities) return harness
  return {
    ...harness,
    choices: harness.choices.map((choice) => {
      const capability = choiceCapability(choice)
      if (!capability) return choice
      const declaration = capabilities[capability]
      return {
        ...choice,
        support: resumeSupport(declaration),
        ...(declaration.reason ? { reason: declaration.reason } : { reason: undefined })
      }
    })
  }
}

/** Resume surfaces are labels only; support status/reason come from the Provider registry. */
export const HARNESS_CAPABILITIES: HarnessCapability[] =
  BASE_HARNESS_CAPABILITIES.map(synchronizeHarnessResumeTruth)

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
import { providerCapabilitiesForSource } from './provider-capabilities'
import type { CapabilityDeclaration } from './provider-schema.generated'
