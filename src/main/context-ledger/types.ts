import type {
  ContextArtifact,
  DeferredToolsDelta,
  ContextInjection,
  ContextSnapshot,
  ContextTransition,
  McpContextExposure,
  ToolSearchReceipt
} from '../../shared/contracts/truth-kernel'

/**
 * Feature-local, read-only projection for the historical Context Inspector.
 * It deliberately contains no source paths or source bodies unless the source
 * transcript itself carried them as model-visible evidence.
 */
export interface ContextLedgerProjection {
  logicalSessionId: string
  artifacts: ContextArtifact[]
  injections: ContextInjection[]
  snapshots: ContextSnapshot[]
  transitions: ContextTransition[]
  mcpExposures: McpContextExposure[]
  /** The contract's A–E evidence counts. `unknown` is separate on purpose. */
  evidenceCounts: Record<'A' | 'B' | 'C' | 'D' | 'E', number>
  unknownArtifactCount: number
}

export interface ContextLedgerExport {
  schemaVersion: 1
  contractVersion: '1.0.0'
  projection: ContextLedgerProjection
}

/** Persisted truth-kernel facts supplied by the offline ingest/query layer. */
export interface PersistedContextLedgerFacts {
  contextArtifacts?: ContextArtifact[]
  contextInjections?: ContextInjection[]
  contextSnapshots?: ContextSnapshot[]
  contextTransitions?: ContextTransition[]
  mcpExposures?: McpContextExposure[]
  deferredToolsDeltas?: DeferredToolsDelta[]
  toolSearchReceipts?: ToolSearchReceipt[]
}
