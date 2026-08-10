import { ChevronDown, ChevronRight, ShieldCheck } from 'lucide-react'
import { useState } from 'react'

/** Renderer-safe read model; the IPC adapter is owned by t211I. */
export interface ContextLedgerProjectionView {
  artifacts: Array<{
    contextArtifactId: string
    kind: string
    sourceUri: { status: string; value?: string; reason?: string }
    capturedAt: string
    effectiveAt: { status: string; value?: string; reason?: string }
    evidence: Array<{ grade: string; sourceKind?: string }>
  }>
  injections: Array<{
    contextInjectionId: string
    contextArtifactId: string
    operation: string
    trigger: string
    visibleToModel: boolean | 'unknown'
  }>
  snapshots: Array<{ reportedInputTokens: { status: string; value?: number }; unknownInputTokens: { status: string; value?: number } }>
  transitions: Array<{
    contextTransitionId: string
    kind: string
    effectiveAt: { status: string; value?: string; reason?: string }
    deltas: Array<{ contextArtifactId: string; disposition: string }>
  }>
  mcpExposures: Array<{
    exposureId: string
    serverId: string
    configured: { state: string }
    serverInstructionsVisible: { state: string }
    toolNameVisible: { state: string }
    schemaState: string
    called: { state: string }
    resultVisible: { state: string }
  }>
  evidenceCounts: Record<'A' | 'B' | 'C' | 'D' | 'E', number>
  unknownArtifactCount: number
}

export interface ContextLedgerLabels {
  title: string
  unknown: string
  currentSnapshot: string
  reportedInput: string
  estimatedTokens: string
  introduced: string
  preserved: string
  summarized: string
  dropped: string
  mcpExposure: string
  configured: string
  instructions: string
  toolName: string
  schema: string
  called: string
  result: string
  source: string
  time: string
  transition: string
  trigger: string
  operation: string
  visibleToModel: string
  evidence: string
}

export interface ContextLedgerPanelProps {
  projection: ContextLedgerProjectionView
  labels: ContextLedgerLabels
}

const grades: Array<'A' | 'B' | 'C' | 'D' | 'E'> = ['A', 'B', 'C', 'D', 'E']

/** Feature-local UI; t211I owns registering this panel in the Inspector slot. */
export function ContextLedgerPanel({ projection, labels }: ContextLedgerPanelProps) {
  const [expanded, setExpanded] = useState(false)
  const latest = projection.snapshots.at(-1)
  const residual = latest?.unknownInputTokens.status === 'available' ? latest.unknownInputTokens.value : undefined

  return (
    <section className="rounded-md border border-edge p-3 space-y-2" data-testid="context-ledger-panel">
      <button
        type="button"
        className="flex w-full items-center gap-2 text-left text-xs font-medium"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <ShieldCheck size={14} />
        <span>{labels.title}</span>
      </button>
      {expanded && (
        <div className="space-y-2 text-xs text-muted">
          <div className="flex flex-wrap gap-2" aria-label={labels.title}>
            {grades.map((grade) => <span key={grade} className="rounded bg-surface px-1.5 py-0.5">{grade}: {projection.evidenceCounts[grade]}</span>)}
            <span className="rounded bg-surface px-1.5 py-0.5">{labels.unknown}: {projection.unknownArtifactCount}</span>
          </div>
          {latest && (
            <div className="rounded border border-edge p-2">
              <div>{labels.reportedInput}: {latest.reportedInputTokens.status === 'available' ? latest.reportedInputTokens.value : labels.unknown}</div>
              <div>{labels.unknown}: {residual === undefined ? labels.unknown : residual}</div>
            </div>
          )}
          <div className="space-y-1">
            {projection.artifacts.map((artifact) => (
              <div key={artifact.contextArtifactId} className="min-w-0 space-y-1 rounded bg-surface px-2 py-1">
                <div className="flex justify-between gap-2">
                  <span className="min-w-0 flex-1 truncate" title={artifact.kind}>{artifact.kind}</span>
                  <span className="shrink-0">{labels.evidence}: {artifact.evidence[0]?.grade || labels.unknown}</span>
                </div>
                <div className="break-all text-[11px]">
                  {labels.source}: {artifact.sourceUri.status === 'available' ? artifact.sourceUri.value : labels.unknown}
                </div>
                <div className="break-words text-[11px]">
                  {labels.time}: {artifact.effectiveAt.status === 'available' ? artifact.effectiveAt.value : artifact.capturedAt}
                </div>
              </div>
            ))}
          </div>
          {projection.injections.map((injection) => (
            <div key={injection.contextInjectionId} className="min-w-0 rounded border border-edge p-2" data-testid="context-ledger-injection">
              <div className="break-all font-medium text-primary">{injection.contextArtifactId}</div>
              <div className="grid grid-cols-2 gap-x-2 gap-y-1 break-words">
                <span>{labels.operation}</span><span>{injection.operation}</span>
                <span>{labels.trigger}</span><span>{injection.trigger}</span>
                <span>{labels.visibleToModel}</span><span>{String(injection.visibleToModel)}</span>
              </div>
            </div>
          ))}
          {projection.transitions.map((transition) => (
            <div key={transition.contextTransitionId} className="min-w-0 space-y-1 rounded border border-edge p-2" data-testid="context-ledger-transition">
              <div className="font-medium text-primary">{labels.transition}: {transition.kind}</div>
              <div className="break-words text-[11px]">
                {labels.time}: {transition.effectiveAt.status === 'available' ? transition.effectiveAt.value : labels.unknown}
              </div>
              {transition.deltas.map((delta, index) => (
                <div key={`${delta.contextArtifactId}:${index}`} className="flex min-w-0 justify-between gap-2 rounded bg-surface px-2 py-1">
                  <span className="min-w-0 flex-1 break-all">{delta.contextArtifactId}</span>
                  <span className="shrink-0">{delta.disposition}</span>
                </div>
              ))}
            </div>
          ))}
          {projection.mcpExposures.map((exposure) => (
            <div key={exposure.exposureId} className="space-y-1 rounded border border-edge p-2" data-testid="context-ledger-mcp-exposure">
              <div className="font-medium text-primary">{labels.mcpExposure}: {exposure.serverId}</div>
              <dl className="grid grid-cols-2 gap-x-2 gap-y-1 break-words">
                <dt>{labels.configured}</dt><dd>{exposure.configured.state}</dd>
                <dt>{labels.instructions}</dt><dd>{exposure.serverInstructionsVisible.state}</dd>
                <dt>{labels.toolName}</dt><dd>{exposure.toolNameVisible.state}</dd>
                <dt>{labels.schema}</dt><dd>{exposure.schemaState}</dd>
                <dt>{labels.called}</dt><dd>{exposure.called.state}</dd>
                <dt>{labels.result}</dt><dd>{exposure.resultVisible.state}</dd>
              </dl>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
