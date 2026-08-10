import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IpcMain } from 'electron'
import type { CanonicalEvent } from '../shared/provider-schema-v2.generated'
import type {
  AgentTimelineEvent,
  EvidenceRef,
  PersistedOutputRef,
  PricingPolicyMutationCommand,
  TruthKernelMigrationManifest
} from '../shared/contracts/truth-kernel'
import type { TruthKernelSessionIpcReadModel } from '../shared/frontend-ipc-contract'
import { TRUTH_KERNEL_MIGRATION_MANIFEST } from '../shared/contracts/truth-kernel'
import { getCanonicalSessionStore } from './canonical-store'
import { loadSessionEventsV2ReadOnly, parseSessionFile } from './session-loader'
import { projectHistoricalContextLedger } from './context-ledger'
import { projectInteractionLedger, projectTrajectory } from './fact-ledger/interaction-projector'
import { valueUsageAttributions } from './fact-ledger/pricing-policy-repository'
import type { PricingPolicyRepository } from './fact-ledger/pricing-policy-repository'
import { ORCHESTRATION_REGISTRATIONS } from './orchestration/registry'
import { resolvePersistedOutput } from './timeline/persisted-output-resolver'
import { TruthKernelRuntime, truthSnapshot, type TruthKernelRuntimeOptions as RuntimeOptions } from './truth-kernel-runtime'

function eventEvidence(event: CanonicalEvent): EvidenceRef {
  const fingerprint = event.provenance.rawRecordFingerprint
  return {
    evidenceId: `provider-event:${event.provenance.providerId}:${event.id}`,
    sourceId: event.provenance.sourceRefId,
    sourceKind: 'provider',
    providerId: event.provenance.providerId,
    logicalSessionId: event.identity.logicalSessionId,
    sourceEventId: event.id,
    sourceRecordId: event.provenance.sourceRecordId,
    ...(event.timestamp ? { eventTime: event.timestamp, effectiveAt: event.timestamp } : {}),
    capturedAt: event.provenance.observedAt || event.timestamp || new Date(0).toISOString(),
    grade: 'B',
    claim: 'provider-confirmed',
    ...(fingerprint && fingerprint.algorithm !== 'upstream-version' ? { digest: fingerprint.value } : {})
  }
}

export function aggregateTruthKernelEvents(logicalSessionId: string): CanonicalEvent[] {
  const store = getCanonicalSessionStore()
  const sessions = store.findV2SessionsByLogicalSessionId(logicalSessionId)
    .filter((session) => !session.tombstonedAt)
  const events = sessions.flatMap((session) => {
    const output: CanonicalEvent[] = []
    let afterSequence: number | null = null
    do {
      const page = store.readV2EventPage(session.identity.logicalSessionKey, session.identity.branchViewId, {
        afterSequence,
        limit: 4_096
      })
      output.push(...page.events)
      afterSequence = page.nextSequence
    } while (afterSequence !== null)
    return output
  })
  const seen = new Set<string>()
  return events
    .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id))
    .filter((event) => {
      if (seen.has(event.sharedEventKey)) return false
      seen.add(event.sharedEventKey)
      return true
    })
}

export function projectTruthKernelTimeline(events: readonly CanonicalEvent[]): AgentTimelineEvent[] {
  return events.map((providerEvent, index) => ({
    schemaVersion: 1,
    timelineEventId: `timeline:${providerEvent.identity.branchViewId}:${providerEvent.id}`,
    sourceEventId: providerEvent.id,
    sequence: index,
    parentTimelineEventIds: index === 0
      ? []
      : [`timeline:${events[index - 1].identity.branchViewId}:${events[index - 1].id}`],
    providerEvent,
    evidence: [eventEvidence(providerEvent)],
    persistedOutputs: []
  }))
}

function payloadRecord(event: CanonicalEvent): Record<string, unknown> {
  return event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
    ? event.payload as Record<string, unknown>
    : {}
}

function outputKind(uri: string, mime: string | undefined): PersistedOutputRef['outputKind'] {
  const extension = path.extname(uri).toLowerCase()
  if (mime?.startsWith('image/')) return 'image'
  if (mime === 'application/pdf' || extension === '.pdf') return 'pdf'
  if (mime === 'application/json' || mime === 'text/csv' || ['.json', '.csv'].includes(extension)) return 'structured-media'
  if (mime?.startsWith('text/') || ['.md', '.txt', '.log'].includes(extension)) return 'document'
  return 'unknown'
}

function pathFromUri(uri: string): string {
  try { return uri.startsWith('file:') ? fileURLToPath(uri) : uri } catch { return uri }
}

async function persistedOutputFor(
  event: CanonicalEvent,
  allowedRoots: Array<{ rootId: string; absolutePath: string }>
): Promise<PersistedOutputRef | null> {
  if (event.kind !== 'artifact' && event.kind !== 'tool.result') return null
  const payload = payloadRecord(event)
  const uri = typeof payload.uri === 'string' ? payload.uri : null
  if (!uri) return null
  const candidatePath = pathFromUri(uri)
  const fingerprint = payload.fingerprint && typeof payload.fingerprint === 'object' && !Array.isArray(payload.fingerprint)
    ? payload.fingerprint as Record<string, unknown>
    : undefined
  const digest = typeof payload.digest === 'string' ? payload.digest
    : fingerprint?.algorithm === 'sha256' && typeof fingerprint.value === 'string' ? fingerprint.value : null
  const size = typeof payload.sizeBytes === 'number' && Number.isSafeInteger(payload.sizeBytes) ? payload.sizeBytes : null
  const mime = typeof payload.mimeType === 'string' ? payload.mimeType : null
  const reference: PersistedOutputRef = {
    artifactId: typeof payload.artifactId === 'string' ? payload.artifactId : `artifact:${event.id}`,
    sourceLocator: {
      kind: 'artifact',
      locatorHash: createHash('sha256').update(candidatePath).digest('hex')
    },
    digest: digest ? { status: 'available', value: digest } : { status: 'unavailable', reason: 'provider-digest-unavailable' },
    sizeBytes: size !== null ? { status: 'available', value: size } : { status: 'unavailable', reason: 'provider-size-unavailable' },
    mimeType: mime ? { status: 'available', value: mime } : { status: 'unavailable', reason: 'provider-mime-unavailable' },
    provenance: [eventEvidence(event)],
    allowedRoots: allowedRoots.map((root) => ({ rootId: root.rootId, access: 'read', granted: true })),
    contentState: 'unavailable', outputKind: outputKind(candidatePath, mime ?? undefined), activeContentAllowed: false
  }
  const resolution = await resolvePersistedOutput({ reference, candidatePath, allowedRoots })
  if (resolution.status === 'available') return { ...reference, contentState: 'available' }
  const contentState = resolution.reason === 'missing' ? 'missing'
    : resolution.reason === 'hash-mismatch' ? 'hash-mismatch'
      : ['outside-allowed-root', 'symlink-rejected'].includes(resolution.reason) ? 'outside-allowed-root'
        : 'unavailable'
  return { ...reference, contentState }
}

export async function projectTruthKernelTimelineWithOutputs(
  events: readonly CanonicalEvent[],
  allowedRoots: Array<{ rootId: string; absolutePath: string }>
): Promise<AgentTimelineEvent[]> {
  const timeline = projectTruthKernelTimeline(events)
  return Promise.all(timeline.map(async (entry, index) => {
    const output = await persistedOutputFor(events[index], allowedRoots)
    return output ? { ...entry, persistedOutputs: [output] } : entry
  }))
}

export function projectTruthKernelInteractionReadModels(events: readonly CanonicalEvent[], pricing: PricingPolicyRepository) {
  const ledger = projectInteractionLedger(events)
  return ledger.interactions.map((interaction) => {
    const usage = ledger.usageAttributions.filter((entry) => entry.interactionId === interaction.interactionId)
    const trajectory = projectTrajectory(
      interaction,
      usage,
      ledger.fileActions.filter((entry) => entry.interactionId === interaction.interactionId),
      ledger.forkBoundaries.find((entry) => entry.childLogicalSessionId === interaction.logicalSessionId),
      ledger.branchUsageRollups
    )
    const usageEvents = events.filter((event) => event.kind === 'usage' &&
      usage.some((entry) => entry.usageFactIds.includes(event.id)))
    trajectory.valuations = usageEvents.flatMap((event) => {
      const payload = event.payload as unknown as { modelId?: string | null }
      if (!payload.modelId || !event.timestamp) return []
      const eventUsage = usage.filter((entry) => entry.usageFactIds.includes(event.id))
      return [valueUsageAttributions({
        repository: pricing, usageFactId: event.id,
        providerId: event.provenance.providerId, rawModelId: payload.modelId,
        at: event.timestamp, usage: eventUsage
      })]
    })
    return trajectory
  })
}

export function enumerateTruthKernelMigrations(): TruthKernelMigrationManifest {
  const ids = TRUTH_KERNEL_MIGRATION_MANIFEST.steps.map((step) => step.id)
  if (new Set(ids).size !== ids.length) throw new Error('truth-kernel-migration-id-duplicate')
  if (TRUTH_KERNEL_MIGRATION_MANIFEST.steps.some((step) => step.sourceWritesAllowed !== false)) {
    throw new Error('truth-kernel-migration-source-write-forbidden')
  }
  return TRUTH_KERNEL_MIGRATION_MANIFEST
}

export function registerTruthKernelIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  assertSessionSourcePath: (filePath: string) => string,
  options: RuntimeOptions
): TruthKernelRuntime {
  enumerateTruthKernelMigrations()
  if (ORCHESTRATION_REGISTRATIONS.length === 0) throw new Error('truth-kernel-orchestration-registry-empty')
  const runtime = new TruthKernelRuntime(options)
  ipcMain.handle('truth-kernel:session-read-model', async (_event, sessionId: string, filePath: string) => {
    if (!sessionId?.trim()) throw new Error('truth-kernel-session-id-required')
    const safePath = assertSessionSourcePath(filePath)
    const persistedEvents = aggregateTruthKernelEvents(sessionId)
    const events = persistedEvents.length > 0
      ? persistedEvents
      : await loadSessionEventsV2ReadOnly(safePath)
    let context: ReturnType<typeof projectHistoricalContextLedger> | null = null
    try {
      context = projectHistoricalContextLedger(await parseSessionFile(safePath), sessionId)
    } catch {
      context = null
    }
    const interactions = projectTruthKernelInteractionReadModels(events, runtime.pricing)
    const externalEvidence = runtime.evidenceForSession(sessionId).map((attachment) => ({ attachment }))
    return {
      timeline: await projectTruthKernelTimelineWithOutputs(events, runtime.allowedOutputRoots()),
      context,
      interactions,
      externalEvidence,
      orchestration: runtime.orchestration(sessionId),
      availability: {
        timeline: events.length > 0 ? 'available' : 'unavailable',
        context: context ? 'available' : 'unavailable',
        externalEvidence: externalEvidence.length > 0 ? 'available' : 'unavailable',
        ...(events.length === 0 ? { reason: 'canonical-provider-events-unavailable' } : {})
      }
    } satisfies TruthKernelSessionIpcReadModel
  })
  ipcMain.handle('truth-kernel:catalog-state', () => runtime.catalogState())
  ipcMain.handle('truth-kernel:catalog-add-root', () => runtime.addCatalogRoot())
  ipcMain.handle('truth-kernel:catalog-remove-root', (_event, rootId: string) => runtime.removeCatalogRoot(rootId))
  ipcMain.handle('truth-kernel:catalog-rescan-root', (_event, rootId: string) => runtime.rescanCatalogRoot(rootId))
  ipcMain.handle('truth-kernel:catalog-save-tab', (_event, tab) => runtime.saveCatalogTab(tab))
  ipcMain.handle('truth-kernel:catalog-active-tab', (_event, tabId: string) => runtime.setActiveCatalogTab(tabId))
  ipcMain.handle('truth-kernel:catalog-remove-tab', (_event, tabId: string) => runtime.removeCatalogTab(tabId))
  ipcMain.handle('truth-kernel:catalog-onboarding', (_event, choice: 'default-library' | 'index-only' | 'skip') => runtime.decideCatalogOnboarding(choice))
  ipcMain.handle('truth-kernel:provider-doctor', () => runtime.providerDoctor(getCanonicalSessionStore()))
  ipcMain.handle('truth-kernel:external-evidence-attach', async (_event, sessionId: string, filePath: string) => {
    const safePath = assertSessionSourcePath(filePath)
    const persistedEvents = aggregateTruthKernelEvents(sessionId)
    const events = persistedEvents.length > 0 ? persistedEvents : await loadSessionEventsV2ReadOnly(safePath)
    return runtime.attachEvidence(sessionId, truthSnapshot(events))
  })
  ipcMain.handle('truth-kernel:pricing-list', () => ({ policies: runtime.pricing.list() }))
  ipcMain.handle('truth-kernel:pricing-apply', (_event, command: PricingPolicyMutationCommand) => runtime.applyPricing(command))
  return runtime
}
