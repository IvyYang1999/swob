import * as fs from 'node:fs'
import * as path from 'node:path'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

/**
 * F1d-2 wiring in index.ts. vitest cannot import index.ts (it registers
 * ipcMain and app at the top level), so, as for F1f and F1g, the wiring is
 * pinned by text here and driven end to end by e2e/f1d2-cache-rebuild.spec.ts.
 */

const source = fs.readFileSync(path.join(__dirname, 'index.ts'), 'utf8')

function body(signature: string): string {
  const start = source.indexOf(signature)
  if (start < 0) return ''
  const end = source.indexOf('\n}\n', start)
  return end < 0 ? '' : source.slice(start, end + 3)
}

/**
 * Evaluate functions of index.ts from its own text (types stripped), with
 * their free names bound to `scope`: the real code, without importing the
 * Electron entry. null while one of them is missing.
 */
function evaluate<T>(names: string[], scope: Record<string, unknown>, prelude = ''): T | null {
  const sources = names.map((name) => body(`function ${name}(`))
  if (sources.some((text) => !text)) return null
  const javascript = ts.transpileModule(sources.join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  const factory = new Function(...Object.keys(scope), `${prelude}\n${javascript}\nreturn ${names[names.length - 1]}`)
  return factory(...Object.values(scope)) as T
}

describe('F1d-2 lineage registry wiring', () => {
  it('writes every rebuilt registry through the guarded writer and never over one it cannot read', () => {
    const persist = body('async function persistLineageRegistry(')
    expect(persist).toContain("if (expected.state === 'unreadable')")
    expect(persist).toContain(
      'withLibraryMaintenanceWriter(() => writeSessionLineageRegistry(registry, registryPath, { expected }))'
    )
    expect(persist).toContain('error instanceof LineageRegistryWriteRefusedError')
    for (const event of ['lineage-registry-rebuilt', 'lineage-alias-dropped', 'lineage-resolution-stale']) {
      expect(persist).toContain(`writeLifecycleLog('${event}'`)
    }
    expect(persist).toContain('logLineageRegistryRefused(')
    // The guarded writer is the only one: no direct call anywhere else.
    expect(source.match(/writeSessionLineageRegistry\(/g)).toHaveLength(1)

    const load = body('async function loadSessionLineageRegistry(')
    expect(load).toMatch(
      /const before = readLineageRegistrySnapshot\(registryPath\)\n\s*const registry = await rebuildSessionLineageRegistry\(libraryRoot\)/
    )
    expect(load).toContain("await persistLineageRegistry(registry, registryPath, before, 'no-registry')")
  })

  it('rebuilds a registry derived under another summary-cache version once, after the first writable load', () => {
    const settle = body('function settleProviderBootstrap(')
    expect(settle).toMatch(/void completion\.then\([\s\S]*?\n\s*refreshLineageRegistryDerivation\(\)\n\s*\}\)\.catch\(/)
    // Only the completion of the writable load starts it.
    expect(source.match(/\n\s+refreshLineageRegistryDerivation\(\)\n/g)).toHaveLength(1)

    const refresh = body('function refreshLineageRegistryDerivation(')
    expect(refresh).toContain('if (lineageDerivationCheckedRoot === libraryRoot || lineageRegistryLoadPromise) return')
    expect(refresh).toContain('const before = readLineageRegistrySnapshot(registryPath)')
    expect(refresh).toContain("if (before.state === 'missing') return")
    expect(refresh).toMatch(/if \(before\.state === 'unreadable'\) \{\n\s*logLineageRegistryRefused\(/)
    expect(refresh).toContain('summaryCacheVersion === SUMMARY_CACHE_VERSION')
    expect(refresh).toContain("persistLineageRegistry(registry, registryPath, before, 'derivation')")
    expect(refresh).toContain('if (getLibraryRoot() !== libraryRoot)')
  })
})

interface SummaryProbe {
  state: 'current' | 'stale' | 'missing' | 'unreadable'
  version: number | null
  rows: number | null
  legacyJson: boolean
}
type SearchProbe = { legacyRows: number; staleLegacyRows: number } | null

const CURRENT: SummaryProbe = { state: 'current', version: 30, rows: 12, legacyJson: false }
const STALE: SummaryProbe = { state: 'stale', version: 29, rows: 12, legacyJson: false }

function startupPlanner(summary: SummaryProbe, search: SearchProbe, searchIndexExists = search !== null) {
  const scope = {
    probeSummaryCache: vi.fn(() => summary),
    probeSearchProjection: vi.fn(() => search),
    searchDatabasePath: () => '/fixtures/f1d2-state/search.db',
    fs: { existsSync: vi.fn(() => searchIndexExists) },
    startupProjectionGate: { prepareStartup: vi.fn() },
    writeLifecycleLog: vi.fn(),
    SUMMARY_CACHE_VERSION: 30,
    SEARCH_PROJECTION_VERSION: 2
  }
  const plan = evaluate<() => { reasons: string[]; startedAt: number } | null>(
    ['startupCacheRebuildReasons', 'planStartupCacheRebuild'],
    scope,
    'let startupCacheProbed = false'
  )
  return { plan, ...scope }
}

describe('F1d-2 deterministic startup rebuild (planStartupCacheRebuild evaluated from index.ts)', () => {
  it('a probe that finds rows of another projection calls prepareStartup(true) exactly once, and probes once per process', () => {
    const planner = startupPlanner(CURRENT, { legacyRows: 4, staleLegacyRows: 3 })
    expect(planner.plan).not.toBeNull()
    expect(planner.plan!()).toMatchObject({ reasons: ['search-projection-version'] })
    expect(planner.startupProjectionGate.prepareStartup.mock.calls).toEqual([[true]])
    expect(planner.writeLifecycleLog).toHaveBeenCalledTimes(1)
    expect(planner.writeLifecycleLog).toHaveBeenCalledWith('cache-rebuild-started', expect.objectContaining({
      reasons: ['search-projection-version'],
      searchProjection: { legacyRows: 4, staleLegacyRows: 3 },
      searchProjectionVersion: 2
    }))
    // A later load of this process never probes or upgrades again.
    expect(planner.plan!()).toBeNull()
    expect(planner.probeSummaryCache).toHaveBeenCalledTimes(1)
    expect(planner.probeSearchProjection).toHaveBeenCalledTimes(1)
    expect(planner.startupProjectionGate.prepareStartup).toHaveBeenCalledTimes(1)
  })

  it('a summary cache written under another version calls prepareStartup(true) once', () => {
    const planner = startupPlanner(STALE, { legacyRows: 4, staleLegacyRows: 0 })
    expect(planner.plan).not.toBeNull()
    expect(planner.plan!()).toMatchObject({ reasons: ['summary-cache-version'] })
    expect(planner.startupProjectionGate.prepareStartup.mock.calls).toEqual([[true]])
    expect(planner.writeLifecycleLog).toHaveBeenCalledWith('cache-rebuild-started', expect.objectContaining({
      summaryCache: { state: 'stale', version: 29, rows: 12, legacyJson: false },
      summaryCacheVersion: 30
    }))
  })

  it('no rows of another projection and a current summary cache: prepareStartup is never called, nothing is logged', () => {
    const planner = startupPlanner(CURRENT, { legacyRows: 4, staleLegacyRows: 0 })
    expect(planner.plan).not.toBeNull()
    expect(planner.plan!()).toBeNull()
    expect(planner.probeSummaryCache).toHaveBeenCalledTimes(1)
    expect(planner.probeSearchProjection).toHaveBeenCalledTimes(1)
    expect(planner.startupProjectionGate.prepareStartup).not.toHaveBeenCalled()
    expect(planner.writeLifecycleLog).not.toHaveBeenCalled()
  })

  it('a search index that exists but cannot be probed is reported, not taken for up to date, and does not trigger', () => {
    const planner = startupPlanner(CURRENT, null, true)
    expect(planner.plan).not.toBeNull()
    expect(planner.plan!()).toBeNull()
    expect(planner.startupProjectionGate.prepareStartup).not.toHaveBeenCalled()
    expect(planner.writeLifecycleLog.mock.calls).toEqual([
      ['cache-probe-unreadable', { summaryCache: 'current', searchIndex: 'unreadable' }]
    ])
  })

  it('a search index that does not exist is not reported as unreadable, and does not trigger', () => {
    const planner = startupPlanner(CURRENT, null, false)
    expect(planner.plan).not.toBeNull()
    expect(planner.plan!()).toBeNull()
    expect(planner.fs.existsSync).toHaveBeenCalledWith('/fixtures/f1d2-state/search.db')
    expect(planner.startupProjectionGate.prepareStartup).not.toHaveBeenCalled()
    expect(planner.writeLifecycleLog).not.toHaveBeenCalled()
  })

  it.each([
    ['both current', CURRENT, { legacyRows: 4, staleLegacyRows: 0 }, []],
    ['summary cache of another version', STALE, { legacyRows: 4, staleLegacyRows: 0 }, ['summary-cache-version']],
    ['rows of another projection', CURRENT, { legacyRows: 4, staleLegacyRows: 4 }, ['search-projection-version']],
    ['both', STALE, { legacyRows: 4, staleLegacyRows: 1 }, ['summary-cache-version', 'search-projection-version']],
    ['only a pre-SQLite JSON cache', { ...CURRENT, state: 'missing', version: null, rows: null, legacyJson: true }, null,
      ['summary-cache-legacy-json']],
    ['a fresh install', { ...CURRENT, state: 'missing', version: null, rows: null }, null, []],
    ['an unreadable summary cache (repaired by the next write, same parser)', { ...CURRENT, state: 'unreadable' },
      { legacyRows: 4, staleLegacyRows: 0 }, []],
    ['no search.db beside a current cache (the next full sync builds it)', CURRENT, null, []],
    ['an empty index', CURRENT, { legacyRows: 0, staleLegacyRows: 0 }, []]
  ] as Array<[string, SummaryProbe, SearchProbe, string[]]>)('reasons: %s', (_label, summary, search, reasons) => {
    const decide = evaluate<(summary: SummaryProbe, search: SearchProbe) => string[]>(['startupCacheRebuildReasons'], {})
    expect(decide).not.toBeNull()
    expect(decide!(summary, search)).toEqual(reasons)
  })

  it('probes before any load of this process can write the summary cache, and tracks the rebuild to its end', () => {
    const loadHandler = source.match(/ipcMain\.handle\('sessions:loadAll'[\s\S]*?\n}\)\n/)?.[0] || ''
    expect(loadHandler).toMatch(
      /const cacheRebuild = planStartupCacheRebuild\(\)[\s\S]*?const bootstrap = await beginSessionBootstrap\(/
    )
    expect(loadHandler).toMatch(
      /scheduleSearchIndexWarmup\(\)\n\s*void scheduleUsageFactSync\(\)\n\s*if \(cacheRebuild\) trackStartupCacheRebuild\(cacheRebuild, bootstrap\.completion\)/
    )
    expect(source.match(/\bplanStartupCacheRebuild\(\)/g)).toHaveLength(2)
    // One new upgrade beside the Library migration's and the root switch's.
    expect(source.match(/startupProjectionGate\.prepareStartup\(true\)/g)).toHaveLength(3)

    // Finished means the snapshot itself settled, not the gate's queue item
    // for it (which the warmup's sibling timer may settle before it starts).
    const track = body('function trackStartupCacheRebuild(')
    expect(track).toMatch(/searchSnapshotObserver = \(snapshot\) => \{ void snapshot\.then\(resolve, reject\) \}/)
    expect(track).toContain('Promise.all([settle(summary), settle(search)])')
    expect(track).toContain('if (runtimeShuttingDown) return')
    expect(track).toContain("writeLifecycleLog('cache-rebuild-finished'")
    const warmup = body('function scheduleSearchIndexWarmupNow(')
    expect(warmup).toMatch(
      /const snapshot = getSearchIndexWriteCoordinator\(\)\.scheduleLegacySnapshot\(currentSearchSources\(\)\)\n(?:\s*\/\/[^\n]*\n)*\s*const observer = searchSnapshotObserver\n\s*searchSnapshotObserver = null\n\s*observer\?\.\(snapshot\)/
    )
    expect(source.match(/searchSnapshotObserver = /g)).toHaveLength(2)
  })
})
