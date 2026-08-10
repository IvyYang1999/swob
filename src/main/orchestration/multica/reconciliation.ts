import { createHash } from 'node:crypto'
import type { Availability, CoverageState, EvidenceRef } from '../../../shared/contracts/truth-kernel'
import type { MulticaReconciledUsage, MulticaUsageInput } from './types'

function unavailable<T>(reason: string): Availability<T> { return { status: 'unavailable', reason } }
function unknown<T>(reason: string): Availability<T> { return { status: 'unknown', reason } }

function evidence(input: MulticaUsageInput): EvidenceRef {
  const source = input.source
  const digest = source?.sha256 || createHash('sha256').update(JSON.stringify(input)).digest('hex')
  return {
    evidenceId: `multica-usage-${input.id}-${digest.slice(0, 12)}`,
    sourceId: source ? `multica-file:${digest}` : `multica-derived:${input.id}`,
    sourceKind: source ? 'provider' : 'artifact',
    providerId: 'multica',
    sourceRecordId: input.id,
    capturedAt: source?.capturedAt || new Date().toISOString(),
    grade: source ? 'B' : 'C',
    claim: source ? 'provider-confirmed' : 'deterministically-reconstructed',
    locator: source ? { kind: 'source-record', locatorHash: digest, offset: 0, length: source.byteLength } : undefined,
    digest
  }
}

function compatibleFacts(input: MulticaUsageInput) {
  return (input.nativeUsageFacts || []).filter((fact) => fact.metric === input.metric && fact.unit === input.unit &&
    (!input.providerId || !fact.providerId || input.providerId === fact.providerId) &&
    (!input.modelId || !fact.modelId || input.modelId === fact.modelId))
}

function usageCoverage(input: MulticaUsageInput, factIds: string[]): CoverageState {
  const state = input.nativeCoverage === 'complete' ? 'complete' : input.nativeCoverage === 'partial' ? 'partial' : factIds.length ? 'partial' : 'unknown'
  const missingDimensions = state === 'complete' ? [] : factIds.length
    ? ['native per-call usage is incomplete; residual is not allocated to sessions']
    : ['no compatible native usage facts were linked']
  return { state, coveredFactIds: factIds, missingDimensions, evidence: [evidence(input)] }
}

/** Reconciles numeric coverage while keeping every Multica row observation-only. */
export function reconcileMulticaUsage(inputs: MulticaUsageInput[]): MulticaReconciledUsage[] {
  return inputs.map((input) => {
    const facts = compatibleFacts(input)
    const factIds = facts.map((fact) => fact.factId)
    const nativeObservedTotal = facts.length ? facts.reduce((sum, fact) => sum + fact.total, 0) : undefined
    const hasReported = input.total !== undefined
    // coveredTotal is the covered portion of the Multica report, not an uncapped native total.
    // Capping preserves the t211A conservation law while the explicit anomaly retains disagreement truth.
    const overcoverage = hasReported && nativeObservedTotal !== undefined && nativeObservedTotal > input.total!
      ? nativeObservedTotal - input.total!
      : undefined
    const covered = nativeObservedTotal === undefined ? undefined : hasReported ? Math.min(nativeObservedTotal, input.total!) : nativeObservedTotal
    const residual = hasReported && covered !== undefined ? input.total! - covered : undefined
    const nativeAuthority = facts.some((fact) => fact.authoritative)
    const issue = input.scopeKind === 'issue'
    const authority = issue ? 'issue-observation' as const
      : nativeAuthority ? 'native' as const
        : facts.length === 0 && hasReported && input.scopeKind === 'task' ? 'multica-task-fallback' as const
          : 'unknown' as const
    const scope = input.scopeKind === 'attempt'
      ? { kind: 'run' as const, orchestrationRunId: `multica-attempt-${input.scopeId}` }
      : { kind: 'entity' as const, orchestrationEntityId: `multica-${input.scopeKind}-${input.scopeId}` }
    return {
      schemaVersion: 1,
      aggregateId: `multica-usage-${input.id}`,
      scope,
      usageFactIds: factIds,
      providerId: input.providerId ? { status: 'available', value: input.providerId } : unavailable('Multica aggregate did not identify a provider.'),
      modelId: input.modelId ? { status: 'available', value: input.modelId } : unavailable('Multica aggregate did not identify a model.'),
      metric: input.metric,
      quantityUnit: input.unit,
      reportedTotal: hasReported ? { status: 'available', value: input.total! } : unavailable('Multica aggregate did not report a numeric total.'),
      coveredTotal: covered === undefined ? unavailable('No compatible native usage fact total was supplied.') : { status: 'available', value: covered },
      residual: residual === undefined
        ? unknown(issue ? 'Issue totals are not allocated to tasks or sessions.' : 'A residual requires both a Multica total and compatible native facts.')
        : { status: 'available', value: residual },
      authoritative: { status: 'available', value: authority === 'multica-task-fallback' },
      billingDisposition: 'observation-only',
      coverage: usageCoverage(input, factIds),
      evidence: [evidence(input)],
      reconciliation: {
        authority,
        allocation: issue ? 'not-allocatable' : overcoverage !== undefined ? 'overcoverage-anomaly' : residual === 0 ? 'fully-covered' : residual === undefined ? 'unknown' : 'residual-unallocated',
        doubleCountPrevented: true,
        anomaly: overcoverage === undefined ? undefined : {
          code: 'native-covered-total-exceeds-multica-reported-total',
          nativeObservedTotal: nativeObservedTotal!,
          multicaReportedTotal: input.total!,
          overcoverage
        }
      }
    }
  })
}
