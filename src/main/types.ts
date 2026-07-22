import type { TokenAccounting } from './token-accounting'

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
}

export type TranscriptOrigin = 'human' | 'task-notification' | 'hook' | 'command' | 'tool' | 'unknown'

export interface RawJsonlMessage {
  uuid: string
  parentUuid: string | null
  logicalParentUuid?: string | null  // used across compact boundaries
  sessionId: string
  type: 'user' | 'assistant' | 'system' | 'progress' | 'file-history-snapshot' | 'summary'
  subtype?: string
  timestamp: string
  cwd?: string
  version?: string
  slug?: string
  isSidechain?: boolean
  permissionMode?: string
  origin?: { kind?: string } | string
  promptSource?: string
  isMeta?: boolean
  sourceToolAssistantUUID?: string
  requestId?: string
  provider?: string
  providerId?: string
  model_provider?: string
  costUSD?: number
  cost?: { total?: number }
  toolUseResult?: unknown
  message?: {
    id?: string
    role: string
    model?: string
    provider?: string
    providerId?: string
    provider_id?: string
    model_provider?: string
    costUSD?: number
    cost?: { total?: number }
    service_tier?: string
    inference_geo?: string
    region?: string
    speed?: string
    is_batch?: boolean
    stop_reason?: string | null
    content: string | ContentPart[]
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
      cache_creation?: {
        ephemeral_5m_input_tokens?: number
        ephemeral_1h_input_tokens?: number
      }
      costUSD?: number
      cost?: { total?: number }
      service_tier?: string
    }
  }
  data?: unknown
  forkedFrom?: { sessionId: string; messageUuid: string }
  /** Claude continuation summary: the UUID at which the previous session ended. */
  leafUuid?: string
}

export interface ContentPart {
  type: string
  text?: string
  name?: string
  id?: string // tool_use id
  input?: Record<string, unknown>
  tool_use_id?: string // for tool_result, links to tool_use
  content?: string | ContentPart[]
  source?: { type: string; media_type?: string; data?: string; url?: string }
}

export interface ParsedMessage {
  uuid: string
  type: 'user' | 'assistant' | 'system' | 'progress'
  subtype?: string
  timestamp: string
  role?: string
  origin: TranscriptOrigin
  textContent: string
  toolCalls: ToolCallInfo[]
  images: string[] // data URLs for pasted/inline images
  tokenUsage?: TokenUsage // API-reported token usage (assistant messages only)
  isPreCompact: boolean
  isSidechain: boolean
  isSharedContext: boolean
  isSystemGenerated: boolean  // type:"user" but not real user input (tool_result, Tool loaded, etc.)
  raw: RawJsonlMessage
}

export interface ToolCallInfo {
  id?: string
  name: string
  input: Record<string, unknown>
  result?: string
}

export interface SkillInvocation {
  skillName: string
  timestamp: string
  args?: string
}

export type SessionSource = 'claude-code' | 'codex' | 'cursor' | 'opencode' | 'zcode' | 'cc-mirror' | 'antigravity' | 'grok' | 'pi' | 'kimi' | 'hermes'

export interface SessionSummary {
  id: string
  sessionId: string
  resumeSessionId?: string
  slug: string
  createdAt: string
  updatedAt: string
  messageCount: number
  turnCount: number
  compactCount: number
  cwds: string[]
  version: string
  firstUserMessage: string
  toolUsage: Record<string, number>
  skillInvocations: SkillInvocation[]
  claudeMdContent?: string
  projectPath: string
  filePath: string
  fileSizeBytes: number
  allFilePaths?: string[]
  permissionMode?: string
  resumeCwd?: string
  branchParentFilePaths?: string[]
  branchPointUuid?: string
  branchLeafUuid?: string // for intra-file branches: trace this leaf's parentUuid chain
  branchParentId?: string // ID of the parent branch/session this was forked from
  branchChildIds?: string[] // IDs of child branches forked from this session
  continuationSessionIds?: string[] // physical sessionIds merged into this logical session
  userImages: string[]
  pastedImageCount: number // count of base64 pasted images (not stored as data URLs in summary)
  tokenUsage: TokenUsage
  /** Provider-aware, deduplicated ledger. tokenUsage remains a compatibility view. */
  tokenAccounting?: TokenAccounting
  referencedFiles: FileRef[]
  configFiles: string[]
  libraryDirPath?: string
  libraryMdPath?: string
  canResume?: boolean
  resumeUnavailableReason?: string
  isRemote?: boolean
  remoteHost?: string  // hostname of the device that created this session (e.g. "macbooka.local")
  source?: SessionSource
  claudeConfigDir?: string // non-default Claude config dir, e.g. ~/.claude-window/<id>
  allUserMessages?: string
  estimatedTime?: number  // 预估活跃时间（毫秒），相邻消息间隔累加，30min 截断
  models?: string[]  // 该 session 使用的模型列表（去重）
}

export interface FileRef {
  path: string
  actions: FileAction[]
  exists: boolean
}

export type FileAction = 'read' | 'write' | 'edit' | 'user-image' | 'user-input'

export interface SessionDetail extends SessionSummary {
  messages: ParsedMessage[]
}

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
    locale?: 'zh-CN' | 'en' | 'ja'
    themeMode?: ThemeMode
    spotlightShortcut?: string
    sshConfig?: SshConfig
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
  }
}
