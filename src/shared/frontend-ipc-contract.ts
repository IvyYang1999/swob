import type {
  AgentTimelineEvent,
  ArchiveCoverage,
  Collection,
  CoverageState,
  ContextArtifact,
  ContextInjection,
  ContextSnapshot,
  ContextTransition,
  ExternalEvidenceAttachment,
  InteractionTrajectoryReadModel,
  McpContextExposure,
  ObservedUsageAggregate,
  PricingPolicyMutationCommand,
  PricingPolicyMutationResponse,
  StorageRoot,
  StorageRootObservation,
  UserPricingPolicy,
  VerificationResult
  , WorkspaceTab
} from './contracts/truth-kernel'
import type { ProviderManifest } from './provider-schema-v2.generated'

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

export interface ImageSelectionResult {
  canceled: boolean
  filePath?: string
}

export interface HarnessIconOverrideInput {
  source: string
  iconRelPath?: string
}

export interface HarnessIconOverride {
  source: string
  iconRelPath?: string
  iconAvailable: boolean
}

export interface ShareSavePngResult {
  canceled: boolean
  filePath?: string
}

export interface ShareCopyPngResult {
  copied: true
}

export interface TruthKernelSessionIpcReadModel {
  timeline: AgentTimelineEvent[]
  context: {
    logicalSessionId: string
    artifacts: ContextArtifact[]
    injections: ContextInjection[]
    snapshots: ContextSnapshot[]
    transitions: ContextTransition[]
    mcpExposures: McpContextExposure[]
    evidenceCounts: Record<'A' | 'B' | 'C' | 'D' | 'E', number>
    unknownArtifactCount: number
  } | null
  interactions: InteractionTrajectoryReadModel[]
  externalEvidence: Array<{ attachment: ExternalEvidenceAttachment; verification?: VerificationResult }>
  orchestration: {
    mode: 'read-only'
    runs: number
    linkedRuns: number
    usageAggregates: ObservedUsageAggregate[]
    coverage: CoverageState
    diagnostics: string[]
  }
  availability: {
    timeline: 'available' | 'unavailable'
    context: 'available' | 'unavailable'
    externalEvidence: 'available' | 'unavailable'
    reason?: string
  }
}

export interface TruthKernelCatalogIpcState {
  roots: Array<{ root: StorageRoot; observation: StorageRootObservation }>
  collections: Collection[]
  tabs: WorkspaceTab[]
  activeTabId: string
  logicalSessionIds: string[]
  sources: Array<{ id: string; label: string; count: number }>
  coverage: ArchiveCoverage
  onboardingPreview?: {
    previewId: string
    sessionCount: number
    estimatedArchiveBytes: number
    privacyScopes: string[]
    sourceCount: number
    complete: boolean
  }
  onboardingChoice?: 'default-library' | 'index-only' | 'skip'
}

export interface TruthKernelProviderDoctorIpcInput {
  manifest: ProviderManifest
  discovery: 'found' | 'not-found' | 'skipped' | 'error'
  discoveryReason: string | null
  lastSuccessfulParseAt: string | null
  unknownEvents: number
  partialEvents: number
  sourceLabel: string
  executionDomain: 'native' | 'wsl' | 'unknown'
}

export interface TruthKernelExternalEvidenceAttachResult {
  canceled: boolean
  attachment?: ExternalEvidenceAttachment
}

export interface TruthKernelPricingIpcState {
  policies: readonly UserPricingPolicy[]
}

export type TruthKernelPricingMutation = PricingPolicyMutationCommand
export type TruthKernelPricingMutationResult = PricingPolicyMutationResponse
