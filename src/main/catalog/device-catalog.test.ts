import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CatalogScope, StorageRoot, StorageRootObservation } from '../../shared/contracts/truth-kernel'
import { DeviceCatalog, DeviceCatalogRepository } from './device-catalog'
import { createCatalogOnboardingPreview } from '../../shared/catalog-onboarding-preview'

const scope: CatalogScope = { logicalSessionIds: [], rootIds: [], collectionIds: [], providerIds: [], projectIds: [], pathPrefixes: [], timeRange: { status: 'unavailable', reason: 'all-time' }, textQuery: { status: 'unavailable', reason: 'none' }, emptyFilterSemantics: 'all-catalog' }
const root = (rootId: string): StorageRoot => ({ schemaVersion: 1, rootId, displayName: rootId, kind: 'external-folder', capability: 'read-only', layoutPolicy: 'preserve-user-layout', includeRules: [], excludeRules: [], isDefaultArchiveTarget: false })
const observation = (rootId: string, availabilityState: StorageRootObservation['availabilityState'] = 'online'): StorageRootObservation => ({ schemaVersion: 1, observationId: `obs:${rootId}`, rootId, deviceId: 'device', permissionState: 'granted', availabilityState, scanState: 'fresh', lastSeenAt: { status: 'available', value: '2026-08-11T00:00:00.000Z' }, lastSuccessfulScanAt: { status: 'available', value: '2026-08-11T00:00:00.000Z' }, failureCode: { status: 'unavailable', reason: 'none' }, observedAt: '2026-08-11T00:00:00.000Z' })

describe('DeviceCatalog', () => {
  it('counts a package with two locations only once and keeps both locations visible', () => {
    const catalog = new DeviceCatalog()
    catalog.registerRoot(root('library'), observation('library'))
    catalog.registerRoot(root('vault'), observation('vault'))
    catalog.observeSession({ schemaVersion: 1, logicalSessionId: 'session-a', sourceBindingIds: ['source-a'], packageIds: ['package-a'], state: 'source-and-archive' })
    for (const rootId of ['library', 'vault']) catalog.observeLocation({ schemaVersion: 1, locationId: `loc:${rootId}`, packageId: 'package-a', rootId: { status: 'available', value: rootId }, deviceId: 'device', relativePath: { status: 'available', value: 'AI/session' }, standaloneLocatorId: { status: 'unavailable', reason: 'root-bound' }, state: rootId === 'vault' ? 'replica' : 'online', lastSeenAt: { status: 'available', value: '2026-08-11T00:00:00.000Z' }, manifestDigest: { status: 'unavailable', reason: 'not-read' }, observationState: 'current', absenceMeansDeletion: false })
    expect(catalog.coverage(scope).knownLogicalSessions).toBe(1)
    expect(catalog.query({ ...scope, rootIds: ['vault'] }).map((item) => item.logicalSessionId)).toEqual(['session-a'])
  })

  it('removes only index relationships when authorization for a root is removed', () => {
    const catalog = new DeviceCatalog()
    catalog.registerRoot(root('vault'), observation('vault'))
    catalog.observeSession({ schemaVersion: 1, logicalSessionId: 'session-a', sourceBindingIds: [], packageIds: ['package-a'], state: 'known-archived' })
    catalog.observeLocation({ schemaVersion: 1, locationId: 'loc', packageId: 'package-a', rootId: { status: 'available', value: 'vault' }, deviceId: 'device', relativePath: { status: 'available', value: 'AI/session' }, standaloneLocatorId: { status: 'unavailable', reason: 'root-bound' }, state: 'online', lastSeenAt: { status: 'available', value: '2026-08-11T00:00:00.000Z' }, manifestDigest: { status: 'unavailable', reason: 'not-read' }, observationState: 'current', absenceMeansDeletion: false })
    catalog.removeRoot('vault')
    expect(catalog.query(scope)).toHaveLength(1)
    expect(catalog.query({ ...scope, rootIds: ['vault'] })).toHaveLength(0)
  })

  it('preserves offline sessions instead of treating an unavailable root as a deletion', () => {
    const catalog = new DeviceCatalog()
    catalog.registerRoot(root('external'), observation('external', 'offline'))
    catalog.observeSession({ schemaVersion: 1, logicalSessionId: 'session-offline', sourceBindingIds: [], packageIds: ['package-offline'], state: 'offline' })
    expect(catalog.coverage(scope).offlineLogicalSessions).toBe(1)
  })

  it('applies every frozen scope filter instead of silently returning an unfiltered row', () => {
    const catalog = new DeviceCatalog()
    catalog.observeSession({ schemaVersion: 1, logicalSessionId: 'session-a', sourceBindingIds: [], packageIds: [], state: 'known-source-only' }, {
      providerIds: ['claude'], projectIds: ['project-a'], paths: ['work/project-a'], timestamps: ['2026-08-10T12:00:00.000Z'], searchableText: 'Design review session-a'
    })
    expect(catalog.query({ ...scope, providerIds: ['missing'] })).toEqual([])
    expect(catalog.query({ ...scope, projectIds: ['missing'] })).toEqual([])
    expect(catalog.query({ ...scope, pathPrefixes: ['other'] })).toEqual([])
    expect(catalog.query({ ...scope, timeRange: { status: 'available', value: { from: '2026-08-11T00:00:00.000Z' } } })).toEqual([])
    expect(catalog.query({ ...scope, textQuery: { status: 'available', value: 'missing' } })).toEqual([])
    expect(catalog.query({ ...scope, providerIds: ['claude'], projectIds: ['project-a'], pathPrefixes: ['work'], textQuery: { status: 'available', value: 'DESIGN REVIEW' } })).toHaveLength(1)
    catalog.saveCollection({ schemaVersion: 1, collectionId: 'smart', name: 'Smart project', kind: 'smart-query', scope: { status: 'available', value: { ...scope, projectIds: ['project-a'] } } })
    expect(catalog.query({ ...scope, collectionIds: ['smart'] })).toHaveLength(1)
  })

  it('persists roots, offline last-known records, collections and complete tab state across restart', () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-catalog-store-'))
    const filePath = path.join(temporary, 'catalog.json')
    try {
      const first = new DeviceCatalog(new DeviceCatalogRepository(filePath))
      first.registerRoot(root('vault'), observation('vault', 'offline'), path.join(temporary, 'vault'))
      first.observeSession({ schemaVersion: 1, logicalSessionId: 'offline', sourceBindingIds: [], packageIds: ['package'], state: 'offline' })
      first.saveCollection({ schemaVersion: 1, collectionId: 'favorites', name: 'Favorites', kind: 'favorite', scope: { status: 'unavailable', reason: 'manual' } })
      first.saveTab({ schemaVersion: 1, tabId: 'tab', title: 'Vault', scope, view: 'insights', sidebarMode: 'locations', selectedObjectId: { status: 'available', value: 'offline' }, filters: { status: 'offline' }, sort: { status: 'available', value: 'updated-desc' }, navigationHistory: ['all', 'vault'], scrollState: { anchorObjectId: { status: 'available', value: 'offline' }, offsetPx: 42 }, layoutState: { density: 'compact', inspectorOpen: true, splitRatio: { status: 'available', value: 0.4 } }, pinned: true, persisted: true })
      first.decideOnboarding(createCatalogOnboardingPreview({ previewId: 'preview', sessionCount: 1, estimatedArchiveBytes: 128, privacyScopes: ['root:obsidian-vault:vault'], sourceCount: 1, complete: true }), 'index-only', '2026-08-11T00:00:00.000Z')
      const restored = new DeviceCatalog(new DeviceCatalogRepository(filePath))
      expect(restored.coverage(scope).offlineLogicalSessions).toBe(1)
      expect(restored.listCollections()).toHaveLength(1)
      expect(restored.listTabs()[0]).toMatchObject({ pinned: true, sidebarMode: 'locations', scrollState: { offsetPx: 42 }, layoutState: { inspectorOpen: true } })
      expect(restored.getOnboardingDecision()?.archiveChoice).toBe('index-only')
      restored.removeTab('tab')
      expect(new DeviceCatalog(new DeviceCatalogRepository(filePath)).restoreRecentlyClosed()?.tabId).toBe('tab')
    } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
  })

  it('rebuilds valid package manifests, reuses checkpoints, and retains last-known data offline', () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-catalog-rebuild-'))
    const rootPath = path.join(temporary, 'vault'); const packagePath = path.join(rootPath, 'AI', 'session')
    fs.mkdirSync(packagePath, { recursive: true })
    fs.writeFileSync(path.join(packagePath, '.swob-session.json'), JSON.stringify({ schemaVersion: 3, packageId: 'package-a', sessionId: 'session-a', logicalIdentity: { schemaVersion: 1, sourceFamily: 'claude', sourceInstance: { kind: 'default', id: 'default' }, sessionId: 'session-a' }, sourceFilePaths: [], projectPath: 'project-a', createdAt: '2026-08-10T00:00:00.000Z', updatedAt: '2026-08-11T00:00:00.000Z' }))
    const catalog = new DeviceCatalog(new DeviceCatalogRepository(path.join(temporary, 'catalog.json')))
    catalog.registerRoot(root('vault'), observation('vault'), rootPath)
    expect(catalog.rebuildRoot('vault', 'device').complete).toBe(true)
    expect(catalog.query({ ...scope, providerIds: ['claude'], projectIds: ['project-a'], pathPrefixes: ['AI'] })).toHaveLength(1)
    expect(catalog.rebuildRoot('vault', 'device').reusedManifests).toBe(1)
    fs.renameSync(rootPath, `${rootPath}-offline`)
    expect(catalog.rebuildRoot('vault', 'device').observation.availabilityState).toBe('offline')
    expect(catalog.query(scope)).toHaveLength(1)
    fs.rmSync(temporary, { recursive: true, force: true })
  })
})
