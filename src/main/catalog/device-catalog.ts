import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type {
  ArchiveCoverage, Availability, CatalogConfiguration, CatalogScope, CatalogSessionRecord,
  Collection, CollectionMembership, PackageLocation, StorageRoot, StorageRootObservation, WorkspaceTab
} from '../../shared/contracts/truth-kernel'
import { scanStorageRootReadOnly, type CatalogProjectionMetadata, type ManifestCheckpoint, type ReadOnlyRootScanOptions } from './root-scanner'
import { readCatalogOnboardingPreview, type CatalogOnboardingArchiveChoice, type CatalogOnboardingPreview } from '../../shared/catalog-onboarding-preview'

const unavailable = <T>(reason: string): Availability<T> => ({ status: 'unavailable', reason })
const available = <T>(value: T): Availability<T> => ({ status: 'available', value })

export interface RootRegistration { root: StorageRoot; localPath: string; observation: StorageRootObservation }
export interface OnboardingDecision {
  previewId: string
  discoveredLogicalSessions: number
  estimatedArchiveBytes: number
  privacyScopes: string[]
  archiveChoice: CatalogOnboardingArchiveChoice
  decidedAt: string
}

interface CatalogSnapshotV1 {
  schemaVersion: 1
  generation: number
  roots: RootRegistration[]
  locations: PackageLocation[]
  sessions: CatalogSessionRecord[]
  sessionMetadata: Array<[string, CatalogProjectionMetadata]>
  collections: Collection[]
  memberships: CollectionMembership[]
  tabs: WorkspaceTab[]
  recentlyClosedTabs: WorkspaceTab[]
  checkpoints: Array<[string, ManifestCheckpoint[]]>
  onboardingDecision?: OnboardingDecision
}

/** Atomic JSON repository owned by the device Catalog, never by an external StorageRoot. */
export class DeviceCatalogRepository {
  constructor(readonly filePath: string) {}
  load(): CatalogSnapshotV1 | undefined {
    try {
      const value = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as CatalogSnapshotV1
      return value.schemaVersion === 1 ? value : undefined
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }
  save(snapshot: CatalogSnapshotV1): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(snapshot), { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(temporary, this.filePath)
  }
}

/** Device-local identity index. External Roots remain strictly read-only. */
export class DeviceCatalog {
  private readonly roots = new Map<string, RootRegistration>()
  private readonly locations = new Map<string, PackageLocation>()
  private readonly sessions = new Map<string, CatalogSessionRecord>()
  private readonly sessionMetadata = new Map<string, CatalogProjectionMetadata>()
  private readonly collections = new Map<string, Collection>()
  private readonly memberships = new Map<string, CollectionMembership>()
  private readonly tabs = new Map<string, WorkspaceTab>()
  private recentlyClosedTabs: WorkspaceTab[] = []
  private readonly checkpoints = new Map<string, ManifestCheckpoint[]>()
  private onboardingDecision?: OnboardingDecision
  private generation = 0

  constructor(private readonly repository?: DeviceCatalogRepository) {
    const snapshot = repository?.load()
    if (snapshot) this.hydrate(snapshot)
  }

  registerRoot(root: StorageRoot, observation: StorageRootObservation, localPath = ''): void {
    if (root.capability !== 'read-only' && root.capability !== 'manual-packages-only') throw new Error('catalog-read-only-root-required')
    const absolute = localPath ? path.resolve(localPath) : this.roots.get(root.rootId)?.localPath ?? ''
    const resolved = absolute && fs.existsSync(absolute) ? fs.realpathSync.native(absolute) : absolute
    for (const registration of this.roots.values()) {
      if (registration.root.rootId !== root.rootId && resolved && registration.localPath && this.pathsOverlap(resolved, registration.localPath)) throw new Error('catalog-root-overlap')
    }
    this.roots.set(root.rootId, { root, observation, localPath: resolved })
    this.commit()
  }

  updateRootObservation(observation: StorageRootObservation): void {
    const registration = this.roots.get(observation.rootId)
    if (!registration) throw new Error('catalog-root-not-registered')
    this.roots.set(observation.rootId, { ...registration, observation })
    this.commit()
  }

  removeRoot(rootId: string): void {
    this.roots.delete(rootId); this.checkpoints.delete(rootId)
    for (const [id, location] of this.locations) if (location.rootId.status === 'available' && location.rootId.value === rootId) this.locations.delete(id)
    this.commit()
  }

  observeLocation(location: PackageLocation): void { this.locations.set(location.locationId, location); this.commit() }
  observeSession(session: CatalogSessionRecord, metadata?: CatalogProjectionMetadata): void {
    const existing = this.sessions.get(session.logicalSessionId)
    this.sessions.set(session.logicalSessionId, existing ? { ...session, packageIds: [...new Set([...existing.packageIds, ...session.packageIds])], sourceBindingIds: [...new Set([...existing.sourceBindingIds, ...session.sourceBindingIds])] } : session)
    if (metadata) this.sessionMetadata.set(session.logicalSessionId, this.mergeMetadata(this.sessionMetadata.get(session.logicalSessionId), metadata))
    this.commit()
  }
  saveCollection(collection: Collection): void { this.collections.set(collection.collectionId, collection); this.commit() }
  saveMembership(membership: CollectionMembership): void { this.memberships.set(membership.membershipId, membership); this.commit() }
  saveTab(tab: WorkspaceTab): void { this.tabs.set(tab.tabId, tab); this.commit() }
  renameTab(tabId: string, title: string): void { this.patchTab(tabId, { title }) }
  setTabPinned(tabId: string, pinned: boolean): void { this.patchTab(tabId, { pinned }) }
  duplicateTab(tabId: string, newTabId: string): WorkspaceTab {
    const source = this.requireTab(tabId); const copy = structuredClone({ ...source, tabId: newTabId, title: `${source.title} copy`, pinned: false })
    this.tabs.set(newTabId, copy); this.commit(); return copy
  }
  removeTab(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (tab) this.recentlyClosedTabs = [tab, ...this.recentlyClosedTabs.filter((item) => item.tabId !== tabId)].slice(0, 20)
    this.tabs.delete(tabId); this.commit()
  }
  restoreRecentlyClosed(): WorkspaceTab | undefined {
    const tab = this.recentlyClosedTabs.shift()
    if (tab) this.tabs.set(tab.tabId, tab)
    this.commit(); return tab
  }
  decideOnboarding(preview: CatalogOnboardingPreview, archiveChoice: CatalogOnboardingArchiveChoice, decidedAt = new Date().toISOString()): OnboardingDecision {
    const derived = readCatalogOnboardingPreview(preview)
    if (!derived || !derived.complete) throw new Error('catalog-onboarding-complete-preview-required')
    const decision: OnboardingDecision = { previewId: derived.previewId, discoveredLogicalSessions: derived.sessionCount, estimatedArchiveBytes: derived.estimatedArchiveBytes, privacyScopes: derived.privacyScopes, archiveChoice, decidedAt }
    this.onboardingDecision = decision; this.commit(); return structuredClone(decision)
  }
  getOnboardingDecision(): OnboardingDecision | undefined { return this.onboardingDecision && structuredClone(this.onboardingDecision) }

  /** Full or checkpoint-assisted refresh. Missing entries are removed only after a complete scan. */
  rebuildRoot(rootId: string, deviceId: string, options: ReadOnlyRootScanOptions = {}) {
    const registration = this.roots.get(rootId)
    if (!registration || !registration.localPath) throw new Error('catalog-root-path-required')
    const result = scanStorageRootReadOnly(registration.root, registration.localPath, deviceId, new Date().toISOString(), { ...options, previousCheckpoints: options.previousCheckpoints ?? this.checkpoints.get(rootId) })
    this.roots.set(rootId, { ...registration, observation: result.observation })
    if (result.observation.availabilityState === 'online') {
      const observedIds = new Set(result.entries.map((entry) => entry.location.locationId))
      if (result.complete) for (const [id, location] of this.locations) if (location.rootId.status === 'available' && location.rootId.value === rootId && !observedIds.has(id)) this.locations.delete(id)
      for (const entry of result.entries) {
        this.locations.set(entry.location.locationId, entry.location)
        const existing = this.sessions.get(entry.session.logicalSessionId)
        this.sessions.set(entry.session.logicalSessionId, existing ? { ...existing, packageIds: [...new Set([...existing.packageIds, ...entry.session.packageIds])], sourceBindingIds: [...new Set([...existing.sourceBindingIds, ...entry.session.sourceBindingIds])] } : entry.session)
        this.sessionMetadata.set(entry.session.logicalSessionId, this.mergeMetadata(this.sessionMetadata.get(entry.session.logicalSessionId), entry.metadata))
      }
      this.checkpoints.set(rootId, result.checkpoints)
    } else {
      for (const [id, location] of this.locations) if (location.rootId.status === 'available' && location.rootId.value === rootId) this.locations.set(id, { ...location, observationState: 'last-known' })
    }
    this.commit(); return result
  }

  configuration(): CatalogConfiguration {
    const roots = [...this.roots.values()].map((item) => item.root)
    const defaultRoot = roots.find((root) => root.isDefaultArchiveTarget)
    return { schemaVersion: 1, rootIds: roots.map((root) => root.rootId).sort(), defaultArchiveRootId: defaultRoot ? available(defaultRoot.rootId) : unavailable('no-default-archive-root'), discoveryMode: 'read-only', automaticWriteSelection: 'unique-bound-location-or-fail-closed' }
  }

  query(scope: CatalogScope): CatalogSessionRecord[] {
    const collectionMembers = new Set([...this.memberships.values()].filter((item) => scope.collectionIds.includes(item.collectionId)).map((item) => item.logicalSessionId))
    for (const collectionId of scope.collectionIds) {
      const collectionScope = this.collections.get(collectionId)?.scope
      if (collectionScope?.status === 'available') for (const session of this.query({ ...collectionScope.value, collectionIds: [] })) collectionMembers.add(session.logicalSessionId)
    }
    const from = scope.timeRange.status === 'available' ? scope.timeRange.value.from : undefined
    const to = scope.timeRange.status === 'available' ? scope.timeRange.value.to : undefined
    const text = scope.textQuery.status === 'available' ? scope.textQuery.value.normalize('NFC').toLocaleLowerCase().trim() : ''
    return [...this.sessions.values()].filter((session) => {
      const metadata = this.sessionMetadata.get(session.logicalSessionId) ?? { providerIds: [], projectIds: [], paths: [], timestamps: [], searchableText: '' }
      if (scope.logicalSessionIds.length && !scope.logicalSessionIds.includes(session.logicalSessionId)) return false
      if (scope.collectionIds.length && !collectionMembers.has(session.logicalSessionId)) return false
      if (scope.providerIds.length && !scope.providerIds.some((id) => metadata.providerIds.includes(id))) return false
      if (scope.projectIds.length && !scope.projectIds.some((id) => metadata.projectIds.includes(id))) return false
      if (scope.pathPrefixes.length && !scope.pathPrefixes.some((prefix) => metadata.paths.some((candidate) => this.pathWithin(candidate, prefix)))) return false
      if ((from || to) && !metadata.timestamps.some((timestamp) => (!from || timestamp >= from) && (!to || timestamp <= to))) return false
      if (text && !metadata.searchableText.includes(text)) return false
      if (scope.rootIds.length) {
        const packageIds = new Set(session.packageIds)
        if (![...this.locations.values()].some((location) => packageIds.has(location.packageId) && location.rootId.status === 'available' && scope.rootIds.includes(location.rootId.value))) return false
      }
      return true
    }).sort((a, b) => a.logicalSessionId.localeCompare(b.logicalSessionId))
  }

  coverage(scope: CatalogScope, computedAt = new Date().toISOString()): ArchiveCoverage {
    const sessions = this.query(scope); const ids = sessions.map((session) => session.logicalSessionId)
    const locationsByPackage = new Map<string, PackageLocation[]>()
    for (const location of this.locations.values()) locationsByPackage.set(location.packageId, [...(locationsByPackage.get(location.packageId) || []), location])
    let archived = 0; let sourceOnly = 0; let offline = 0; let conflicted = 0; let unavailableCount = 0
    for (const session of sessions) {
      const locations = session.packageIds.flatMap((id) => locationsByPackage.get(id) || [])
      const rootOffline = locations.some((location) => location.rootId.status === 'available' && this.roots.get(location.rootId.value)?.observation.availabilityState !== 'online')
      if (session.state === 'conflict' || locations.some((location) => location.state === 'conflict')) conflicted += 1
      else if (session.state === 'offline' || rootOffline || locations.some((location) => location.state === 'missing' || location.state === 'placeholder')) offline += 1
      else if (session.state === 'known-source-only' || locations.length === 0) sourceOnly += 1
      else if (session.state === 'known-archived' || session.state === 'source-and-archive') archived += 1
      else unavailableCount += 1
    }
    const registrations = [...this.roots.values()]
    return { schemaVersion: 1, knownLogicalSessions: ids.length, archivedLogicalSessions: archived, sourceOnlyLogicalSessions: sourceOnly, offlineLogicalSessions: offline, conflictedLogicalSessions: conflicted, unavailableLogicalSessions: unavailableCount, logicalSessionIds: ids.sort(), packageIds: [...new Set(sessions.flatMap((session) => session.packageIds))].sort(), offlineRootIds: registrations.filter((item) => item.observation.availabilityState === 'offline').map((item) => item.root.rootId).sort(), unavailableRootIds: registrations.filter((item) => item.observation.availabilityState === 'unavailable').map((item) => item.root.rootId).sort(), scope, scopeFingerprint: createHash('sha256').update(JSON.stringify(scope)).digest('hex'), responseGeneration: String(this.generation), computedAt }
  }

  locationsForSession(logicalSessionId: string): PackageLocation[] { const ids = new Set(this.sessions.get(logicalSessionId)?.packageIds ?? []); return [...this.locations.values()].filter((item) => ids.has(item.packageId)) }
  listTabs(): WorkspaceTab[] { return [...this.tabs.values()].filter((tab) => tab.persisted).sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.title.localeCompare(b.title)) }
  listRoots(): Array<{ root: StorageRoot; observation: StorageRootObservation; localPath: string }> { return [...this.roots.values()].map((item) => structuredClone(item)) }
  listCollections(): Collection[] { return [...this.collections.values()].sort((a, b) => a.name.localeCompare(b.name)) }
  flush(): void { this.persist() }

  private patchTab(tabId: string, patch: Partial<WorkspaceTab>): void { this.tabs.set(tabId, { ...this.requireTab(tabId), ...patch }); this.commit() }
  private requireTab(tabId: string): WorkspaceTab { const tab = this.tabs.get(tabId); if (!tab) throw new Error('catalog-tab-not-found'); return tab }
  private mergeMetadata(left: CatalogProjectionMetadata | undefined, right: CatalogProjectionMetadata): CatalogProjectionMetadata {
    if (!left) return { ...structuredClone(right), searchableText: right.searchableText.normalize('NFC').toLocaleLowerCase() }
    return { providerIds: [...new Set([...left.providerIds, ...right.providerIds])], projectIds: [...new Set([...left.projectIds, ...right.projectIds])], paths: [...new Set([...left.paths, ...right.paths])], timestamps: [...new Set([...left.timestamps, ...right.timestamps])], searchableText: `${left.searchableText} ${right.searchableText}`.trim() }
  }
  private pathWithin(candidate: string, prefix: string): boolean { const normalizedCandidate = candidate.replaceAll('\\', '/').replace(/\/$/, ''); const normalizedPrefix = prefix.replaceAll('\\', '/').replace(/\/$/, ''); return normalizedCandidate === normalizedPrefix || normalizedCandidate.startsWith(`${normalizedPrefix}/`) }
  private pathsOverlap(left: string, right: string): boolean { const relative = path.relative(left, right); const reverse = path.relative(right, left); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)) || (!reverse.startsWith('..') && !path.isAbsolute(reverse)) }
  private commit(): void { this.generation += 1; this.persist() }
  private persist(): void { this.repository?.save(this.snapshot()) }
  private snapshot(): CatalogSnapshotV1 { return { schemaVersion: 1, generation: this.generation, roots: [...this.roots.values()], locations: [...this.locations.values()], sessions: [...this.sessions.values()], sessionMetadata: [...this.sessionMetadata], collections: [...this.collections.values()], memberships: [...this.memberships.values()], tabs: [...this.tabs.values()], recentlyClosedTabs: this.recentlyClosedTabs, checkpoints: [...this.checkpoints], onboardingDecision: this.onboardingDecision } }
  private hydrate(snapshot: CatalogSnapshotV1): void {
    this.generation = snapshot.generation
    for (const item of snapshot.roots) this.roots.set(item.root.rootId, item)
    for (const item of snapshot.locations) this.locations.set(item.locationId, item)
    for (const item of snapshot.sessions) this.sessions.set(item.logicalSessionId, item)
    for (const item of snapshot.sessionMetadata) this.sessionMetadata.set(...item)
    for (const item of snapshot.collections) this.collections.set(item.collectionId, item)
    for (const item of snapshot.memberships) this.memberships.set(item.membershipId, item)
    for (const item of snapshot.tabs) this.tabs.set(item.tabId, item)
    this.recentlyClosedTabs = snapshot.recentlyClosedTabs ?? []
    for (const item of snapshot.checkpoints ?? []) this.checkpoints.set(...item)
    this.onboardingDecision = snapshot.onboardingDecision
  }
}
