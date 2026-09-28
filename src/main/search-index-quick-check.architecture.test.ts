import * as fs from 'node:fs'
import * as path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * F1d-3 ②: PRAGMA quick_check reads every page of search.db in one
 * synchronous native call (5.5 s on a real 594 MiB index) that nothing can
 * interrupt, so it may run only in the library worker thread, never in a
 * function the main thread reaches (search-index.ts' getDatabase,
 * getReadOnlyDatabase, probeSearchProjection, …). This file pins that by the
 * sources' text; being text, it cannot show the runtime property itself,
 * which search-index-integrity.test.ts shows (⑥: the main thread answers a
 * search within 1 s while a check holds the worker). It also pins where the
 * app's backups are deleted: pruneProgramBackups only.
 */

const repositoryRoot = path.resolve(__dirname, '..', '..')

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' || entry.name.startsWith('__') ? [] : sourceFiles(entryPath)
    }
    if (!/\.(?:ts|tsx|cjs|mjs|js)$/.test(entry.name) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) return []
    // Declarations carry no code that runs.
    if (/\.d\.[cm]?ts$/.test(entry.name)) return []
    return [entryPath]
  })
}

const productionSources = [
  ...sourceFiles(path.join(repositoryRoot, 'src')),
  ...sourceFiles(path.join(repositoryRoot, 'packages', 'core', 'src'))
]
const read = (relative: string): string => fs.readFileSync(path.join(repositoryRoot, relative), 'utf8')
const relative = (filePath: string): string => path.relative(repositoryRoot, filePath).split(path.sep).join('/')

function body(source: string, signature: string): string {
  const start = source.indexOf(signature)
  if (start < 0) return ''
  const end = source.indexOf('\n}\n', start)
  return end < 0 ? '' : source.slice(start, end + 3)
}

const QUICK_CHECK = /quick_check|integrity_check/g

/** Code without comments (what runs; a comment may name the pragma freely). */
function code(source: string, fileName = 'source.ts'): string {
  return ts.transpileModule(source, {
    fileName,
    compilerOptions: { removeComments: true, target: ts.ScriptTarget.ES2022, allowJs: true }
  }).outputText
}

const mentions = (text: string): number => (text.match(QUICK_CHECK) || []).length

describe('F1d-3: PRAGMA quick_check stays in the library worker thread', () => {
  it('no production source but library-worker.ts names quick_check or integrity_check', () => {
    expect(productionSources.length).toBeGreaterThan(100)
    const naming = productionSources
      .filter((filePath) => mentions(code(fs.readFileSync(filePath, 'utf8'), path.basename(filePath))) > 0)
      .map(relative)
    expect(naming).toEqual(['src/main/library-worker.ts'])
  })

  it('in library-worker.ts it lives only in a worker-thread function the main thread cannot import or call', () => {
    const worker = read('src/main/library-worker.ts')
    const check = body(worker, 'async function checkSearchIndexIntegrityInWorker(')
    expect(check).toMatch(/^async function checkSearchIndexIntegrityInWorker\(trigger: string\): Promise<SearchIndexIntegrityOutcome> \{\n\s*if \(isMainThread\) throw new Error\(/)
    expect(mentions(code(check))).toBeGreaterThan(0)
    expect(mentions(code(worker))).toBe(mentions(code(check)))
    // Not exported; its one caller is the worker request handler.
    expect(worker).not.toMatch(/export\s+(?:async\s+)?function\s+checkSearchIndexIntegrityInWorker/)
    expect(worker.match(/checkSearchIndexIntegrityInWorker\(/g)).toHaveLength(2)
    expect(body(worker, 'export async function runLibraryWorkerRequest(')).toContain(
      "if (request.type === 'search-integrity-check') {\n    return { kind: 'search-integrity-check', value: await checkSearchIndexIntegrityInWorker(request.trigger) }"
    )
    // Requests run in-process only in the worker's own message loop.
    const callers = productionSources.filter((filePath) => fs.readFileSync(filePath, 'utf8').includes('runLibraryWorkerRequest('))
    expect(callers.map(relative)).toEqual(['src/main/library-worker.ts'])
    expect(worker.match(/runLibraryWorkerRequest\(/g)).toHaveLength(2)
    expect(worker.slice(worker.indexOf('if (!isMainThread && parentPort) {'))).toContain('await runLibraryWorkerRequest(request,')
  })

  it('the main thread\'s search index functions never run it, and main-thread modules only ask the worker for it', () => {
    const index = read('src/main/search-index.ts')
    for (const signature of [
      'function getDatabase(',
      'function getReadOnlyDatabase(',
      'export function probeSearchProjection(',
      'function withReadOnlyDatabase<T>(',
      'export function searchFTS(',
      'function repairCorruptSearchIndex('
    ]) {
      const text = body(index, signature)
      expect(text, signature).not.toBe('')
      expect(mentions(text), signature).toBe(0)
    }
    for (const file of ['src/main/index.ts', 'src/main/session-search.ts', 'src/main/search-index.ts', 'src/main/search-index-writer.ts']) {
      expect(read(file), file).not.toContain('checkSearchIndexIntegrityInWorker')
    }
    // The coordinator asks the worker port; a writer on this thread has no check at all.
    const writer = read('src/main/search-index-writer.ts')
    expect(body(writer, 'export class WorkerSearchIndexWritePort')).toContain('worker.checkSearchIndexIntegrity(trigger)')
    expect(body(writer, 'class InProcessSearchIndexWritePort')).not.toContain('checkIntegrity')
  })

  it('index.ts: a query that met a corrupt index asks the worker for a check; backups are pruned once, a minute after launch', () => {
    const main = read('src/main/index.ts')
    const start = main.indexOf("process.on('swob:search-index-event'")
    const handler = main.slice(start, main.indexOf('\n})\n', start) + 4)
    expect(handler).toContain(
      "if (name === 'search-index-read-corrupt' && !runtimeShuttingDown) {\n    void getSearchIndexWriteCoordinator().requestIntegrityCheck(`read-${String(fields.operation)}`)"
    )
    expect(main.match(/requestIntegrityCheck\(/g)).toHaveLength(1)

    const startup = body(main, 'async function continueStartupAfterLibraryGate(')
    expect(startup).toMatch(/const programBackupPrune = setTimeout\(\(\) => \{\n\s*if \(runtimeShuttingDown\) return\n\s*try \{\n\s*pruneProgramBackups\(\{ log: writeLifecycleLog \}\)/)
    expect(startup).toContain('}, 60_000)\n  programBackupPrune.unref?.()')
  })

  it('Swob\'s backups are deleted in one place: pruneProgramBackups; a repair moves, never deletes', () => {
    const callers = productionSources.filter((filePath) => /pruneProgramBackups\(/.test(fs.readFileSync(filePath, 'utf8')))
      .map(relative).sort()
    expect(callers).toEqual(['src/main/index.ts', 'src/main/program-backups.ts', 'src/main/search-index.ts'])
    const index = read('src/main/search-index.ts')
    expect(index).not.toMatch(/\b(?:unlink|rm|rmdir)(?:Sync)?\(/)
    // After a repair, only when its copy was checked whole, and naming that copy.
    const repair = body(index, 'function repairCorruptSearchIndex(')
    expect(repair).toMatch(/if \(complete\) \{\n\s*try \{\n\s*pruneProgramBackups\(\{\n\s*log: \(event, details\) => emitSearchIndexEvent\(\{ event, \.\.\.details \}\),\n\s*verifiedSearchIndexBackup: backupFileName/)
    const backups = read('src/main/program-backups.ts')
    expect(backups.match(/\b(?:unlink|rm|rmdir)(?:Sync)?\(/g)).toEqual(['unlinkSync('])
    expect(body(backups, 'export function pruneProgramBackups(')).toMatch(
      /assertProgramBackupFile\(backup\.kind, filePath\)[\s\S]*options\.log\('program-backup-deleting', fields\)[\s\S]*fs\.unlinkSync\(filePath\)\n\s*options\.log\('program-backup-deleted', fields\)/
    )
  })
})
