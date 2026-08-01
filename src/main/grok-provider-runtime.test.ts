import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { providerCapabilitiesForSource } from '../shared/provider-capabilities'
import { closeCanonicalSessionStore, getCanonicalSessionStore } from './canonical-store'
import { CANONICAL_RECORDS_FILE } from './canonical-package'
import { ProviderHost } from './provider-host'
import { refreshCanonicalProviders } from './provider-runtime'
import { createGrokProvider } from './providers/grok-provider'
import { closeSearchIndex, searchFTS } from './search-index'

let root = ''
let home = ''
let libraryRoot = ''
let previousHome: string | undefined
let previousSearchRoot: string | undefined
let previousCanonicalRoot: string | undefined
let library: typeof import('./library-manager')
const SOURCE_SESSION_ID_FOR_TEST = '11111111-2222-7333-8444-555555555555'

function fixtureDirectory(): string {
  return path.resolve(__dirname, '../../testdata/grok/compacted-session')
}

function packageDirs(): string[] {
  return fs.readdirSync(libraryRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => path.join(libraryRoot, entry.name))
    .filter((directory) => fs.existsSync(path.join(directory, '.swob-session.json')))
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-grok-runtime-'))
  home = path.join(root, 'home')
  libraryRoot = path.join(root, 'Library')
  previousHome = process.env.HOME
  previousSearchRoot = process.env.SWOB_SEARCH_INDEX_DIR
  previousCanonicalRoot = process.env.SWOB_CANONICAL_STORE_DIR
  process.env.HOME = home
  process.env.SWOB_SEARCH_INDEX_DIR = path.join(root, 'search')
  process.env.SWOB_CANONICAL_STORE_DIR = path.join(root, 'canonical-store')
  closeSearchIndex()
  closeCanonicalSessionStore()
  library = await import('./library-manager')
  library.initLibrary(libraryRoot)
  library.scanLibrary()
})

afterEach(() => {
  closeSearchIndex()
  closeCanonicalSessionStore()
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  if (previousSearchRoot === undefined) delete process.env.SWOB_SEARCH_INDEX_DIR
  else process.env.SWOB_SEARCH_INDEX_DIR = previousSearchRoot
  if (previousCanonicalRoot === undefined) delete process.env.SWOB_CANONICAL_STORE_DIR
  else process.env.SWOB_CANONICAL_STORE_DIR = previousCanonicalRoot
  fs.rmSync(root, { recursive: true, force: true })
})

describe('Grok Build native-v2 consumer chain', () => {
  it('feeds sidebar, Search and Vault from validated v2 chunks while Resume stays fail-closed', async () => {
    const grokRoot = path.join(home, '.grok', 'sessions')
    const sessionDir = path.join(grokRoot, '%2Fworkspace%2Fsynthetic', '11111111-2222-7333-8444-555555555555')
    fs.mkdirSync(path.dirname(sessionDir), { recursive: true })
    fs.cpSync(fixtureDirectory(), sessionDir, { recursive: true })
    const provider = createGrokProvider({ homeDir: home, roots: [grokRoot] })
    const host = new ProviderHost({ runtimes: [], v2Runtimes: [provider] })
    const store = getCanonicalSessionStore()

    const first = await refreshCanonicalProviders({ host, store, archive: true })

    expect(first.reports[0]).toMatchObject({
      providerId: 'swob/grok',
      runtimeProtocolVersion: 2,
      outcomes: [],
      errors: []
    })
    expect(first.reports[0].consumerProjections).toHaveLength(1)
    expect(first.changedSessionRecordIds).toHaveLength(1)
    const stored = store.getSession(first.changedSessionRecordIds[0])!
    expect(stored.sessionRecord).toMatchObject({
      providerTitle: 'Build a truthful Grok provider',
      projectPath: '/workspace/swob-grok-fixture',
      cwd: ['/workspace/swob-grok-fixture']
    })
    const identity = first.reports[0].v2Chunks[0].identity
    expect(store.getV2Session(identity.logicalSessionKey, identity.branchViewId)).toMatchObject({
      complete: true,
      eventCount: first.reports[0].v2Chunks[0].events.length
    })
    expect(searchFTS('hello from the synthetic fixture')).toHaveLength(1)
    expect(searchFTS('implement the direct v2 parser')).toHaveLength(1)
    expect(searchFTS('Preserve reported cache')).toHaveLength(1)
    const detail = await (await import('./session-loader')).loadSessionDetail(stored.sessionRecord.sourceRef.displayLocator)
    expect(detail?.messages.map((message) => message.textContent)).toEqual(expect.arrayContaining([
      expect.stringContaining('hello from the synthetic fixture'),
      expect.stringContaining('implement the direct v2 parser')
    ]))

    expect(packageDirs()).toHaveLength(1)
    const recordsPath = path.join(packageDirs()[0], CANONICAL_RECORDS_FILE)
    const archived = fs.readFileSync(recordsPath, 'utf8')
    expect(archived).toContain('hello from the synthetic fixture')
    expect(archived).toContain('implement the direct v2 parser')
    expect(archived).toContain('src/main/providers/grok-provider.ts')
    expect(archived).toContain('grok-fixture-helper')
    const messageTexts = stored.records.flatMap((record) => record.recordType === 'message'
      ? record.content.map((content) => content.kind === 'text' || content.kind === 'thinking' ? content.text : '')
      : [])
    expect(messageTexts.indexOf('hello from the synthetic fixture'))
      .toBeLessThan(messageTexts.indexOf('implement the direct v2 parser'))

    expect(providerCapabilitiesForSource('grok')?.['terminal-resume']).toMatchObject({ status: 'unavailable' })
    expect(provider.manifest.resumeContract).toBeNull()
    expect(library.getSessionResumeAvailability(SOURCE_SESSION_ID_FOR_TEST, {
      sessionId: SOURCE_SESSION_ID_FOR_TEST,
      filePath: stored.sessionRecord.sourceRef.displayLocator,
      allFilePaths: [stored.sessionRecord.sourceRef.displayLocator],
      source: 'grok'
    })).toMatchObject({
      canResume: false,
      reason: providerCapabilitiesForSource('grok')?.['terminal-resume'].reason
    })

    fs.rmSync(sessionDir, { recursive: true, force: true })
    const removed = await refreshCanonicalProviders({ host, store, archive: true })
    expect(removed.tombstonedSessionRecordIds).toEqual(first.changedSessionRecordIds)
    expect(searchFTS('implement the direct v2 parser')).toHaveLength(0)
  })
})
