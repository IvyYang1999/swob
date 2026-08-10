import type { TokenAccounting } from './token-accounting'
import type { LegacySessionSource } from '../shared/provider-capabilities'

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
  reason?: string
  digest?: string
  data?: unknown
  name?: string
  id?: string // tool_use id
  input?: Record<string, unknown>
  tool_use_id?: string // for tool_result, links to tool_use
  is_error?: boolean
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

/** @deprecated Closed compatibility union. New provider contracts use namespaced ProviderId strings. */
export type SessionSource = LegacySessionSource

export interface SessionSubagentSummary {
  sessionId: string
  parentSessionId?: string
  role: 'guardian' | 'thread-spawn' | 'subagent'
  filePath: string
  createdAt: string
  updatedAt: string
  agentPath?: string
  agentNickname?: string
  agentRole?: string
  model?: string
  status: 'completed' | 'unknown'
}

export interface SessionProviderOutcome {
  detected: 'detected'
  parse: 'parsed' | 'no-data' | 'placeholder' | 'error'
  usage: 'available' | 'unavailable'
  reason?: string
}

export type SessionDetailAvailability =
  | 'ready'
  | 'transcript-only'
  | 'source-recoverable'
  | 'unavailable'

export type SessionLifecycleState = 'active' | 'archived' | 'replayed'

export interface SessionSummary {
  id: string
  sessionId: string
  resumeSessionId?: string
  /** Latest physical session reached through explicit continuation/resume evidence. */
  successor?: string
  /** Stable package identity used to collapse duplicate Library packages. */
  logicalSessionKey?: string
  /** True when more than one Library package represents this logical session. */
  duplicate?: boolean
  /** Number of physical Library packages represented by this visible row. */
  duplicatePackageCount?: number
  /** Non-sensitive summary of the physical package versions folded into this row. */
  duplicatePackageHistory?: Array<{
    createdAt: string
    updatedAt: string
    turnCount: number
  }>
  slug: string
  createdAt: string
  updatedAt: string
  /**
   * Distinct local calendar days backed by parsed message/event timestamps.
   * File mtimes, detection timestamps and manifest metadata must not enter it.
   */
  activityDays?: string[]
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
  /** Physical Codex lifecycle; replayed denotes a live fork/replay child. */
  lifecycleState?: SessionLifecycleState
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
  /** Actual per-session loader outcome; capability declarations never substitute for this fact. */
  providerOutcome?: SessionProviderOutcome
  /** Main-process only: authoritative Provider projection version for Library checkpointing. */
  canonicalProjectionFingerprint?: string
  referencedFiles: FileRef[]
  configFiles: string[]
  libraryDirPath?: string
  libraryMdPath?: string
  /** Compatibility field: retains the historical local/direct resume meaning. */
  canResume?: boolean
  resumeUnavailableReason?: string
  /** Explicit local/direct resume capability; mirrors canResume for now. */
  canResumeLocal?: boolean
  /** SSH resume is evaluated independently from local source-file availability. */
  canResumeSsh?: boolean
  sshResumeUnavailableReason?: string
  /** Non-blocking warning, for example when a legacy manifest has no exact cwd. */
  sshResumeWarning?: string
  /** True when the summary was built from .swob-session.json without parsing backup.jsonl. */
  isManifestOnly?: boolean
  /** The manifest had no user/library title, so a source-labelled shell is being shown. */
  manifestTitleIsFallback?: boolean
  /** Live detail capability. A non-zero turn count alone never promises readable detail. */
  detailAvailability?: SessionDetailAvailability
  cloudBackupState?: 'ready' | 'icloud-placeholder' | 'missing'
  isRemote?: boolean
  remoteHost?: string  // hostname of the device that created this session (e.g. "macbooka.local")
  source?: SessionSource
  claudeConfigDir?: string // non-default Claude config dir, e.g. ~/.claude-window/<id>
  allUserMessages?: string
  estimatedTime?: number  // 预估活跃时间（毫秒），相邻消息间隔累加，30min 截断
  models?: string[]  // 该 session 使用的模型列表（去重）
  /** Internal Codex children linked to this top-level session; never top-level rows themselves. */
  subagents?: SessionSubagentSummary[]
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

export type SessionDetailLoadError = 'DETAIL_UNAVAILABLE' | 'DETAIL_LOAD_FAILED'

/**
 * The ready branch intentionally preserves the historical SessionDetail
 * shape. Existing consumers keep working while newer renderers handle the
 * explicit transcript/error branches.
 */
export type SessionDetailLoadResult =
  | (SessionDetail & {
      fallback: null
      error?: never
      transcriptMarkdown?: never
    })
  | {
      fallback: 'transcript'
      transcriptMarkdown: string
      error?: never
    }
  | {
      fallback: null
      error: SessionDetailLoadError
      transcriptMarkdown?: never
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
