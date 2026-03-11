export interface RawJsonlMessage {
  uuid: string
  parentUuid: string | null
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
}

export interface ParsedMessage {
  uuid: string
  type: 'user' | 'assistant' | 'system' | 'progress'
  subtype?: string
  timestamp: string
  role?: string
  textContent: string
  toolCalls: ToolCallInfo[]
  isPreCompact: boolean
  isSidechain: boolean
  isSharedContext: boolean
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
  userImages: string[]
  referencedFiles: FileRef[]
  configFiles: string[]
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

export interface UserConfig {
  folders: Folder[]
  sessionMeta: Record<string, {
    customTitle?: string
    notes?: string
  }>
  preferences: {
    defaultViewMode: 'compact' | 'full'
    terminalApp: 'Terminal' | 'iTerm2'
  }
}
