import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { StorageRoot } from '../../shared/contracts/truth-kernel'
import type { CatalogOnboardingPreview } from '../../shared/catalog-onboarding-preview'
import { DeviceCatalog } from './device-catalog'
import { discoverCatalogOnboarding } from './onboarding-discovery'

const root = (rootId: string): StorageRoot => ({ schemaVersion: 1, rootId, displayName: rootId, kind: 'external-folder', capability: 'read-only', layoutPolicy: 'preserve-user-layout', includeRules: [], excludeRules: [], isDefaultArchiveTarget: false })
const manifest = (packageId: string, sessionId: string, provider: string, backupSize: number) => JSON.stringify({ schemaVersion: 3, packageId, sessionId, logicalIdentity: { schemaVersion: 1, sourceFamily: provider, sourceInstance: { kind: 'default', id: 'default' }, sessionId }, sourceFilePaths: [], projectPath: 'project', backupSize })
const writePackage = (rootPath: string, directory: string, content: string): void => { const packagePath = path.join(rootPath, directory); fs.mkdirSync(packagePath, { recursive: true }); fs.writeFileSync(path.join(packagePath, '.swob-session.json'), content) }

describe('discoverCatalogOnboarding', () => {
  it('does not produce a preview without read-only candidate discovery facts', () => {
    expect(discoverCatalogOnboarding([], 'device')).toEqual({ scans: [] })
    const catalog = new DeviceCatalog()
    expect(() => catalog.decideOnboarding({ previewId: 'fake', sessionCount: 999, estimatedArchiveBytes: 999, privacyScopes: ['fake'], sourceCount: 1, complete: true } as CatalogOnboardingPreview, 'index-only')).toThrow('catalog-onboarding-complete-preview-required')
  })

  it('mechanically derives a stable deduplicated preview and an exact decision from synthetic read-only roots', () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-onboarding-discovery-'))
    try {
      const firstRoot = path.join(temporary, 'first'); const secondRoot = path.join(temporary, 'second')
      fs.mkdirSync(firstRoot); fs.mkdirSync(secondRoot)
      writePackage(firstRoot, 'a', manifest('package-a', 'session-a', 'claude-code', 100))
      writePackage(firstRoot, 'b', manifest('package-b', 'session-b', 'claude-code', 200))
      writePackage(secondRoot, 'replica-a', manifest('package-a-replica', 'session-a', 'claude-code', 150))
      writePackage(secondRoot, 'c', manifest('package-c', 'session-c', 'codex', 300))
      const candidates = [{ root: root('first'), localPath: firstRoot }, { root: root('second'), localPath: secondRoot }]
      const first = discoverCatalogOnboarding(candidates, 'device'); const second = discoverCatalogOnboarding(candidates, 'device')
      expect(first.preview).toMatchObject({ sessionCount: 3, estimatedArchiveBytes: 650, sourceCount: 2, complete: true, privacyScopes: ['provider:claude-code', 'provider:codex', 'root:external-folder:first', 'root:external-folder:second'] })
      expect(second.preview?.previewId).toBe(first.preview?.previewId)
      const decision = new DeviceCatalog().decideOnboarding(first.preview!, 'index-only', '2026-08-11T00:00:00.000Z')
      expect(decision).toEqual({ previewId: first.preview!.previewId, discoveredLogicalSessions: 3, estimatedArchiveBytes: 650, privacyScopes: ['provider:claude-code', 'provider:codex', 'root:external-folder:first', 'root:external-folder:second'], archiveChoice: 'index-only', decidedAt: '2026-08-11T00:00:00.000Z' })
    } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
  })
})
