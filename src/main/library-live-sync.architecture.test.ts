import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

const source = fs.readFileSync(path.join(__dirname, 'index.ts'), 'utf8')
const manager = fs.readFileSync(path.join(__dirname, 'library-manager.ts'), 'utf8')

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
    const applyHandler = source.match(
      /ipcMain\.handle\('library:applyDuplicateRecovery',[\s\S]*?\n}\)\n\nipcMain\.handle\('library:selectDirectory'/
    )?.[0] || ''
    expect(applyHandler).toContain('error instanceof DuplicateRecoveryMutationIncompleteError')
    expect(applyHandler.indexOf('closeLibraryWriterRuntime()')).toBeGreaterThan(-1)
    expect(applyHandler.indexOf('const shutdown = cleanupRuntimeResources()')).toBeGreaterThan(
      applyHandler.indexOf('closeLibraryWriterRuntime()')
    )
    expect(applyHandler.indexOf('const shutdown = cleanupRuntimeResources()')).toBeGreaterThan(-1)
    expect(applyHandler.indexOf('dialog.showErrorBox(')).toBeGreaterThan(
      applyHandler.indexOf('const shutdown = cleanupRuntimeResources()')
    )
  })
})
