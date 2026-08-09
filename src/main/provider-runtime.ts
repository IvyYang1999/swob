import { ProviderHost, type ProviderRunReport } from './provider-host'
import {
  getCanonicalSessionStore,
  type CanonicalSessionStore
} from './canonical-store'
import { getSearchIndexWriteCoordinator } from './search-index-writer'
import { projectNativeV2ChunksForConsumers } from './provider-v2-consumer-projection'

export interface CanonicalProviderRefreshOptions {
  host?: ProviderHost
  store?: CanonicalSessionStore
  archive?: boolean
}

export interface CanonicalProviderRefreshResult {
  reports: ProviderRunReport[]
  changedSessionRecordIds: string[]
  tombstonedSessionRecordIds: string[]
}

let defaultHost: ProviderHost | null = null
let runtimeTail: Promise<void> = Promise.resolve()

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
  const changedSessionRecordIds: string[] = []
  const tombstonedSessionRecordIds: string[] = []

  for (const report of reports) {
    for (const source of report.unchangedSources) {
      store.rebindSource(source)
      for (const sessionRecordId of store.sourceStates(report.providerId)
        .find((state) => state.sourceRef.stableId === source.stableId)?.sessionRecordIds || []) {
        const stored = store.getSession(sessionRecordId)
        if (!stored || stored.tombstone) continue
        await getSearchIndexWriteCoordinator().scheduleCanonicalIndex(
          stored.sessionRecord.sourceSessionId,
          stored.records
        )
        if (options.archive) {
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
        await getSearchIndexWriteCoordinator().scheduleCanonicalIndex(
          stored.sessionRecord.sourceSessionId,
          stored.records
        )
        if (options.archive) {
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
        const { markCanonicalPackageTombstone } = await import('./library-manager')
        await markCanonicalPackageTombstone(
          report.providerId,
          tombstone.sourceRefId,
          tombstone.sessionRecordId,
          tombstone
        ).catch(() => null)
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
