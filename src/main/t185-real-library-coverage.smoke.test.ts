import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { getConfiguredLibraryPath, initLibrary, scanLibrary, type LibraryFolder } from './library-manager'
import { loadAllSessions } from './session-loader'
import { valueUsageEvents, previewUsageEventsCandidateRepricing } from './token-valuation'
import type { PriceCandidateSnapshot } from './pricing-catalog'

const realLibraryIt = process.env.SWOB_T185_REAL_LIBRARY === '1' ? it : it.skip

describe('t185 real library coverage (read-only)', () => {
  realLibraryIt('explicit candidate what-if materially reduces unpriced token share', async () => {
    initLibrary(getConfiguredLibraryPath(), { readOnly: true })
    const library = scanLibrary()
    const packageCount = (folder: LibraryFolder): number =>
      folder.sessions.length + folder.children.reduce((sum, child) => sum + packageCount(child), 0)
    const libraryPackages = library.ungroupedSessions.length +
      library.folders.reduce((sum, folder) => sum + packageCount(folder), 0)
    const sessions = await loadAllSessions({ readOnly: true, quiet: true })
    const events = sessions.flatMap((session) => session.tokenAccounting?.usageEvents || [])
    const candidate = JSON.parse(fs.readFileSync(
      path.join(process.cwd(), 'pricing', 'candidates', 'pending-review.json'),
      'utf8'
    )) as PriceCandidateSnapshot
    const before = valueUsageEvents(events)
    const after = previewUsageEventsCandidateRepricing(events, candidate)
    const beforeUnpricedPercent = 100 - before.coveragePercent
    const afterUnpricedPercent = 100 - after.coveragePercent

    expect(libraryPackages).toBeGreaterThanOrEqual(1_800)
    expect(after.whatIf).toBe(true)
    expect(afterUnpricedPercent).toBeLessThan(beforeUnpricedPercent - 5)

    // Aggregate-only output: no session IDs, paths, prompts or transcript content.
    console.info(JSON.stringify({
      gate: 't185-real-library-coverage',
      libraryPackages,
      logicalSessions: sessions.length,
      usageEvents: events.length,
      candidateRevision: candidate.revision,
      candidateHash: candidate.contentHash,
      before: {
        coveredTokens: before.coveredTokens,
        totalBillableTokens: before.totalBillableTokens,
        coveragePercent: before.coveragePercent,
        unpricedPercent: beforeUnpricedPercent,
        missingReasons: before.missingReasons
      },
      after: {
        coveredTokens: after.coveredTokens,
        totalBillableTokens: after.totalBillableTokens,
        coveragePercent: after.coveragePercent,
        unpricedPercent: afterUnpricedPercent,
        missingReasons: after.missingReasons
      },
      improvementPercentagePoints: beforeUnpricedPercent - afterUnpricedPercent
    }))
  }, 180_000)
})
