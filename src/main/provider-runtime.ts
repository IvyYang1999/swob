import { ProviderHost, type ProviderRunReport } from './provider-host'
import {
  getCanonicalSessionStore,
  type CanonicalSessionStore
} from './canonical-store'
import { getSearchIndexWriteCoordinator } from './search-index-writer'
import { projectNativeV2ChunksForConsumers } from './provider-v2-consumer-projection'
import { builtinProviderForId } from '../shared/provider-capabilities'

export interface CanonicalProviderRefreshOptions {
  host?: ProviderHost
  store?: CanonicalSessionStore
  archive?: boolean
  shouldProjectSource?: (sourceId: string) => boolean
}

export interface CanonicalProviderRefreshResult {
  reports: ProviderRunReport[]
  changedSessionRecordIds: string[]
  tombstonedSessionRecordIds: string[]
}

let defaultHost: ProviderHost | null = null
let runtimeTail: Promise<void> = Promise.resolve()
let configuredSourceProjection: (sourceId: string) => boolean = () => true

export interface CanonicalProviderRuntimeDiagnostic {
  providerId: string
  discovery: 'found' | 'not-found' | 'skipped' | 'error'
  discoveryReason: string | null
  lastSuccessfulParseAt: string | null
  partialEvents: number
  sourceCount: number
  executionDomain: 'native' | 'wsl' | 'unknown'
}

let latestRuntimeDiagnostics = new Map<string, CanonicalProviderRuntimeDiagnostic>()

function executionDomain(report: ProviderRunReport): CanonicalProviderRuntimeDiagnostic['executionDomain'] {
  const locators = [...report.discoveredSources, ...report.unchangedSources].map((source) => source.displayLocator)
  if (locators.some((locator) => locator.startsWith('wsl://') || locator.startsWith('\\\\wsl$\\') || /^\/mnt\/[a-z]\//i.test(locator))) return 'wsl'
  if (locators.some((locator) => locator.startsWith('file:') || locator.startsWith('/') || /^[A-Za-z]:[\\/]/.test(locator))) return 'native'
  return 'unknown'
}

function rememberRuntimeDiagnostics(reports: ProviderRunReport[], completedAt: string): void {
  latestRuntimeDiagnostics = new Map(reports.map((report) => {
    const sourceCount = new Set([...report.discoveredSources, ...report.unchangedSources].map((source) => source.stableId)).size
    const partialEvents = report.outcomes.filter((outcome) => outcome.status === 'partial')
      .reduce((sum, outcome) => sum + outcome.sessions.reduce((sessionSum, session) => sessionSum + session.records.length, 0), 0) +
      report.v2Chunks.reduce((sum, chunk) => sum + chunk.diagnostics.length + (chunk.done ? 0 : chunk.events.length), 0)
    const successful = report.errors.length === 0 && (
      sourceCount > 0 || report.outcomes.some((outcome) => ['complete', 'replace', 'no-data'].includes(outcome.status)) ||
      report.v2Chunks.some((chunk) => chunk.done)
    )
    const skipped = report.outcomes.length > 0 && report.outcomes.every((outcome) => outcome.status === 'skipped' || outcome.status === 'no-data')
    const discovery = report.errors.length > 0 && sourceCount === 0 ? 'error'
      : sourceCount > 0 ? 'found'
        : skipped ? 'skipped' : 'not-found'
    return [report.providerId, {
      providerId: report.providerId, discovery,
      discoveryReason: report.errors[0]?.code ?? (discovery === 'not-found' ? 'no-source-discovered' : discovery === 'skipped' ? 'provider-skipped' : null),
      lastSuccessfulParseAt: successful ? completedAt : null,
      partialEvents, sourceCount, executionDomain: executionDomain(report)
    }]
  }))
}

export function getCanonicalProviderRuntimeDiagnostics(): ReadonlyMap<string, CanonicalProviderRuntimeDiagnostic> {
  return new Map(latestRuntimeDiagnostics)
}

export function configureCanonicalProviderProjection(
  predicate: ((sourceId: string) => boolean) | null
): void {
  configuredSourceProjection = predicate || (() => true)
}

/**
 * Reconcile the durable canonical store with the current presentation policy.
 * Exclusion never deletes Provider evidence or Library packages: it only
 * removes the source from the searchable projection until it is included again.
 */
export function reconcileCanonicalProviderProjection(
  options: Pick<CanonicalProviderRefreshOptions, 'store' | 'shouldProjectSource'> = {}
): Promise<void> {
  return serializeCanonicalProviderRuntime(async () => {
    const store = options.store || getCanonicalSessionStore()
    const shouldProjectSource = options.shouldProjectSource || configuredSourceProjection
    const operations = store.listSessions().map((stored) => {
      const sourceId = builtinProviderForId(
        stored.sessionRecord.provenance.providerId
      )?.sourceId
      if (sourceId == null || shouldProjectSource(sourceId)) {
        return getSearchIndexWriteCoordinator().scheduleCanonicalIndex(
          stored.sessionRecord.sourceSessionId,
          stored.records
        )
      }
      return getSearchIndexWriteCoordinator().scheduleCanonicalTombstone(
        stored.sessionRecord.id
      )
    })
    await Promise.all(operations)
  })
}

function serializeCanonicalProviderRuntime<T>(
  operation: () => Promise<T>
): Promise<T> {
  const next = runtimeTail.then(operation, operation)
  runtimeTail = next.then(() => undefined, () => undefined)
  return next
}

function getDefaultHost(): ProviderHost {
  return defaultHost || (defaultHost = new ProviderHost())
}

async function runRefresh(options: CanonicalProviderRefreshOptions): Promise<CanonicalProviderRefreshResult> {
  const host = options.host || getDefaultHost()
  const store = options.store || getCanonicalSessionStore()
  const previousSources = new Map(host.manifests().map((manifest) => [
    manifest.providerId,
    store.sourceStates(manifest.providerId).map((state) => {
      const parserVersionChanged = state.sessionRecordIds.some((sessionRecordId) =>
        store.getSession(sessionRecordId)?.sessionRecord.provenance.parserDataVersion !==
          manifest.parserDataVersion)
      return {
        ...state,
        forceReparse: parserVersionChanged || !store.hasCompleteV2Source(
          manifest.providerId,
          state.sourceRef.stableId,
          state.sessionRecordIds.length
        )
      }
    })
  ]))
  const reports = await host.runAll({ previousSources })
  rememberRuntimeDiagnostics(reports, new Date().toISOString())
  const changedSessionRecordIds: string[] = []
  const tombstonedSessionRecordIds: string[] = []

  for (const report of reports) {
    const sourceId = builtinProviderForId(report.providerId)?.sourceId
    const shouldProject = sourceId == null ||
      (options.shouldProjectSource || configuredSourceProjection)(sourceId)
    for (const source of report.unchangedSources) {
      store.rebindSource(source)
      for (const sessionRecordId of store.sourceStates(report.providerId)
        .find((state) => state.sourceRef.stableId === source.stableId)?.sessionRecordIds || []) {
        const stored = store.getSession(sessionRecordId)
        if (!stored || stored.tombstone) continue
        if (shouldProject) {
          await getSearchIndexWriteCoordinator().scheduleCanonicalIndex(
            stored.sessionRecord.sourceSessionId,
            stored.records
          )
        } else {
          await getSearchIndexWriteCoordinator().scheduleCanonicalTombstone(sessionRecordId)
        }
        if (options.archive && shouldProject) {
          const { ensureCanonicalPackage } = await import('./library-manager')
          await ensureCanonicalPackage(report.providerId, stored.sessionRecord.sourceRef, stored.records)
        }
      }
    }
    if (report.runtimeProtocolVersion === 2 && report.v2Manifest) {
      report.consumerProjections.push(...projectNativeV2ChunksForConsumers(
        report.providerId,
        report.v2Manifest.parserDataVersion,
        report.discoveredSources,
        report.v2Chunks
      ))
    }
    // Native-v2 streams remain authoritative. This read-model projection only
    // feeds consumers that have not yet moved off CanonicalRecord v1.
    for (const outcome of [...report.outcomes, ...report.consumerProjections]) {
      store.applyParseOutcome(outcome)
      for (const result of outcome.sessions) {
        if (!result.sessionRecordId) continue
        const stored = store.getSession(result.sessionRecordId)
        if (!stored || stored.tombstone) continue
        changedSessionRecordIds.push(result.sessionRecordId)
        if (shouldProject) {
          await getSearchIndexWriteCoordinator().scheduleCanonicalIndex(
            stored.sessionRecord.sourceSessionId,
            stored.records
          )
        } else {
          await getSearchIndexWriteCoordinator().scheduleCanonicalTombstone(result.sessionRecordId)
        }
        if (options.archive && shouldProject) {
          const { ensureCanonicalPackage } = await import('./library-manager')
          await ensureCanonicalPackage(
            report.providerId,
            stored.sessionRecord.sourceRef,
            stored.records
          )
        }
      }
      for (const tombstone of outcome.tombstones) {
        tombstonedSessionRecordIds.push(tombstone.sessionRecordId)
        store.tombstoneV2Source(
          outcome.providerId,
          tombstone.sourceRefId,
          tombstone.deletedAt,
          tombstone.reason
        )
        await getSearchIndexWriteCoordinator().scheduleCanonicalTombstone(tombstone.sessionRecordId)
        if (shouldProject) {
          const { markCanonicalPackageTombstone } = await import('./library-manager')
          await markCanonicalPackageTombstone(
            report.providerId,
            tombstone.sourceRefId,
            tombstone.sessionRecordId,
            tombstone
          ).catch(() => null)
        }
      }
    }
    for (const chunk of report.v2Chunks) store.applyParseChunkV2(chunk)
    for (const removal of report.removedSources) {
      store.tombstoneV2Source(report.providerId, removal.sourceRefId, removal.deletedAt, 'source-missing')
      for (const sessionRecordId of removal.sessionRecordIds) {
        const tombstone = {
          sourceRefId: removal.sourceRefId,
          sessionRecordId,
          deletedAt: removal.deletedAt,
          reason: 'source-missing' as const,
          previousFingerprint: removal.previousFingerprint
        }
        store.applyTombstone(tombstone)
        tombstonedSessionRecordIds.push(sessionRecordId)
        await getSearchIndexWriteCoordinator().scheduleCanonicalTombstone(sessionRecordId)
        if (shouldProject) {
          const { markCanonicalPackageTombstone } = await import('./library-manager')
          await markCanonicalPackageTombstone(
            report.providerId,
            removal.sourceRefId,
            sessionRecordId,
            tombstone
          ).catch(() => null)
        }
      }
    }
  }
  return {
    reports,
    changedSessionRecordIds: [...new Set(changedSessionRecordIds)],
    tombstonedSessionRecordIds: [...new Set(tombstonedSessionRecordIds)]
  }
}

export function refreshCanonicalProviders(
  options: CanonicalProviderRefreshOptions = {}
): Promise<CanonicalProviderRefreshResult> {
  if (options.host || options.store) return runRefresh(options)
  return serializeCanonicalProviderRuntime(() => runRefresh(options))
}

/**
 * Serialize a dependent canonical-store consumer with provider refreshes.
 * This closes the tombstone/archive race: a later refresh cannot tombstone a
 * session between the consumer's authoritative store read and its durable
 * Library write, and an earlier tombstone is visible before the consumer runs.
 */
export function withCanonicalProviderRefreshBarrier<T>(
  operation: () => Promise<T>
): Promise<T> {
  return serializeCanonicalProviderRuntime(operation)
}

export function cancelCanonicalProviders(): void {
  defaultHost?.cancelAll()
}
