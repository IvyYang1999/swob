import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { TruthKernelCatalogIpcState, TruthKernelSessionIpcReadModel } from '../../../shared/frontend-ipc-contract'
import type { CatalogScope, WorkspaceTab } from '../../../shared/contracts/truth-kernel'
import { createCatalogOnboardingPreview } from '../../../shared/catalog-onboarding-preview'
import { translateSessionEvidence } from '../../../shared/translation-contributions/session-evidence'
import { useStore } from '../store'
import { AgentTimeline } from '../components/timeline/AgentTimeline'
import { createT211BTranslator } from '../components/timeline/translations'
import { ContextLedgerPanel } from '../components/context-inspector/ContextLedgerPanel'
import { InteractionLedger } from '../components/interaction-ledger/InteractionLedger'
import { ProviderDoctor } from '../components/provider-doctor/ProviderDoctor'
import { SessionEvidencePanel } from '../components/session-evidence/SessionEvidencePanel'
import { WorkspaceTabs } from '../components/workspace-tabs/WorkspaceTabs'
import { CatalogNavigator, CatalogOnboarding, RootSettingsList, type CatalogSidebarMode } from '../components/catalog/CatalogNavigator'
import { contextLedgerLabels } from './merge1-translations'

const EMPTY_READ_MODEL: TruthKernelSessionIpcReadModel = {
  timeline: [], context: null, interactions: [], externalEvidence: [],
  orchestration: {
    mode: 'read-only', runs: 0, linkedRuns: 0, usageAggregates: [], diagnostics: [],
    coverage: { state: 'unavailable', coveredFactIds: [], missingDimensions: ['not-loaded'], evidence: [] }
  },
  availability: { timeline: 'unavailable', context: 'unavailable', externalEvidence: 'unavailable' }
}

interface TruthKernelSessionContextValue {
  readModel: TruthKernelSessionIpcReadModel
  loading: boolean
  load(): Promise<void>
  attachEvidence(): Promise<void>
}

const TruthKernelSessionContext = createContext<TruthKernelSessionContextValue>({
  readModel: EMPTY_READ_MODEL, loading: false, load: async () => {}, attachEvidence: async () => {}
})

/** Demand loading keeps a long chat's initial render independent of Truth Kernel size. */
export function TruthKernelSessionProvider({ children }: { children: ReactNode }) {
  const selected = useStore((state) => state.selectedSession)
  const [readModel, setReadModel] = useState<TruthKernelSessionIpcReadModel>(EMPTY_READ_MODEL)
  const [loading, setLoading] = useState(false)
  const loadFlight = useRef<Promise<void> | null>(null)
  const selectedKey = `${selected?.sessionId || ''}\0${selected?.filePath || ''}`
  const selectedKeyRef = useRef(selectedKey)

  useEffect(() => {
    selectedKeyRef.current = selectedKey
    loadFlight.current = null
    setReadModel(EMPTY_READ_MODEL)
    setLoading(false)
  }, [selectedKey])

  const load = useCallback((): Promise<void> => {
    if (!selected?.sessionId || !selected.filePath) return Promise.resolve()
    if (loadFlight.current) return loadFlight.current
    const requestKey = selectedKey
    setLoading(true)
    loadFlight.current = window.api.loadTruthKernelSession(selected.sessionId, selected.filePath)
      .then((value) => { if (selectedKeyRef.current === requestKey) setReadModel(value) })
      .catch(() => { if (selectedKeyRef.current === requestKey) setReadModel(EMPTY_READ_MODEL) })
      .finally(() => { if (selectedKeyRef.current === requestKey) setLoading(false) })
    return loadFlight.current
  }, [selected?.sessionId, selected?.filePath, selectedKey])

  const attachEvidence = useCallback(async (): Promise<void> => {
    if (!selected?.sessionId || !selected.filePath) return
    const result = await window.api.attachTruthKernelExternalEvidence(selected.sessionId, selected.filePath)
    if (!result.canceled && result.attachment && selectedKeyRef.current === selectedKey) {
      setReadModel((current) => ({
        ...current,
        externalEvidence: [...current.externalEvidence.filter(({ attachment }) => attachment.revisionId !== result.attachment!.revisionId), { attachment: result.attachment! }],
        availability: { ...current.availability, externalEvidence: 'available' }
      }))
    }
  }, [selected?.sessionId, selected?.filePath, selectedKey])

  const value = useMemo(() => ({ readModel, loading, load, attachEvidence }), [readModel, loading, load, attachEvidence])
  return <TruthKernelSessionContext.Provider value={value}>{children}</TruthKernelSessionContext.Provider>
}

export function TruthKernelTimelineSlot() {
  const selected = useStore((state) => state.selectedSession)
  const { readModel, loading, load } = useContext(TruthKernelSessionContext)
  const locale = useStore((state) => state.locale)
  const t = createT211BTranslator(locale === 'zh-CN' ? 'zh' : 'en')
  const [open, setOpen] = useState(false)
  if (!selected) return null
  return <section className="shrink-0 border-b border-edge bg-base" data-testid="truth-kernel-timeline-slot">
    <button type="button" onClick={() => {
      if (open) setOpen(false)
      else void load().then(() => setOpen(true))
    }} className="flex w-full items-center justify-between px-4 py-2 text-xs text-secondary hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent" aria-expanded={open}>
      <span>{t('timeline.label')}</span><span>{loading ? '…' : readModel.timeline.length}</span>
    </button>
    {open && readModel.availability.timeline === 'available' && <div className="max-h-[42vh] overflow-y-auto px-4 py-3"><AgentTimeline events={readModel.timeline} locale={locale === 'zh-CN' ? 'zh' : 'en'} /></div>}
  </section>
}

export function TruthKernelInspectorSlots() {
  const { readModel, load, attachEvidence } = useContext(TruthKernelSessionContext)
  const locale = useStore((state) => state.locale)
  const featureLocale = locale === 'zh-CN' ? 'zh' : 'en'
  useEffect(() => { void load() }, [load])
  return <div className="space-y-3" data-testid="truth-kernel-inspector-slots">
    {readModel.context && <ContextLedgerPanel projection={readModel.context} labels={contextLedgerLabels(locale)} />}
    <div className="rounded-md border border-edge p-3 text-xs"><InteractionLedger interactions={readModel.interactions} locale={featureLocale} /></div>
    <section className="rounded-md border border-edge p-3 text-xs" data-testid="multica-readonly-surface">
      <div className="font-medium text-primary">Multica · {readModel.orchestration.mode}</div>
      <div className="mt-1 text-muted">Runs {readModel.orchestration.runs} · linked {readModel.orchestration.linkedRuns} · usage {readModel.orchestration.usageAggregates.length} · {readModel.orchestration.coverage.state}</div>
    </section>
    <button type="button" onClick={() => {
      if (window.confirm(translateSessionEvidence(featureLocale, 'sessionEvidence.manualConfirm'))) void attachEvidence()
    }} className="rounded border border-edge px-2 py-1 text-xs text-primary hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent">
      {translateSessionEvidence(featureLocale, 'sessionEvidence.manualConfirm')}
    </button>
    {readModel.externalEvidence.length > 0
      ? readModel.externalEvidence.map(({ attachment, verification }) => <SessionEvidencePanel key={attachment.revisionId} attachment={attachment} verification={verification} locale={featureLocale} />)
      : <section className="rounded-md border border-edge p-3 text-xs text-muted" aria-label={translateSessionEvidence(featureLocale, 'sessionEvidence.title')}>
          <div className="font-medium text-primary">{translateSessionEvidence(featureLocale, 'sessionEvidence.title')}</div>
          <div className="mt-1">{translateSessionEvidence(featureLocale, 'sessionEvidence.assessment.unknown')}</div>
        </section>}
  </div>
}

export function ProviderDoctorSlot() {
  const locale = useStore((state) => state.locale)
  const [open, setOpen] = useState(false)
  const [providers, setProviders] = useState<Awaited<ReturnType<typeof window.api.loadTruthKernelProviderDoctor>>>([])
  const [loading, setLoading] = useState(false)
  const featureLocale = locale === 'zh-CN' ? 'zh' : 'en'
  const t = createT211BTranslator(featureLocale)
  return <section className="space-y-3" data-testid="provider-doctor-slot">
    <button
      type="button"
      aria-expanded={open}
      onClick={() => {
        if (open) { setOpen(false); return }
        setOpen(true); setLoading(true)
        void window.api.loadTruthKernelProviderDoctor().then(setProviders).finally(() => setLoading(false))
      }}
      className="flex w-full items-center justify-between rounded-md border border-edge px-3 py-2 text-left text-xs font-medium text-primary hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent"
    >
      <span>{t('doctor.label')}</span><span aria-hidden="true">{open ? '−' : '+'}</span>
    </button>
    {open && (loading ? <div className="text-xs text-muted">…</div> : <ProviderDoctor providers={providers} locale={featureLocale} />)}
  </section>
}

const unavailable = <T,>(reason: string): { status: 'unavailable'; reason: string } => ({ status: 'unavailable', reason })
const allScope = (): CatalogScope => ({
  logicalSessionIds: [], rootIds: [], collectionIds: [], providerIds: [], projectIds: [], pathPrefixes: [],
  timeRange: unavailable<{ from?: string; to?: string }>('no time filter'),
  textQuery: unavailable<string>('no text filter'), emptyFilterSemantics: 'all-catalog' as const
})

function workspaceTab(tabId: string, title: string, scope = allScope()): WorkspaceTab {
  return {
    schemaVersion: 1, tabId, title,
    scope,
    view: 'sessions', sidebarMode: 'collections', selectedObjectId: unavailable('no selection'),
    filters: {}, sort: unavailable('default order'), navigationHistory: [],
    scrollState: { anchorObjectId: unavailable('no anchor'), offsetPx: 0 },
    layoutState: { density: 'comfortable', inspectorOpen: true, splitRatio: unavailable('uses current shell width') },
    pinned: tabId === 'all', persisted: true
  }
}

interface CatalogContextValue {
  state: TruthKernelCatalogIpcState | null
  activeTabId: string
  setActiveTabId(value: string): void
  update(next: TruthKernelCatalogIpcState): void
}

const CatalogContext = createContext<CatalogContextValue>({ state: null, activeTabId: 'all', setActiveTabId: () => {}, update: () => {} })

export function TruthKernelCatalogProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<TruthKernelCatalogIpcState | null>(null)
  const [activeTabId, setActiveTabId] = useState('all')
  useEffect(() => { void window.api.loadTruthKernelCatalog().then((next) => {
    setState(next)
    setActiveTabId(next.activeTabId)
  }) }, [])
  const value = useMemo(() => ({ state, activeTabId, setActiveTabId, update: setState }), [state, activeTabId])
  return <CatalogContext.Provider value={value}>{children}</CatalogContext.Provider>
}

export function WorkspaceTabsSlot() {
  const locale = useStore((state) => state.locale)
  const { state, activeTabId, setActiveTabId, update } = useContext(CatalogContext)
  const tabs = state?.tabs ?? []
  if (!state) return <div className="h-9 border-b border-edge bg-base" />
  const persist = (tab: WorkspaceTab) => void window.api.saveTruthKernelCatalogTab(tab).then(update)
  const activate = (tabId: string) => void window.api.setActiveTruthKernelCatalogTab(tabId).then((next) => { update(next); setActiveTabId(next.activeTabId) })
  return <WorkspaceTabs
    tabs={tabs} activeTabId={activeTabId} locale={locale === 'zh-CN' ? 'zh' : 'en'}
    onActivate={activate}
    onClose={(tabId) => void window.api.removeTruthKernelCatalogTab(tabId).then((next) => { update(next); if (activeTabId === tabId) setActiveTabId(next.tabs[0]?.tabId ?? 'all') })}
    onCreate={() => {
      const source = tabs.find((tab) => tab.tabId === activeTabId)
      const tab = workspaceTab(`workspace:${Date.now()}`, `${source?.title ?? 'Workspace'} copy`, source?.scope ?? allScope())
      void window.api.saveTruthKernelCatalogTab(tab).then(() => activate(tab.tabId))
    }}
    onPin={(tabId, pinned) => { const tab = tabs.find((entry) => entry.tabId === tabId); if (tab) persist({ ...tab, pinned }) }}
    onDuplicate={(tabId) => { const source = tabs.find((entry) => entry.tabId === tabId); if (!source) return; const tab = { ...source, tabId: `workspace:${Date.now()}`, title: `${source.title} copy`, pinned: false }; void window.api.saveTruthKernelCatalogTab(tab).then(() => activate(tab.tabId)) }}
    onRename={(tabId) => { const source = tabs.find((entry) => entry.tabId === tabId); if (!source) return; const title = window.prompt('Workspace title', source.title)?.trim(); if (title) persist({ ...source, title }) }}
  />
}

export function CatalogSurfaceSlot() {
  const locale = useStore((state) => state.locale)
  const featureLocale = locale === 'zh-CN' ? 'zh' : 'en'
  const { state, activeTabId, update } = useContext(CatalogContext)
  const [open, setOpen] = useState(false)
  const active = state?.tabs.find((tab) => tab.tabId === activeTabId)
  const mode: CatalogSidebarMode = active?.sidebarMode ?? 'collections'
  if (!state || !active) return null
  const save = (tab: WorkspaceTab) => void window.api.saveTruthKernelCatalogTab(tab).then(update)
  const scope = (id: string) => {
    const next = { ...allScope() }
    if (id.startsWith('collection:')) next.collectionIds = [id.slice('collection:'.length)]
    else if (id.startsWith('source:')) next.providerIds = [id.slice('source:'.length)]
    else next.rootIds = [id]
    save({ ...active, scope: next })
  }
  return <section className="shrink-0 border-b border-edge bg-base" data-testid="truth-kernel-catalog-surface">
    <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} className="w-full px-3 py-1 text-left text-xs text-secondary hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent">Catalog · {state.coverage.knownLogicalSessions}</button>
    {open && <div className="grid max-h-[45vh] grid-cols-1 overflow-y-auto border-t border-edge sm:grid-cols-[minmax(180px,28%)_1fr] sm:overflow-hidden">
      <CatalogNavigator mode={mode} onModeChange={(sidebarMode) => save({ ...active, sidebarMode })} collections={state.collections} roots={state.roots} sources={state.sources} coverage={state.coverage} onScope={scope} locale={featureLocale} />
      <div className="min-w-0 space-y-3 overflow-y-auto p-3">
        <RootSettingsList roots={state.roots} locale={featureLocale} onAdd={() => void window.api.addTruthKernelCatalogRoot().then(update)} onRemove={(rootId) => void window.api.removeTruthKernelCatalogRoot(rootId).then(update)} onRescan={(rootId) => void window.api.rescanTruthKernelCatalogRoot(rootId).then(update)} />
        {!state.onboardingChoice && <CatalogOnboarding
          preview={state.onboardingPreview ? createCatalogOnboardingPreview(state.onboardingPreview) : undefined}
          choice={state.onboardingChoice}
          onChoice={(choice) => void window.api.decideTruthKernelCatalogOnboarding(choice).then(update)}
          locale={featureLocale}
        />}
      </div>
    </div>}
  </section>
}
