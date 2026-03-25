export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
}

export interface RawJsonlMessage {
  uuid: string
  parentUuid: string | null
  logicalParentUuid?: string | null  // used across compact boundaries
  sessionId: string
  type: 'user' | 'assistant' | 'system' | 'progress' | 'file-history-snapshot'
  subtype?: string
  timestamp: string
  cwd?: string
  version?: string
  slug?: string
  isSidechain?: boolean
  permissionMode?: string
  message?: {
    role: string
    content: string | ContentPart[]
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
    }
  }
  data?: unknown
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

export interface SessionSummary {
  id: string
  sessionId: string
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
  branchParentFilePaths?: string[]
  branchPointUuid?: string
  branchLeafUuid?: string // for intra-file branches: trace this leaf's parentUuid chain
  branchParentId?: string // ID of the parent branch/session this was forked from
  branchChildIds?: string[] // IDs of child branches forked from this session
  userImages: string[]
  pastedImageCount: number // count of base64 pasted images (not stored as data URLs in summary)
  tokenUsage: TokenUsage
  referencedFiles: FileRef[]
  configFiles: string[]
  libraryDirPath?: string
  libraryMdPath?: string
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
  color?: string
  createdAt: string
}

export interface Highlight {
  id: string
  text: string
  turnUuid: string
  note?: string
  createdAt: string
}

export interface UserConfig {
  folders: Folder[]
  sessionMeta: Record<string, {
    customTitle?: string
    notes?: string
    highlights?: Highlight[]
  }>
  preferences: {
    defaultViewMode: 'compact' | 'full'
    terminalApp: 'Terminal' | 'iTerm2'
    locale?: 'zh-CN' | 'en'
  }
}
