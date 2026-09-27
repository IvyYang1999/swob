import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

// index.ts bootstraps Electron at module scope and cannot be imported into a
// plain vitest run: pin its wiring the same way library-live-sync.architecture
// .test.ts does, as raw source text (F1k P2-1). usage-fact-sync-status.test.ts
// only exercises UsageFactSyncFailureTracker in isolation; none of these three
// call sites were pinned before this file.
const source = fs.readFileSync(path.join(__dirname, 'index.ts'), 'utf8')

describe('usage-fact sync failure wiring in index.ts (F1k ③a)', () => {
  const scheduleNow = source.match(
    /function scheduleUsageFactSyncNow[\s\S]*?\nasync function materializeUsageEventsForSnapshot/
  )?.[0] || ''

  it('counts a failed run in onError, but never while the runtime is shutting down', () => {
    const onError = source.match(/onError: \(error\) => \{[\s\S]*?\n      \}\n {4}\}\)/)?.[0] || ''
    expect(onError).toContain('usageFactSyncError = error')
    // The shutdown check comes first: a failure during shutdown is recorded
    // on usageFactSyncError (readiness still reflects it) but never counted
    // into the streak or logged.
    expect(onError).toMatch(/usageFactSyncError = error\n\s*if \(runtimeShuttingDown\) return/)
    expect(onError).toContain('const entry = usageFactSyncFailures.recordFailure(error)')
    expect(onError).toMatch(/const entry = usageFactSyncFailures\.recordFailure\(error\)\n\s*if \(!entry\) return/)
    expect(onError).toContain("writeLifecycleLog(entry.event, entry.fields)")
    // recordFailure must run after the shutdown return, not before it.
    expect(onError.indexOf('if (runtimeShuttingDown) return'))
      .toBeLessThan(onError.indexOf('usageFactSyncFailures.recordFailure(error)'))
  })

  it('clears the failure streak and logs a recovery entry only once a sync actually commits', () => {
    expect(scheduleNow).toMatch(
      /usageFactSyncError = null\n\s*const recovered = usageFactSyncFailures\.recordSuccess\(\)\n\s*if \(recovered\) writeLifecycleLog\(recovered\.event, recovered\.fields\)/
    )
    // recordSuccess sits after the (possibly retried) worker call commits and
    // before the renderer is notified: a run that throws never reaches it,
    // the outer catch below only re-throws.
    const successIndex = scheduleNow.indexOf('const recovered = usageFactSyncFailures.recordSuccess()')
    const notifyIndex = scheduleNow.indexOf("mainWindow?.webContents.send('insights:factsUpdated'")
    const outerCatchIndex = scheduleNow.lastIndexOf('} catch (error) {\n          usageFactSyncError = error\n          throw error')
    expect(successIndex).toBeGreaterThan(-1)
    expect(successIndex).toBeLessThan(notifyIndex)
    expect(outerCatchIndex).toBeGreaterThan(notifyIndex)
  })

  it("insights:queryBundle carries the current failure streak next to the revision-cached bundle", () => {
    const handler = source.match(/ipcMain\.handle\('insights:queryBundle',[\s\S]*?\n\}\)/)?.[0] || ''
    expect(handler).toContain('await ensureUsageFactsReady()')
    expect(handler).toContain(
      'return { ...queryInsightsBundle(scope), lastSyncError: usageFactSyncFailures.current() }'
    )
    // A fresh object each call: the revision-keyed bundle cache inside
    // queryInsightsBundle is untouched, only the IPC reply is extended.
    expect(handler).not.toMatch(/queryInsightsBundle\(scope\)\.lastSyncError/)
  })
})
