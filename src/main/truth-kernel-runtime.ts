import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { CanonicalEvent } from '../shared/provider-schema-v2.generated'
import type {
  ArchiveCoverage,
  CatalogScope,
  EvidenceRef,
  ExternalEvidenceAttachment,
  PricingPolicyMutationCommand,
  StorageRoot,
  StorageRootObservation,
  WorkspaceTab
} from '../shared/contracts/truth-kernel'
import type {
  TruthKernelCatalogIpcState,
  TruthKernelExternalEvidenceAttachResult,
  TruthKernelProviderDoctorIpcInput
} from '../shared/frontend-ipc-contract'
import { BUILTIN_PROVIDER_DEFINITIONS } from '../shared/provider-capabilities'
import { createCatalogOnboardingPreview, readCatalogOnboardingPreview } from '../shared/catalog-onboarding-preview'
import { DeviceCatalog, DeviceCatalogRepository } from './catalog/device-catalog'
import { discoverCatalogOnboarding } from './catalog/onboarding-discovery'
import {
  CLAUDE_TAP_EVIDENCE_PROVIDER,
  EXTERNAL_EVIDENCE_MAX_BYTES,
  ExternalEvidenceAttachmentRepository,
  NONO_EVIDENCE_PROVIDER,
  importJsonEvidence,
  sha256,
  type SessionTruthSnapshot
} from './external-evidence/evidence-provider'
import { parseNonoAuditSession, readExternalEvidenceFile } from './external-evidence/adapters'
import { openPricingPolicyRepository, type PricingPolicyRepository } from './fact-ledger/pricing-policy-repository'
import { readMulticaWorkspace } from './orchestration/multica/reader'
import { projectMulticaOverlay } from './orchestration/multica/overlay'
import type { CanonicalSessionStore } from './canonical-store'
import { getCanonicalProviderRuntimeDiagnostics } from './provider-runtime'

const unavailable = <T,>(reason: string) => ({ status: 'unavailable' as const, reason })

export function allCatalogScope(): CatalogScope {
  return {
    logicalSessionIds: [], rootIds: [], collectionIds: [], providerIds: [], projectIds: [], pathPrefixes: [],
    timeRange: unavailable<{ from?: string; to?: string }>('no-time-filter'),
    textQuery: unavailable<string>('no-text-filter'), emptyFilterSemantics: 'all-catalog'
  }
}

function defaultWorkspaceTab(title = 'All sessions'): WorkspaceTab {
  return {
    schemaVersion: 1, tabId: 'all', title, scope: allCatalogScope(), view: 'sessions',
    sidebarMode: 'collections', selectedObjectId: unavailable('no-selection'), filters: {},
    sort: unavailable('default-order'), navigationHistory: [],
    scrollState: { anchorObjectId: unavailable('no-anchor'), offsetPx: 0 },
    layoutState: { density: 'comfortable', inspectorOpen: true, splitRatio: unavailable('shell-managed') },
    pinned: true, persisted: true
  }
}

function initialObservation(rootId: string, deviceId: string): StorageRootObservation {
  const now = new Date().toISOString()
  return {
    schemaVersion: 1, observationId: `root-observation:${rootId}:${now}`, rootId, deviceId,
    permissionState: 'unknown', availabilityState: 'unknown', scanState: 'never-scanned',
    lastSeenAt: unavailable('not-scanned'), lastSuccessfulScanAt: unavailable('not-scanned'),
    failureCode: unavailable('not-scanned'), observedAt: now
  }
}

interface PersistedEvidenceStateV1 {
  schemaVersion: 1
  attachments: ExternalEvidenceAttachment[]
}

export interface TruthKernelRuntimeOptions {
  userDataPath: string
  homeDir: string
  platform: NodeJS.Platform
  getLibraryRoot(): string | null
  selectCatalogRoot(): Promise<string | null>
  selectEvidenceFile(): Promise<string | null>
  environment?: Pick<NodeJS.ProcessEnv, 'MULTICA_WORKSPACES_ROOT'>
}

/** Production-only owner for durable Catalog, pricing, evidence and read-only orchestration state. */
export class TruthKernelRuntime {
  readonly catalog: DeviceCatalog
  readonly pricing: PricingPolicyRepository
  private readonly deviceId = 'local-device'
  private readonly evidencePath: string
  private readonly catalogShellPath: string
  private attachments: ExternalEvidenceAttachment[]
  private onboardingPreview?: ReturnType<typeof readCatalogOnboardingPreview>
  private activeTabId = 'all'

  constructor(private readonly options: TruthKernelRuntimeOptions) {
    const directory = path.join(options.userDataPath, 'truth-kernel')
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.catalog = new DeviceCatalog(new DeviceCatalogRepository(path.join(directory, 'device-catalog.json')))
    this.pricing = openPricingPolicyRepository(path.join(directory, 'pricing.sqlite'))
    this.evidencePath = path.join(directory, 'external-evidence.json')
    this.catalogShellPath = path.join(directory, 'catalog-shell.json')
    this.attachments = this.loadAttachments()
    if (this.catalog.listTabs().length === 0) this.catalog.saveTab(defaultWorkspaceTab())
    try {
      const shell = JSON.parse(fs.readFileSync(this.catalogShellPath, 'utf8')) as { activeTabId?: string }
      if (shell.activeTabId && this.catalog.listTabs().some((tab) => tab.tabId === shell.activeTabId)) this.activeTabId = shell.activeTabId
    } catch { /* first run */ }
    this.ensureLibraryRoot()
  }

  close(): void { this.pricing.close() }

  private ensureLibraryRoot(): void {
    let localPath: string | null = null
    try { localPath = this.options.getLibraryRoot() } catch { localPath = null }
    if (!localPath) return
    const root: StorageRoot = {
      schemaVersion: 1, rootId: 'library', displayName: 'Library', kind: 'managed-library',
      capability: 'read-only', layoutPolicy: 'loose-root', includeRules: [],
      excludeRules: ['node_modules', '.git'], isDefaultArchiveTarget: false
    }
    const current = this.catalog.listRoots().find((entry) => entry.root.rootId === root.rootId)
    if (!current) this.catalog.registerRoot(root, initialObservation(root.rootId, this.deviceId), localPath)
  }

  private loadAttachments(): ExternalEvidenceAttachment[] {
    try {
      const state = JSON.parse(fs.readFileSync(this.evidencePath, 'utf8')) as PersistedEvidenceStateV1
      return state.schemaVersion === 1 && Array.isArray(state.attachments) ? state.attachments : []
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  private persistAttachments(): void {
    const temporary = `${this.evidencePath}.tmp`
    fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, attachments: this.attachments } satisfies PersistedEvidenceStateV1), { mode: 0o600 })
    fs.renameSync(temporary, this.evidencePath)
  }

  catalogState(): TruthKernelCatalogIpcState {
    const tabs = this.catalog.listTabs()
    const active = tabs.find((tab) => tab.tabId === this.activeTabId) ?? tabs[0] ?? defaultWorkspaceTab()
    const scope = active.scope
    const sessions = this.catalog.query(scope)
    const providerCounts = new Map<string, number>()
    for (const session of sessions) {
      for (const source of session.sourceBindingIds) providerCounts.set(source, (providerCounts.get(source) ?? 0) + 1)
    }
    return {
      roots: this.catalog.listRoots().map(({ root, observation }) => ({ root, observation })),
      collections: this.catalog.listCollections(), tabs, activeTabId: active.tabId,
      logicalSessionIds: sessions.map((session) => session.logicalSessionId),
      sources: [...providerCounts].map(([id, count]) => ({ id, label: id, count })),
      coverage: this.catalog.coverage(scope), onboardingPreview: this.onboardingPreview,
      onboardingChoice: this.catalog.getOnboardingDecision()?.archiveChoice
    }
  }

  async addCatalogRoot(): Promise<TruthKernelCatalogIpcState> {
    const localPath = await this.options.selectCatalogRoot()
    if (!localPath) return this.catalogState()
    const real = fs.realpathSync.native(localPath)
    const rootId = `root:${createHash('sha256').update(real).digest('hex').slice(0, 20)}`
    const root: StorageRoot = {
      schemaVersion: 1, rootId, displayName: path.basename(real) || 'External root',
      kind: 'external-folder', capability: 'read-only', layoutPolicy: 'preserve-user-layout',
      includeRules: [], excludeRules: ['node_modules', '.git'], isDefaultArchiveTarget: false
    }
    this.catalog.registerRoot(root, initialObservation(rootId, this.deviceId), real)
    const discovery = discoverCatalogOnboarding([{ root, localPath: real }], this.deviceId, {
      maxEntries: 20_000, maxManifests: 10_000, maxDepth: 32
    })
    this.onboardingPreview = discovery.preview && readCatalogOnboardingPreview(discovery.preview)
    this.catalog.rebuildRoot(rootId, this.deviceId, { maxEntries: 20_000, maxManifests: 10_000, maxDepth: 32 })
    return this.catalogState()
  }

  removeCatalogRoot(rootId: string): TruthKernelCatalogIpcState {
    this.catalog.removeRoot(rootId)
    return this.catalogState()
  }

  rescanCatalogRoot(rootId: string): TruthKernelCatalogIpcState {
    const registration = this.catalog.listRoots().find((entry) => entry.root.rootId === rootId)
    if (registration) {
      const discovery = discoverCatalogOnboarding([{ root: registration.root, localPath: registration.localPath }], this.deviceId, {
        maxEntries: 20_000, maxManifests: 10_000, maxDepth: 32
      })
      this.onboardingPreview = discovery.preview && readCatalogOnboardingPreview(discovery.preview)
    }
    this.catalog.rebuildRoot(rootId, this.deviceId, { maxEntries: 20_000, maxManifests: 10_000, maxDepth: 32 })
    return this.catalogState()
  }

  saveCatalogTab(tab: WorkspaceTab): TruthKernelCatalogIpcState {
    this.catalog.saveTab(tab)
    return this.catalogState()
  }

  removeCatalogTab(tabId: string): TruthKernelCatalogIpcState {
    if (tabId !== 'all') this.catalog.removeTab(tabId)
    if (this.activeTabId === tabId) this.setActiveCatalogTab(this.catalog.listTabs()[0]?.tabId ?? 'all')
    return this.catalogState()
  }

  setActiveCatalogTab(tabId: string): TruthKernelCatalogIpcState {
    if (!this.catalog.listTabs().some((tab) => tab.tabId === tabId)) throw new Error('catalog-tab-not-found')
    this.activeTabId = tabId
    const temporary = `${this.catalogShellPath}.tmp`
    fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, activeTabId: tabId }), { mode: 0o600 })
    fs.renameSync(temporary, this.catalogShellPath)
    return this.catalogState()
  }

  decideCatalogOnboarding(choice: 'default-library' | 'index-only' | 'skip'): TruthKernelCatalogIpcState {
    if (!this.onboardingPreview) return this.catalogState()
    const preview = createCatalogOnboardingPreview(this.onboardingPreview)
    this.catalog.decideOnboarding(preview, choice)
    return { ...this.catalogState(), onboardingChoice: choice }
  }

  allowedOutputRoots(): Array<{ rootId: string; absolutePath: string }> {
    return this.catalog.listRoots()
      .filter((entry) => entry.observation.permissionState === 'granted' && entry.observation.availabilityState === 'online')
      .map((entry) => ({ rootId: entry.root.rootId, absolutePath: entry.localPath }))
      .filter((entry) => Boolean(entry.absolutePath))
  }

  evidenceForSession(logicalSessionId: string): ExternalEvidenceAttachment[] {
    return this.attachments.filter((attachment) => attachment.state === 'active' &&
      attachment.mappedLogicalSessionId.status === 'available' &&
      attachment.mappedLogicalSessionId.value === logicalSessionId)
  }

  async attachEvidence(logicalSessionId: string, truth: SessionTruthSnapshot): Promise<TruthKernelExternalEvidenceAttachResult> {
    const selected = await this.options.selectEvidenceFile()
    if (!selected) return { canceled: true }
    const rootPath = path.dirname(selected)
    const relativePath = path.basename(selected)
    const bytes = await readExternalEvidenceFile(rootPath, relativePath, EXTERNAL_EVIDENCE_MAX_BYTES)
    const metadata = fs.statSync(selected)
    const capturedAt = new Date().toISOString()
    const locatorHash = sha256(new TextEncoder().encode(path.resolve(selected)))
    let imported
    let nonoEventsEvidence: EvidenceRef | undefined
    try {
      imported = importJsonEvidence(CLAUDE_TAP_EVIDENCE_PROVIDER, bytes, locatorHash, metadata.mtime.toISOString(), capturedAt, 'claude-tap-parser/1')
    } catch (claudeTapError) {
      try {
        if (!relativePath.endsWith('.session.json')) throw new Error('external-evidence:nono-session-file-required')
        const eventsRelativePath = `${relativePath.slice(0, -'.session.json'.length)}.events.ndjson`
        const eventBytes = await readExternalEvidenceFile(rootPath, eventsRelativePath, EXTERNAL_EVIDENCE_MAX_BYTES)
        const sessionJson = JSON.parse(new TextDecoder().decode(bytes)) as unknown
        parseNonoAuditSession(sessionJson, new TextDecoder().decode(eventBytes))
        imported = importJsonEvidence(NONO_EVIDENCE_PROVIDER, bytes, locatorHash, metadata.mtime.toISOString(), capturedAt, 'nono-parser/1')
        const eventDigest = sha256(eventBytes)
        nonoEventsEvidence = {
          evidenceId: `receipt:nono-events:${eventDigest}`, sourceId: NONO_EVIDENCE_PROVIDER.providerId,
          sourceKind: 'runtime-capture', providerId: NONO_EVIDENCE_PROVIDER.providerId,
          logicalSessionId, capturedAt, grade: 'B', claim: 'provider-confirmed', digest: eventDigest
        }
      } catch { throw claudeTapError }
    }
    if (this.attachments.some((attachment) => attachment.state === 'active' && attachment.externalProviderId === imported.provider.providerId && attachment.sourceDigest === imported.receipt.sourceSha256)) {
      throw new Error('external-evidence:duplicate-attachment')
    }
    const repository = new ExternalEvidenceAttachmentRepository({
      resolveSession: (candidate) => ({ status: candidate === logicalSessionId ? 'active' : 'missing' }),
      readTruth: () => truth
    })
    const evidence: EvidenceRef = {
      evidenceId: imported.receipt.receiptId, sourceId: imported.provider.providerId,
      sourceKind: 'runtime-capture', providerId: imported.provider.providerId,
      logicalSessionId, capturedAt, grade: 'B', claim: 'provider-confirmed',
      locator: { kind: 'external-attachment', locatorHash, length: bytes.byteLength },
      digest: imported.receipt.sourceSha256
    }
    const id = randomUUID()
    const attachment = repository.attach(imported, {
      logicalAttachmentId: `attachment:${id}`, revisionId: `attachment:${id}:r1`,
      sourceVersion: imported.sourceVersion, schemaId: imported.schemaId,
      mappedLogicalSessionId: logicalSessionId, privacyState: 'private-local',
      contentRetention: 'redacted-metadata-only', attachedAt: capturedAt, evidence: [evidence, ...(nonoEventsEvidence ? [nonoEventsEvidence] : [])],
      assurance: [{
        dimension: 'attachment-identity', assessment: 'observed', evidenceRefs: [evidence.evidenceId],
        verificationResultIds: [], canProve: ['selected bytes matched the recorded digest at ingest'],
        cannotProve: ['the external runtime claims are true']
      }]
    })
    this.attachments.push(attachment)
    this.persistAttachments()
    return { canceled: false, attachment }
  }

  orchestration(logicalSessionId: string) {
    const read = readMulticaWorkspace({
      homeDir: this.options.homeDir,
      platform: (['darwin', 'linux', 'win32'].includes(this.options.platform) ? this.options.platform : 'linux') as 'darwin' | 'linux' | 'win32',
      env: { MULTICA_WORKSPACES_ROOT: this.options.environment?.MULTICA_WORKSPACES_ROOT }
    })
    const overlay = projectMulticaOverlay({ entities: read.parsed.entities, usages: read.parsed.usages, discovery: {
      homeDir: this.options.homeDir,
      platform: (['darwin', 'linux', 'win32'].includes(this.options.platform) ? this.options.platform : 'linux') as 'darwin' | 'linux' | 'win32',
      env: { MULTICA_WORKSPACES_ROOT: this.options.environment?.MULTICA_WORKSPACES_ROOT }
    } })
    const linkedRuns = new Set(overlay.sessionLinks.filter((link) => link.logicalSessionId === logicalSessionId).map((link) => link.orchestrationRunId))
    const stableDiagnostics = [...read.diagnostics, ...overlay.doctor.failures].map((diagnostic) => {
      if (diagnostic.startsWith('No readable Multica')) return 'no-readable-root'
      if (diagnostic.startsWith('Multica root is not readable')) return 'root-unreadable'
      if (diagnostic.startsWith('Unsupported Multica schema')) return 'unsupported-schema'
      if (diagnostic.startsWith('Skipped')) return 'source-skipped'
      return 'adapter-diagnostic'
    })
    return {
      mode: 'read-only' as const, runs: overlay.runs.length, linkedRuns: linkedRuns.size,
      usageAggregates: overlay.usageAggregates.filter((usage) => usage.scope.kind === 'run' && linkedRuns.has(usage.scope.orchestrationRunId)),
      coverage: linkedRuns.size > 0
        ? { ...overlay.coverage, coveredFactIds: [...linkedRuns] }
        : { state: 'unavailable' as const, coveredFactIds: [], missingDimensions: ['no-linked-multica-run'], evidence: [] },
      diagnostics: [...new Set(stableDiagnostics)].slice(0, 20)
    }
  }

  providerDoctor(store: CanonicalSessionStore): TruthKernelProviderDoctorIpcInput[] {
    const runtimeDiagnostics = getCanonicalProviderRuntimeDiagnostics()
    return BUILTIN_PROVIDER_DEFINITIONS.map((definition) => {
      const providerId = definition.manifest.providerId
      const v1Sources = store.sourceStates(providerId)
      const v2Sessions = store.listV2Sessions(providerId)
      let unknownEvents = 0
      for (const session of v2Sessions) {
        let afterSequence: number | null = null
        do {
          const page = store.readV2EventPage(session.identity.logicalSessionKey, session.identity.branchViewId, { afterSequence, limit: 4_096 })
          unknownEvents += page.events.filter((event) => event.kind === 'unknown').length
          afterSequence = page.nextSequence
        } while (afterSequence !== null)
      }
      const latest = runtimeDiagnostics.get(providerId)
      const durableSourceCount = new Set([...v1Sources.map((source) => source.sourceRef.stableId), ...v2Sessions.map((session) => session.identity.physicalSourceId)]).size
      const sourceCount = latest?.sourceCount ?? durableSourceCount
      return {
        manifest: definition.manifest as unknown as TruthKernelProviderDoctorIpcInput['manifest'],
        discovery: latest?.discovery ?? (sourceCount > 0 ? 'found' : 'not-found'),
        discoveryReason: latest?.discoveryReason ?? (sourceCount > 0 ? 'runtime-diagnostics-unavailable; durable source retained' : 'No durable canonical source is registered.'),
        lastSuccessfulParseAt: latest?.lastSuccessfulParseAt ?? null, unknownEvents,
        partialEvents: latest?.partialEvents ?? v2Sessions.filter((session) => !session.complete).reduce((sum, session) => sum + session.eventCount, 0),
        sourceLabel: `${definition.sourceId} · ${sourceCount}`,
        executionDomain: latest?.executionDomain ?? 'unknown'
      }
    })
  }

  applyPricing(command: PricingPolicyMutationCommand) { return this.pricing.apply(command) }
}

export function truthSnapshot(events: readonly CanonicalEvent[]): SessionTruthSnapshot {
  return {
    transcriptHash: createHash('sha256').update(JSON.stringify(events)).digest('hex'),
    turnCount: new Set(events.filter((event) => event.kind.startsWith('message.')).map((event) => event.id)).size,
    usageTotalTokens: events.filter((event) => event.kind === 'usage').reduce((sum, event) => {
      const usage = event.payload as unknown as { input?: { total?: number }; output?: { total?: number } }
      return sum + (usage.input?.total ?? 0) + (usage.output?.total ?? 0)
    }, 0)
  }
}

export function catalogCoverage(catalog: DeviceCatalog): ArchiveCoverage {
  return catalog.coverage(allCatalogScope())
}
