import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeCanonicalSessionStore, getCanonicalSessionStore } from './canonical-store'
import { CANONICAL_RECORDS_FILE } from './canonical-package'
import { ProviderHost } from './provider-host'
import { refreshCanonicalProviders } from './provider-runtime'
import { createQoderProvider } from './providers/qoder-provider'
import { closeSearchIndex, searchFTS } from './search-index'

const fixtureRoot = path.resolve(__dirname, '../../testdata/qoder/-workspace-synthetic-qoder')
const mainSessionId = '11111111-1111-4111-8111-111111111111'

let tempRoot = ''
let homeDir = ''
let libraryRoot = ''
let previousSearchRoot: string | undefined
let previousCanonicalRoot: string | undefined
let library: typeof import('./library-manager')

function packageDirs(): string[] {
  return fs.readdirSync(libraryRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => path.join(libraryRoot, entry.name))
    .filter((directory) => fs.existsSync(path.join(directory, '.swob-session.json')))
    .sort()
}

function packageForSession(sessionId: string): string {
  const found = packageDirs().find((directory) => {
    const meta = JSON.parse(fs.readFileSync(path.join(directory, '.swob-session.json'), 'utf8'))
    return meta.logicalIdentity?.sessionId === sessionId
  })
  if (!found) throw new Error(`missing Qoder package for ${sessionId}`)
  return found
}

beforeEach(async () => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-qoder-runtime-'))
  homeDir = path.join(tempRoot, 'home')
  libraryRoot = path.join(tempRoot, 'Library')
  const projectsRoot = path.join(homeDir, '.qoder', 'projects')
  fs.mkdirSync(projectsRoot, { recursive: true })
  fs.cpSync(fixtureRoot, path.join(projectsRoot, '-workspace-synthetic-qoder'), { recursive: true })

  previousSearchRoot = process.env.SWOB_SEARCH_INDEX_DIR
  previousCanonicalRoot = process.env.SWOB_CANONICAL_STORE_DIR
  process.env.SWOB_SEARCH_INDEX_DIR = path.join(tempRoot, 'search')
  process.env.SWOB_CANONICAL_STORE_DIR = path.join(tempRoot, 'canonical-store')
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
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

describe('Qoder canonical product chain', () => {
  it('runs native v2 through host, list/detail, search, Library, replace, and tombstone', async () => {
    const store = getCanonicalSessionStore()
    const host = new ProviderHost({
      runtimes: [],
      v2Runtimes: [createQoderProvider({ homeDir })]
    })

    const first = await refreshCanonicalProviders({ host, store, archive: true })
    expect(first.reports).toHaveLength(1)
    expect(first.reports[0].errors).toHaveLength(0)
    expect(first.reports[0].v2Manifest).toMatchObject({
      schemaVersion: 2,
      providerId: 'swob/qoder'
    })
    expect(first.reports[0].v2Chunks).not.toHaveLength(0)
    expect(first.changedSessionRecordIds).toHaveLength(2)
    expect(store.listSessions('swob/qoder')).toHaveLength(2)
    expect(searchFTS('qoder-synthetic-search-needle')).toHaveLength(1)
    expect(searchFTS('Inspect the synthetic Qoder fixture')).toHaveLength(1)
    expect(packageDirs()).toHaveLength(2)

    const mainStored = store.listSessions('swob/qoder')
      .find((session) => session.sessionRecord.sourceSessionId === mainSessionId)!
    expect(mainStored.sessionRecord).toMatchObject({
      providerTitle: 'Synthetic Qoder compound session',
      cwd: ['/workspace/synthetic-qoder'],
      projectPath: '/workspace/synthetic-qoder'
    })
    const mainPackage = packageForSession(mainSessionId)
    const recordsPath = path.join(mainPackage, CANONICAL_RECORDS_FILE)
    expect(fs.existsSync(recordsPath)).toBe(true)
    expect(fs.existsSync(path.join(mainPackage, 'backup.jsonl'))).toBe(false)
    const detail = await (await import('./session-loader')).loadSessionDetail(recordsPath)
    expect(detail?.messages.some((message) =>
      message.textContent.includes('The synthetic Qoder inspection is complete.'))).toBe(true)
    expect(detail?.messages.some((message) =>
      message.textContent.includes('[Thinking]\nPlan the synthetic inspection'))).toBe(true)
    const calls = detail?.messages.flatMap((message) => message.toolCalls) || []
    expect(calls).toContainEqual(expect.objectContaining({
      name: 'Read',
      input: { file_path: '/workspace/synthetic-qoder/README.md' },
      result: 'qoder-synthetic-search-needle'
    }))
    expect(detail?.tokenAccounting).toMatchObject({
      provenance: 'unavailable',
      billingTotal: null,
      conversationOnly: null,
      components: null
    })

    const mainIdentity = first.reports[0].v2Chunks
      .find((chunk) => chunk.identity.logicalSessionId === mainSessionId)!.identity
    expect(store.getV2Session(mainIdentity.logicalSessionKey, mainIdentity.branchViewId)).toMatchObject({
      complete: true,
      tombstoneReason: null
    })

    const unchanged = await refreshCanonicalProviders({ host, store, archive: true })
    expect(unchanged.changedSessionRecordIds).toHaveLength(0)
    expect(packageDirs()).toHaveLength(2)

    const sidecarPath = path.join(
      homeDir,
      '.qoder',
      'projects',
      '-workspace-synthetic-qoder',
      `${mainSessionId}-session.json`
    )
    fs.writeFileSync(sidecarPath, JSON.stringify({
      title: 'Replaced synthetic Qoder title',
      working_dir: '/workspace/synthetic-qoder',
      fork_from: '00000000-0000-4000-8000-000000000000'
    }))
    const replaced = await refreshCanonicalProviders({ host, store, archive: true })
    expect(replaced.changedSessionRecordIds).toContain(mainStored.sessionRecord.id)
    expect(packageDirs()).toHaveLength(2)
    expect(store.getSession(mainStored.sessionRecord.id)?.sessionRecord.providerTitle)
      .toBe('Replaced synthetic Qoder title')

    const transcriptPath = sidecarPath.replace(/-session\.json$/, '.jsonl')
    fs.unlinkSync(transcriptPath)
    fs.unlinkSync(sidecarPath)
    const removed = await refreshCanonicalProviders({ host, store, archive: true })
    expect(removed.tombstonedSessionRecordIds).toContain(mainStored.sessionRecord.id)
    expect(store.listSessions('swob/qoder')).toHaveLength(1)
    expect(searchFTS('qoder-synthetic-search-needle')).toHaveLength(0)
    expect(fs.existsSync(recordsPath)).toBe(true)
    const tombstonedMeta = JSON.parse(fs.readFileSync(path.join(mainPackage, '.swob-session.json'), 'utf8'))
    expect(tombstonedMeta.canonicalProvider.tombstone).toMatchObject({ reason: 'source-missing' })
  }, 20_000)
})
