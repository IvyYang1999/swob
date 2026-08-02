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
  })

  it('uses a bounded generation cutoff instead of waiting for global live idle', () => {
    const drain = source.match(
      /async function drainLiveSessionSynchronizations\(\)[\s\S]*?\n}\n/
    )?.[0] || ''
    expect(drain).toContain('flushPendingSnapshot({ maxEntries: 2 })')
    expect(drain).not.toContain('waitForIdle')
  })
})
