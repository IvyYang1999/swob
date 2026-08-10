import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { StorageRoot } from '../../shared/contracts/truth-kernel'
import { scanStorageRootReadOnly } from './root-scanner'

const root = (overrides: Partial<StorageRoot> = {}): StorageRoot => ({ schemaVersion: 1, rootId: 'root', displayName: 'Root', kind: 'external-folder', capability: 'read-only', layoutPolicy: 'preserve-user-layout', includeRules: [], excludeRules: [], isDefaultArchiveTarget: false, ...overrides })
const manifest = (id: number) => JSON.stringify({ schemaVersion: 3, packageId: `package-${id}`, sessionId: `session-${id}`, logicalIdentity: { schemaVersion: 1, sourceFamily: 'claude', sourceInstance: { kind: 'default', id: 'default' }, sessionId: `session-${id}` }, sourceFilePaths: [], projectPath: 'project' })

describe('scanStorageRootReadOnly', () => {
  it('honors include/exclude rules, rejects malformed manifests, and reports partial budgets honestly', () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-root-scan-'))
    try {
      for (const relative of ['included/good', 'included/excluded/nope', 'outside/nope']) fs.mkdirSync(path.join(temporary, relative), { recursive: true })
      fs.writeFileSync(path.join(temporary, 'included/good/.swob-session.json'), manifest(1))
      fs.writeFileSync(path.join(temporary, 'included/excluded/nope/.swob-session.json'), '{bad')
      fs.writeFileSync(path.join(temporary, 'outside/nope/.swob-session.json'), manifest(2))
      const result = scanStorageRootReadOnly(root({ includeRules: ['included'], excludeRules: ['included/excluded'] }), temporary, 'device')
      expect(result.entries.map((item) => item.session.logicalSessionId)).toEqual(['session-1'])
      expect(result.complete).toBe(true)
      const limited = scanStorageRootReadOnly(root(), temporary, 'device', undefined, { maxEntries: 1 })
      expect(limited.complete).toBe(false); expect(limited.observation.scanState).toBe('partial')
    } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
  })

  it('requires a matching stable root marker for managed-container roots', () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-root-marker-'))
    try {
      expect(scanStorageRootReadOnly(root({ layoutPolicy: 'managed-containers' }), temporary, 'device').diagnostics).toContain('root-marker-missing')
      fs.mkdirSync(path.join(temporary, '.swob'), { recursive: true })
      fs.writeFileSync(path.join(temporary, '.swob/root.json'), JSON.stringify({ schemaVersion: 1, rootId: 'wrong', kind: 'external-folder', layoutPolicy: 'managed-containers' }))
      expect(scanStorageRootReadOnly(root({ layoutPolicy: 'managed-containers' }), temporary, 'device').diagnostics).toContain('root-marker-mismatch')
    } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
  })

  it('completes the 10k-package gate within explicit entry and manifest bounds', () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-root-10k-'))
    try {
      for (let index = 0; index < 10_000; index += 1) {
        const directory = path.join(temporary, String(index)); fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, '.swob-session.json'), manifest(index))
      }
      const started = performance.now()
      const result = scanStorageRootReadOnly(root(), temporary, 'device', undefined, { maxEntries: 20_001, maxManifests: 10_000 })
      expect(result.complete).toBe(true); expect(result.entries).toHaveLength(10_000); expect(performance.now() - started).toBeLessThan(10_000)
    } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
  }, 20_000)
})
