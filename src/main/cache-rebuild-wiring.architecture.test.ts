import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

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
