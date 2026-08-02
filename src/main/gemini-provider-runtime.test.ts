import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeCanonicalSessionStore, getCanonicalSessionStore } from './canonical-store'
import { CANONICAL_RECORDS_FILE } from './canonical-package'
import { ProviderHost } from './provider-host'
import { refreshCanonicalProviders } from './provider-runtime'
import { createGeminiProvider } from './providers/gemini-provider'
import { closeSearchIndex, searchFTS } from './search-index'

const fixtureHome = path.resolve(__dirname, '../../testdata/gemini/home')
const mainId = '11111111-1111-4111-8111-111111111111'
let root = ''
let home = ''
let libraryRoot = ''
let previousSearchRoot: string | undefined
let previousCanonicalRoot: string | undefined
let library: typeof import('./library-manager')

function packageDirs(): string[] {
  return fs.readdirSync(libraryRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => path.join(libraryRoot, entry.name))
    .filter((directory) => fs.existsSync(path.join(directory, '.swob-session.json')))
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-gemini-runtime-'))
  home = path.join(root, 'home')
  libraryRoot = path.join(root, 'Library')
  fs.cpSync(fixtureHome, home, { recursive: true })
  previousSearchRoot = process.env.SWOB_SEARCH_INDEX_DIR
  previousCanonicalRoot = process.env.SWOB_CANONICAL_STORE_DIR
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
  if (previousSearchRoot === undefined) delete process.env.SWOB_SEARCH_INDEX_DIR
  else process.env.SWOB_SEARCH_INDEX_DIR = previousSearchRoot
  if (previousCanonicalRoot === undefined) delete process.env.SWOB_CANONICAL_STORE_DIR
  else process.env.SWOB_CANONICAL_STORE_DIR = previousCanonicalRoot
  fs.rmSync(root, { recursive: true, force: true })
})

describe('Gemini CLI canonical product chain', () => {
  it('feeds sidebar, detail, Search and Vault from native v2 without v1 outcomes', async () => {
    const store = getCanonicalSessionStore()
    const host = new ProviderHost({ runtimes: [], v2Runtimes: [createGeminiProvider({ homeDir: home })] })
    const result = await refreshCanonicalProviders({ host, store, archive: true })

    expect(result.reports).toHaveLength(1)
    expect(result.reports[0]).toMatchObject({
      providerId: 'swob/gemini', runtimeProtocolVersion: 2, outcomes: [], errors: []
    })
    expect(result.changedSessionRecordIds).toHaveLength(3)
    expect(store.listSessions('swob/gemini')).toHaveLength(3)
    expect(searchFTS('gemini-synthetic-search-needle')).toHaveLength(1)
    expect(searchFTS('Visible answer')).toHaveLength(1)
    expect(packageDirs()).toHaveLength(3)

    const stored = store.listSessions('swob/gemini')
      .find((entry) => entry.sessionRecord.sourceSessionId === mainId)!
    expect(stored.sessionRecord).toMatchObject({
      providerTitle: 'Synthetic Gemini JSONL session',
      projectPath: '/workspace/synthetic-gemini',
      cwd: ['/workspace/synthetic-gemini']
    })
    const packageDirectory = packageDirs().find((directory) => {
      const meta = JSON.parse(fs.readFileSync(path.join(directory, '.swob-session.json'), 'utf8'))
      return meta.logicalIdentity?.sessionId === mainId
    })!
    const recordsPath = path.join(packageDirectory, CANONICAL_RECORDS_FILE)
    const detail = await (await import('./session-loader')).loadSessionDetail(recordsPath)
    expect(detail).toMatchObject({ source: 'gemini', projectPath: '/workspace/synthetic-gemini' })
    expect(detail?.messages.some((message) => message.textContent.includes('The inspection is complete.'))).toBe(true)
    expect(detail?.messages.some((message) => message.textContent.includes('Persisted private reasoning block.'))).toBe(true)
    expect(detail?.messages.flatMap((message) => message.toolCalls)).toContainEqual(expect.objectContaining({
      name: 'read_file', result: '{"output":"gemini-synthetic-search-needle"}'
    }))
    expect(detail?.tokenAccounting).toMatchObject({
      provider: 'gemini', provenance: 'reported', billingTotal: 397
    })
    expect(library.getSessionResumeAvailability(mainId, detail || undefined)).toMatchObject({ canResume: true })
  }, 20_000)
})
