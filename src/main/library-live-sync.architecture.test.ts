import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

const source = fs.readFileSync(path.join(__dirname, 'index.ts'), 'utf8')
const manager = fs.readFileSync(path.join(__dirname, 'library-manager.ts'), 'utf8')
const backlogQueue = fs.readFileSync(path.join(__dirname, 'library-backlog-recovery-queue.ts'), 'utf8')
const libraryWorker = fs.readFileSync(path.join(__dirname, 'library-worker.ts'), 'utf8')
const duplicateWorker = fs.readFileSync(path.join(__dirname, 'duplicate-recovery-worker.ts'), 'utf8')

describe('live Library synchronization architecture', () => {
  it('keeps the normal batch lease intact and exposes a separately bounded startup chunk', () => {
    expect(manager).toMatch(
      /syncLibraryFromSessions[\s\S]*?return withLibraryWriter\('maintenance',[\s\S]*?syncLibraryFromSessionsUnderWriter/
    )
    expect(manager).toContain('startup Library sync chunks must contain at most one session')
  })

  it('uses a dedicated live worker and clears it plus writer proof on shutdown and root switch', () => {
    expect(source).toContain('let liveSessionSyncWorker: LibraryWorkerClient | null = null')
    expect(source).toContain('const worker = liveSessionSyncWorker || (liveSessionSyncWorker = new LibraryWorkerClient())')
    expect(source).toMatch(
      /function cleanupRuntimeResources[\s\S]*?libraryStartupWriterProven = false[\s\S]*?currentLiveSessionSyncWorker\?\.close\(\)/
    )
    expect(source).toMatch(
      /async function activateLibraryAt[\s\S]*?libraryStartupWriterProven = false[\s\S]*?previousLiveSessionSyncWorker\?\.close\(\)/
    )
    expect(source).toMatch(
      /classification\.state === 'writer-blocked'[\s\S]*?libraryStartupWriterProven = false[\s\S]*?deferLibrarySynchronization\(request\)[\s\S]*?scheduleLibraryWriterRecovery\(\)/
    )
    expect(source).toMatch(
      /liveSessionSyncWorkerRecycleGate\.begin[\s\S]*?try[\s\S]*?await worker\.retire\(\)[\s\S]*?finally[\s\S]*?liveSessionSyncWorker === worker[\s\S]*?catch/
    )
    expect(source).toContain("recordLibraryDiagnostic('LIVE_WORKER_RECYCLE_FAILED'")
  })

  it('uses a bounded generation cutoff instead of waiting for global live idle', () => {
    const drain = source.match(
      /async function drainLiveSessionSynchronizations\(\)[\s\S]*?\n}\n/
    )?.[0] || ''
    expect(drain).toContain('flushPendingSnapshot({ maxEntries: 2 })')
    expect(drain).not.toContain('waitForIdle')
  })

  it('keeps targeted startup recovery separate from writer compensation and full initialization', () => {
    const compensationCancelHandler = source.match(
      /ipcMain\.handle\('library:compensationCancel',[\s\S]*?\n}\)/
    )?.[0] || ''
    const compensationHandler = source.match(
      /ipcMain\.handle\('library:compensationRetry',[\s\S]*?\n}\)/
    )?.[0] || ''
    expect(compensationHandler).toContain('retryLibraryAfterWriterBlocked(true)')
    expect(compensationHandler).not.toContain('initLibraryFromSessions')
    expect(compensationCancelHandler).toContain('cancelCompensation()')
    expect(compensationCancelHandler).not.toContain('libraryStartup')
    expect(source).toMatch(
      /async function runLibraryBacklogRecovery[\s\S]*?libraryBacklogRecoveryQueue\.request\(mode\)[\s\S]*?while \([\s\S]*?libraryBacklogRecoveryQueue\.takeNext\(\)[\s\S]*?syncStartupSessions\(worker, cachedSessions, oldConfig\.sessionMeta, nextMode\)/
    )
    const recoveryRunner = source.match(/async function runLibraryBacklogRecovery[\s\S]*?\n}\n/)?.[0] || ''
    expect(recoveryRunner).toContain('libraryRuntimePaused || !libraryInitialized || libraryInitializationPromise')
    expect(source).toMatch(
      /shouldSelectLibraryBacklogItem\([\s\S]*?mode,[\s\S]*?recoveryByIndex\.get\(index\),[\s\S]*?now,[\s\S]*?isProviderSession\(sessions\[index\]\)[\s\S]*?\)/
    )
    expect(backlogQueue).toContain("providerSession && (!recovery || recovery.state === 'waiting-provider')")
  })

  it('publishes new loader facts before waking every source-backed recovery state', () => {
    const synchronization = source.match(
      /async function performSessionSynchronization[\s\S]*?\n}\n\nfunction scheduleSessionSynchronization/
    )?.[0] || ''
    const cacheCommit = synchronization.indexOf('cachedSessions[existingIndex] = summary')
    const recoveryWake = synchronization.lastIndexOf("runLibraryBacklogRecovery('automatic')")
    expect(cacheCommit).toBeGreaterThan(-1)
    expect(recoveryWake).toBeGreaterThan(cacheCommit)
    expect(synchronization).toContain('hasSourceRecoveryWork(backlogRecovery)')
    const sourceRecoveryPredicate = source.match(/function hasSourceRecoveryWork[\s\S]*?\n}\n/)?.[0] || ''
    expect(sourceRecoveryPredicate).toContain('recovery.retryScheduled')
    expect(sourceRecoveryPredicate).toContain('recovery.attentionRequired')
    expect(sourceRecoveryPredicate).toContain('recovery.exhausted')
  })

  it('keeps search projection behind one non-blocking writer boundary', () => {
    expect(source).toContain('getSearchIndexWriteCoordinator().scheduleLegacySource')
    expect(source).toContain('getSearchIndexWriteCoordinator().scheduleLegacySnapshot')
    expect(source).toMatch(/scheduleLegacySource\([\s\S]*?\.then\(notifySearchIndexUpdated\)/)
    expect(source).toMatch(/scheduleLegacySnapshot\([\s\S]*?\.then\(notifySearchIndexUpdated\)/)
    const searchHandler = source.match(
      /ipcMain\.handle\('sessions:search',[\s\S]*?\n}\)/
    )?.[0] || ''
    expect(searchHandler).toContain('const recovery = getSearchIndexWriteCoordinator().retryPending()')
    expect(searchHandler).toContain('setTimeout(resolve, 16)')
    expect(searchHandler).toContain('notifySearchIndexUpdated()')
    expect(source).toMatch(
      /function notifySearchIndexUpdated\(\): void \{[\s\S]*?webContents\.send\('session:searchIndexUpdated'\)/
    )
    expect(searchHandler).not.toContain('await getSearchIndexWriteCoordinator().retryPending()')
    expect(source).toMatch(
      /function scheduleSearchIndexWarmupNow[\s\S]*?scheduledEpoch = libraryRuntimeEpoch[\s\S]*?scheduleEpochBoundTask/
    )
    expect(source).toMatch(
      /async function activateLibraryAt[\s\S]*?closeSearchIndexWriteCoordinator[\s\S]*?libraryRuntimePaused = false[\s\S]*?openStartupProjectionGate\(\)/
    )
  })

  it('defers full projections until the initial live durability boundary', () => {
    expect(source).toContain('const startupProjectionGate = new StartupProjectionGate<UsageFactSyncResult>()')
    expect(source).toMatch(
      /function scheduleSearchIndexWarmup\(\): void \{[\s\S]*?startupProjectionGate\.scheduleSearch\(scheduleSearchIndexWarmupNow\)/
    )
    expect(source).toMatch(
      /function scheduleUsageFactSync[\s\S]*?startupProjectionGate\.scheduleUsage\(options, scheduleUsageFactSyncNow\)/
    )
    expect(source).toMatch(
      /drainLive: drainLiveSessionSynchronizations,[\s\S]*?onFirstDurableBoundary:[\s\S]*?openStartupProjectionGate\(\)/
    )
    expect(source).toMatch(
      /async function initLibraryFromSessions[\s\S]*?catch \(error\)[\s\S]*?startupProjectionGate\.reset\([\s\S]*?throw error/
    )
    expect(source).toMatch(
      /async function activateLibraryAt[\s\S]*?catch \(error\)[\s\S]*?startupProjectionGate\.reset\([\s\S]*?throw error/
    )
    expect(source).toMatch(
      /initialization\.catch\(\(error\) => \{[\s\S]*?if \(runtimeShuttingDown \|\| libraryRuntimePaused\) return[\s\S]*?transitionLibraryHealth/
    )
  })

  it('closes the shared writer coordinator before a mutation-incomplete fatal dialog', () => {
    const cleanup = source.match(/function cleanupRuntimeResources[\s\S]*?\n}\n/)?.[0] || ''
    expect(cleanup).not.toContain('closeLibraryWriterRuntime()')
    const applyWork = source.match(
      /async function applyPreparedDuplicateRecovery[\s\S]*?\n}\n\nipcMain\.handle\('library:applyDuplicateRecovery'/
    )?.[0] || ''
    expect(applyWork).toContain('error instanceof DuplicateRecoveryMutationIncompleteError')
    expect(applyWork.indexOf('closeLibraryWriterRuntime()')).toBeGreaterThan(-1)
    expect(applyWork.indexOf('const shutdown = cleanupRuntimeResources()')).toBeGreaterThan(
      applyWork.indexOf('closeLibraryWriterRuntime()')
    )
    expect(applyWork.indexOf('const shutdown = cleanupRuntimeResources()')).toBeGreaterThan(-1)
    expect(applyWork.indexOf('dialog.showErrorBox(')).toBeGreaterThan(
      applyWork.indexOf('const shutdown = cleanupRuntimeResources()')
    )
  })

  it('single-flights and generation-binds duplicate analysis while keeping apply revalidation', () => {
    const analysis = source.match(
      /function runDuplicateRecoveryAnalysis[\s\S]*?\n}\n\nipcMain\.handle\('library:getHealth'/
    )?.[0] || ''
    expect(analysis).toContain('cachedDuplicateRecoveryAnalysis.writeGeneration === writeGeneration')
    expect(analysis).toContain('activeDuplicateRecoveryAnalysis.writeGeneration === writeGeneration')
    expect(analysis).toContain("stale.reject(new Error('duplicate-recovery-analysis-superseded'))")
    expect(source).toMatch(
      /function adoptLibraryTree[\s\S]*?requestAutomaticDuplicateRecoveryAnalysis\(tree\)/
    )
    const adoptTree = source.match(/function adoptLibraryTree[\s\S]*?\n}\n/)?.[0] || ''
    expect(adoptTree).not.toContain("runLibraryBacklogRecovery('automatic')")
    expect(source).toMatch(
      /function adoptLibraryTree[\s\S]*?activeDuplicateRecoveryAnalysis\.writeGeneration[\s\S]*?cancelActiveDuplicateRecoveryAnalysis\('duplicate-recovery-inventory-changed-during-analysis'\)/
    )
    expect(source).toContain("cancelActiveDuplicateRecoveryAnalysis('duplicate-recovery-no-longer-actionable')")
    const analysisGate = source.match(
      /function automaticDuplicateRecoveryAnalysisGateClosed[\s\S]*?\n}\n/
    )?.[0] || ''
    expect(analysisGate).toContain('libraryHydrationActive > 0')
    expect(analysisGate).toContain('Boolean(libraryInitializationPromise)')
    expect(analysisGate).toContain('Boolean(libraryBacklogRecoveryPromise)')
    expect(analysisGate).not.toContain('providerLibrarySyncPromise')
    expect(analysisGate).toContain('libraryStartupChunkActive')
    const scheduledDrain = source.match(
      /function scheduleAutomaticDuplicateRecoveryAnalysis[\s\S]*?\n}\n\nasync function drainAutomaticDuplicateRecoveryAnalysis[\s\S]*?\n}\n/
    )?.[0] || ''
    expect(scheduledDrain.match(/automaticDuplicateRecoveryAnalysisGateClosed\(\)/g)).toHaveLength(2)
    expect(scheduledDrain.indexOf('automaticDuplicateRecoveryAnalysisGateClosed()')).toBeLessThan(
      scheduledDrain.indexOf('queueMicrotask')
    )
    expect(scheduledDrain.lastIndexOf('automaticDuplicateRecoveryAnalysisGateClosed()')).toBeGreaterThan(
      scheduledDrain.indexOf('async function drainAutomaticDuplicateRecoveryAnalysis')
    )
    expect(source).toMatch(
      /async function activateLibraryAt[\s\S]*?libraryRuntimePaused = false[\s\S]*?scheduleAutomaticDuplicateRecoveryAnalysis\(\)/
    )
    expect(source).toMatch(
      /async function activateLibraryAt[\s\S]*?cancelActiveDuplicateRecoveryAnalysis[\s\S]*?await duplicateRecoveryAnalysisCancellation[\s\S]*?changeConfiguredLibraryPath/
    )
    const applyHandler = source.match(
      /ipcMain\.handle\('library:applyDuplicateRecovery',[\s\S]*?\n}\)\n\nipcMain\.handle\('library:selectDirectory'/
    )?.[0] || ''
    const applyWork = source.match(
      /async function applyPreparedDuplicateRecovery[\s\S]*?\n}\n\nipcMain\.handle\('library:applyDuplicateRecovery'/
    )?.[0] || ''
    expect(applyWork).toContain('prepared.writeGeneration !== (latestLibraryTree?.writeGeneration ?? -1)')
    expect(applyWork).toContain('executeDuplicateRecoveryPlan(')
    expect(applyWork).toContain('error instanceof DuplicateRecoveryPlanExpiredError')
    expect(applyWork).toContain('requestAutomaticDuplicateRecoveryAnalysis(tree)')
    expect(applyWork).toContain("status: 'stale'")
    expect(applyHandler).toContain('if (duplicateRecoveryApplyInFlight)')
    expect(applyHandler).toContain('return duplicateRecoveryApplyInFlight.promise')
  })

  it('gives every Provider package exactly one durable checkpoint owner', () => {
    expect(source).not.toContain('scheduleProviderLibrarySynchronization')
    expect(source).not.toContain('pendingProviderLibrarySessions')
    expect(source).toContain("void runLibraryBacklogRecovery('provider')")
    expect(source).toContain('withCanonicalProviderRefreshBarrier(synchronize)')
    expect(libraryWorker).toContain('closeCanonicalSessionStore()')
    expect(manager).toContain('if (stored.tombstone)')
    expect(manager).toContain('completeCurrentLibraryProjections(plan, sessions, sessionMeta)')
    expect(manager).toContain("code: 'PROVIDER_SESSION_ALREADY_ARCHIVED'")
  })

  it('keeps duplicate analysis filesystem paths behind a stable error-code boundary', () => {
    expect(duplicateWorker).toContain('errorCode: duplicateRecoveryErrorCode(error)')
    expect(duplicateWorker).not.toContain('error instanceof Error ? error.message')
    expect(source).toContain('duplicateRecoveryErrorCode(error)')
  })

  it('keeps identity conflicts out of retry and treats busy filesystem codes as transient', () => {
    const classifier = manager.match(
      /function classifyStartupSessionFailure[\s\S]*?\n}\n/
    )?.[0] || ''
    expect(classifier).toContain("code === 'SESSION_IDENTITY_CONFLICT'")
    expect(classifier).toContain("code === 'EAGAIN'")
    expect(classifier).toContain("code === 'EBUSY'")
    expect(classifier).toContain("disposition: handled ? 'handled' : 'failed'")
  })
})
