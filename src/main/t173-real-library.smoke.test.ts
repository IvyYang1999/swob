import { describe, expect, it } from 'vitest'
import { buildInsights } from './insights'
import { grepTranscriptsReadOnly } from './search-index'
import { findAllSessionFiles, loadAllSessions, loadSessionDetail } from './session-loader'
import {
  getConfiguredLibraryPath,
  initLibrary,
  scanLibrary,
  type LibraryFolder
} from './library-manager'
import { parsedAnchorMessages, anchorsFromMessages } from './resume-verifier'
import { verifyResumeContractV2 } from './resume-contract-v2'
import {
  UNIFIED_PROVIDER_SOURCES,
  unifiedProviderDescriptorV2
} from '../shared/seven-source-contract-v2'

const realLibraryIt = process.env.SWOB_REAL_LIBRARY_SMOKE === '1' ? it : it.skip

describe('t173 real library smoke (read-only)', () => {
  realLibraryIt('loads 1800+ summaries and exercises read/search/resume/Insights without exposing content', async () => {
    initLibrary(getConfiguredLibraryPath(), { readOnly: true })
    const library = scanLibrary()
    const countFolderPackages = (folder: LibraryFolder): number =>
      folder.sessions.length + folder.children.reduce((total, child) => total + countFolderPackages(child), 0)
    const libraryPackages = library.ungroupedSessions.length +
      library.folders.reduce((total, folder) => total + countFolderPackages(folder), 0)
    const sessions = await loadAllSessions({ readOnly: true, quiet: true })
    const physicalSources = findAllSessionFiles()
    expect(libraryPackages).toBeGreaterThanOrEqual(1_800)
    expect(sessions.length).toBeGreaterThan(0)

    const sourceCounts = Object.fromEntries(UNIFIED_PROVIDER_SOURCES.map((source) => [
      source,
      sessions.filter((session) => session.source === source).length
    ]))
    let readableSources = 0
    let verifiedResumeSources = 0
    for (const source of UNIFIED_PROVIDER_SOURCES) {
      const sample = sessions.find((session) => session.source === source && session.detailAvailability !== 'unavailable')
      if (!sample) continue
      const detail = await loadSessionDetail(
        sample.filePath,
        sample.allFilePaths,
        sample.branchParentFilePaths,
        sample.branchPointUuid,
        sample.branchLeafUuid
      )
      if (!detail?.messages.length) continue
      readableSources++
      const anchorMessages = parsedAnchorMessages(detail.messages)
      const expectedAnchors = anchorsFromMessages(anchorMessages)
      if (!expectedAnchors.user && !expectedAnchors.assistant) continue
      const descriptor = unifiedProviderDescriptorV2(source)!
      const verification = verifyResumeContractV2(descriptor.resumeContract, {
        launched: true,
        expectedSourceRefId: detail.filePath,
        observedSourceRefId: detail.filePath,
        sourceExists: true,
        expectedAnchors,
        observedDefaultMessages: anchorMessages,
        observedAllMessages: anchorMessages
      })
      if (verification.ok) verifiedResumeSources++
    }

    const search = grepTranscriptsReadOnly('__swob_t173_deliberately_absent__', { limit: 1 })
    expect(search).toEqual([])
    const insights = buildInsights(sessions, [])
    expect(insights.detectedSessionCount).toBe(sessions.length)
    expect(readableSources).toBeGreaterThan(0)
    expect(verifiedResumeSources).toBe(readableSources)

    // Aggregate counts only; no paths, IDs, messages or search excerpts leave the process.
    console.info(JSON.stringify({
      gate: 't173-real-library',
      libraryPackages,
      physicalSources: physicalSources.length,
      logicalSessions: sessions.length,
      sourceCounts,
      readableSources,
      verifiedResumeSources,
      insightsSessions: insights.detectedSessionCount
    }))
  }, 120_000)
})
