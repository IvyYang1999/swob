export type FrontendIpcErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_IMAGE_FORMAT'
  | 'FILE_TOO_LARGE'
  | 'INVALID_AVATAR_PATH'
  | 'FILE_NOT_FOUND'
  | 'SESSION_NOT_FOUND'
  | 'BUSY'
  | 'WINDOW_UNAVAILABLE'
  | 'OPERATION_FAILED'
  | 'CLIPBOARD_FAILED'
  | 'INTERNAL_ERROR'

export interface FrontendIpcError {
  code: FrontendIpcErrorCode
  message: string
}

export type FrontendIpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: FrontendIpcError }

export interface AgentHistoryItem {
  id: string
  title: string
  updatedAt: string
  turnCount: number
}

export interface AgentResumeState extends AgentHistoryItem {
  canResume: boolean
  reasonCode?: string
}

export interface AgentAlwaysOnTopState {
  alwaysOnTop: boolean
  windowOpen: boolean
}

export interface OrganizerSmartPreviewItem {
  sessionId: string
  folder: string
  topic: string
  tags: string[]
  confidence: number
  title: string
}

export type OrganizerSmartPreviewResult =
  | { ok: true; items: OrganizerSmartPreviewItem[] }
  | { ok: false; errorCode: 'organizer.error.setup_required' | 'organizer.error.preview_failed' }

export interface SpotlightNativeShadowState {
  nativeShadow: boolean
  supported: boolean
  applied: boolean
}

export interface UserIdentityInput {
  displayName: string
  avatarRelPath?: string
}

export interface UserIdentity {
  displayName: string
  avatarRelPath?: string
  avatarAvailable: boolean
}

export interface ShareSavePngResult {
  canceled: boolean
  filePath?: string
}

export interface ShareCopyPngResult {
  copied: true
}
