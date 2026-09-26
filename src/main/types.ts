export * from './session-types'

export interface Folder {
  id: string
  name: string
  parentId?: string | null
  sessionIds: string[]
  files?: VaultFile[]
  color?: string
  createdAt: string
}

export interface VaultFile {
  name: string
  path: string
}

export interface Highlight {
  id: string
  text: string
  turnUuid: string
  note?: string
  createdAt: string
}

export interface SshConfig {
  host: string          // e.g. "mac-mini.local" or "192.168.1.x"
  user: string          // SSH username
  remotePath?: string   // optional: remote path override for claude executable
}

/** A local connection route for one origin device. */
export interface SshTargetConfig extends SshConfig {
  deviceId?: string
  hostname?: string
  isDefault?: boolean
}

export type ThemeMode = 'dark' | 'light' | 'system'
export type ResumeTerminal = 'terminal-app' | 'iterm' | 'custom' | 'windows-terminal' | 'powershell' | 'cmd'

export interface UserConfig {
  folders: Folder[]
  rootFiles?: VaultFile[]
  sessionMeta: Record<string, {
    customTitle?: string
    notes?: string
    highlights?: Highlight[]
    tags?: string[]
    topic?: string
    topicConfidence?: number
  }>
  preferences: {
    defaultViewMode: 'compact' | 'full'
    terminalApp: 'Terminal' | 'iTerm2'
    resumeTerminal?: ResumeTerminal
    resumeTerminalCommandTemplate?: string
    experimentalClaudeDesktopImport?: boolean
    locale?: import('../shared/i18n').LegacyLocale
    themeMode?: ThemeMode
    colorScheme?: 'default' | 'paper' | 'nord'
    lightScheme?: 'default' | 'paper' | 'nord'
    darkScheme?: 'default' | 'paper' | 'nord'
    spotlightShortcut?: string
    sshConfig?: SshConfig
    sshTargets?: SshTargetConfig[]
    projectViewMode?: 'folders' | 'paths'
    /** T103 settings schema; legacy terminal fields remain readable. */
    settingsSchemaVersion?: 1
    defaultTerminalId?: string
    resumeMethodByHarness?: Record<string, import('../shared/settings-capabilities').ResumeMethod>
    defaultSort?: import('../shared/settings-capabilities').DefaultSort
    defaultGrouping?: import('../shared/settings-capabilities').DefaultGrouping
    singleTurnBehavior?: import('../shared/settings-capabilities').SingleTurnBehavior
    autoCheckUpdates?: boolean
    updateChannel?: import('../shared/settings-capabilities').UpdateChannel
    llmProfiles?: import('./llm-profiles').LlmProfile[]
    smartFeatureBindings?: import('./llm-profiles').SmartFeatureBinding
    agentAlwaysOnTop?: boolean
    userIdentity?: { displayName: string; avatarRelPath?: string }
    harnessIconOverrides?: Record<string, string>
    enabledLenses?: string[] | null
    lensOrder?: string[] | null
    /** t173 global migration kill switch. Defaults to unified-v2 when omitted. */
    providerAdapterMode?: 'unified-v2' | 'legacy'
    /** Per-source fail-closed fallback while other v2 adapters stay active. */
    legacyProviderSources?: import('../shared/seven-source-contract-v2').UnifiedProviderSource[]
    /** Raw health state is opt-in and never shown in the normal workspace. */
    debugMode?: boolean
  }
}
