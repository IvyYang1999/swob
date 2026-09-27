import * as fs from 'node:fs'
import * as path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * F1d-3 wiring in index.ts. vitest cannot import index.ts (it registers
 * ipcMain and app at the top level), so, as for F1d-2, the wiring is pinned
 * by its text and its functions are evaluated from that text. What the
 * events carry, and how they cross from the worker, is tested in
 * search-index-repair.test.ts and search-index-worker-repair.test.ts.
 */

const source = fs.readFileSync(path.join(__dirname, 'index.ts'), 'utf8')

function body(signature: string): string {
  const start = source.indexOf(signature)
  if (start < 0) return ''
  const end = source.indexOf('\n}\n', start)
  return end < 0 ? '' : source.slice(start, end + 3)
}

/** Evaluate functions of index.ts from its own text (types stripped), their free names bound to `scope`. */
function evaluate<T>(names: string[], scope: Record<string, unknown>): T | null {
  const sources = names.map((name) => body(`function ${name}(`))
  if (sources.some((text) => !text)) return null
  const javascript = ts.transpileModule(sources.join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  const factory = new Function(...Object.keys(scope), `${javascript}\nreturn ${names[names.length - 1]}`)
  return factory(...Object.values(scope)) as T
}

describe('F1d-3 search index repair wiring', () => {
  it('writes every search index event, from either thread, to lifecycle.log and re-projects a repaired index', () => {
    expect(source.match(/process\.on\('swob:search-index-event'/g)).toHaveLength(1)
    const start = source.indexOf("process.on('swob:search-index-event'")
    const handler = source.slice(start, source.indexOf('\n})\n', start) + 4)
    expect(handler).toMatch(/\(event: SearchIndexEvent\) => \{\n\s*const \{ event: name, \.\.\.fields \} = event\n\s*writeLifecycleLog\(name, fields\)\n/)
    expect(handler).toContain("if (name === 'search-index-repaired') reprojectRepairedSearchIndex()")
  })

  it('hands every current source and canonical session to the writer after a repair, never before the first load or at quit', async () => {
    const run = async (state: { shuttingDown: boolean; ready: boolean }): Promise<string[]> => {
      const calls: string[] = []
      const reproject = evaluate<() => void>(['reprojectRepairedSearchIndex'], {
        runtimeShuttingDown: state.shuttingDown,
        librarySessionInventoryReady: state.ready,
        getSearchIndexWriteCoordinator: () => ({
          scheduleLegacySnapshot: (sources: Array<{ filePath: string }>) => {
            calls.push(`legacy:${sources.map((item) => item.filePath).join(',')}`)
            return Promise.resolve()
          }
        }),
        currentSearchSources: () => [{ filePath: 'a.jsonl' }, { filePath: 'b.jsonl' }],
        reconcileCanonicalProviderProjection: () => {
          calls.push('canonical')
          return Promise.resolve()
        },
        notifySearchIndexUpdated: () => { calls.push('notify') },
        console
      })
      expect(reproject).not.toBeNull()
      reproject!()
      await new Promise((resolve) => setImmediate(resolve))
      return calls
    }
    expect(await run({ shuttingDown: false, ready: true })).toEqual(['legacy:a.jsonl,b.jsonl', 'canonical', 'notify'])
    expect(await run({ shuttingDown: false, ready: false })).toEqual([])
    expect(await run({ shuttingDown: true, ready: true })).toEqual([])
  })
})
