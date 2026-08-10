import { Archive, Database, FolderTree, HardDrive, Radio, ShieldAlert } from 'lucide-react'
import type { ArchiveCoverage, Collection, StorageRoot, StorageRootObservation } from '../../../../shared/contracts/truth-kernel'
import { translateCatalog, type CatalogLocale, type CatalogTranslationKey } from '../../../../shared/i18n-contributions/t211e-device-catalog'
import { readCatalogOnboardingPreview, type CatalogOnboardingArchiveChoice, type CatalogOnboardingPreview } from '../../../../shared/catalog-onboarding-preview'

export type CatalogSidebarMode = 'collections' | 'locations' | 'sources'

export interface CatalogNavigatorProps {
  mode: CatalogSidebarMode
  onModeChange(mode: CatalogSidebarMode): void
  collections: Collection[]
  roots: Array<{ root: StorageRoot; observation?: StorageRootObservation }>
  sources: Array<{ id: string; label: string; count: number }>
  coverage: ArchiveCoverage
  onScope(rootId: string): void
  onCoverageDrillDown?(state: 'known' | 'archived' | 'source-only' | 'offline'): void
  locale?: CatalogLocale
}

const modeItems: Array<{ id: CatalogSidebarMode; labelKey: CatalogTranslationKey; Icon: typeof FolderTree }> = [
  { id: 'collections', labelKey: 'catalog.mode.collections', Icon: FolderTree },
  { id: 'locations', labelKey: 'catalog.mode.locations', Icon: HardDrive },
  { id: 'sources', labelKey: 'catalog.mode.sources', Icon: Radio }
]

const rootKindKey: Record<StorageRoot['kind'], CatalogTranslationKey> = {
  'managed-library': 'catalog.root.kind.managed_library',
  'obsidian-vault': 'catalog.root.kind.obsidian_vault',
  'project-folder': 'catalog.root.kind.project_folder',
  'external-folder': 'catalog.root.kind.external_folder'
}

const rootLayoutKey: Record<StorageRoot['layoutPolicy'], CatalogTranslationKey> = {
  'loose-root': 'catalog.root.layout.loose_root',
  'managed-containers': 'catalog.root.layout.managed_containers',
  'preserve-user-layout': 'catalog.root.layout.preserve_user_layout'
}

const rootAvailabilityKey: Record<NonNullable<StorageRootObservation>['availabilityState'], CatalogTranslationKey> = {
  online: 'catalog.root.state.online',
  offline: 'catalog.root.state.offline',
  unavailable: 'catalog.root.state.unavailable',
  unknown: 'catalog.root.state.unknown'
}

export function CatalogNavigator({ mode, onModeChange, collections, roots, sources, coverage, onScope, onCoverageDrillDown, locale = 'en' }: CatalogNavigatorProps) {
  const t = (key: CatalogTranslationKey, params?: Record<string, string | number>) => translateCatalog(locale, key, params)
  return <section aria-label={t('catalog.navigator.aria')} className="flex min-h-0 flex-col border-r border-edge bg-base">
    <div className="flex border-b border-edge p-1" role="tablist" aria-label={t('catalog.navigator.mode_aria')}>
      {modeItems.map(({ id, labelKey, Icon }) => <button key={id} role="tab" aria-selected={mode === id} onClick={() => onModeChange(id)} className={`flex flex-1 items-center justify-center gap-1 rounded px-1.5 py-1.5 text-[11px] focus-visible:ring-2 focus-visible:ring-accent ${mode === id ? 'bg-surface text-primary' : 'text-muted hover:bg-surface'}`}><Icon size={13} /><span className="truncate">{t(labelKey)}</span></button>)}
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto p-2">
      {mode === 'collections' && <div className="space-y-1">{collections.map((collection) => <button key={collection.collectionId} onClick={() => onScope(`collection:${collection.collectionId}`)} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-surface focus-visible:ring-2 focus-visible:ring-accent"><FolderTree size={14} className="text-accent" /><span className="truncate">{collection.name}</span></button>)}</div>}
      {mode === 'locations' && <div className="space-y-1">{roots.map(({ root, observation }) => {
        const offline = observation?.availabilityState !== 'online'
        return <button key={root.rootId} onClick={() => onScope(root.rootId)} className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-surface focus-visible:ring-2 focus-visible:ring-accent ${offline ? 'text-muted' : ''}`}><HardDrive size={14} className={offline ? 'text-soft-amber' : 'text-soft-green'} /><span className="min-w-0 flex-1 truncate">{root.displayName}</span>{offline && <span className="shrink-0 text-[10px]">{t('catalog.location.stale')}</span>}</button>
      })}</div>}
      {mode === 'sources' && <div className="space-y-1">{sources.map((source) => <button key={source.id} onClick={() => onScope(`source:${source.id}`)} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-surface focus-visible:ring-2 focus-visible:ring-accent"><Radio size={14} className="text-soft-blue" /><span className="min-w-0 flex-1 truncate">{source.label}</span><span className="text-xs text-muted">{source.count}</span></button>)}</div>}
    </div>
    <div className="border-t border-edge p-2 text-xs text-secondary" aria-label={t('catalog.coverage.aria')}>
      <div className="mb-1 flex items-center gap-1 font-medium"><Archive size={13} /> {t('catalog.coverage.title')}</div>
      <div className="grid grid-cols-2 gap-x-2 gap-y-1">
        <button type="button" className="text-left hover:underline" onClick={() => onCoverageDrillDown?.('known')}>{t('catalog.coverage.known', { count: coverage.knownLogicalSessions })}</button><button type="button" className="text-left hover:underline" onClick={() => onCoverageDrillDown?.('archived')}>{t('catalog.coverage.archived', { count: coverage.archivedLogicalSessions })}</button>
        <button type="button" className="text-left hover:underline" onClick={() => onCoverageDrillDown?.('source-only')}>{t('catalog.coverage.source_only', { count: coverage.sourceOnlyLogicalSessions })}</button><button type="button" className="text-left hover:underline" onClick={() => onCoverageDrillDown?.('offline')}>{t('catalog.coverage.offline', { count: coverage.offlineLogicalSessions })}</button>
        {coverage.conflictedLogicalSessions > 0 && <span className="col-span-2 flex items-center gap-1 text-soft-amber"><ShieldAlert size={12} /> {t('catalog.coverage.conflicts', { count: coverage.conflictedLogicalSessions })}</span>}
      </div>
    </div>
  </section>
}

export function RootSettingsList({ roots, onAdd, onRemove, onRescan, locale = 'en' }: { roots: Array<{ root: StorageRoot; observation?: StorageRootObservation }>; onAdd?(): void; onRemove?(rootId: string): void; onRescan?(rootId: string): void; locale?: CatalogLocale }) {
  const t = (key: CatalogTranslationKey, params?: Record<string, string | number>) => translateCatalog(locale, key, params)
  return <section aria-label={t('catalog.roots.aria')} className="space-y-2">
    {onAdd && <button type="button" onClick={onAdd} className="rounded border border-edge px-2 py-1 text-xs">{t('catalog.root.add')}</button>}
    {roots.map(({ root, observation }) => <div key={root.rootId} className="rounded-lg border border-edge bg-surface p-3">
      <div className="flex items-center gap-2"><Database size={16} className="text-accent" /><span className="min-w-0 flex-1 truncate font-medium">{root.displayName}</span><span className="rounded bg-base px-1.5 py-0.5 text-[10px] text-muted">{t('catalog.root.read_only')}</span></div>
      <div className="mt-1 text-xs text-secondary">{t(rootKindKey[root.kind])} · {t(rootLayoutKey[root.layoutPolicy])}</div>
      <div className={`mt-1 text-xs ${observation?.availabilityState === 'online' ? 'text-soft-green' : 'text-soft-amber'}`}>{observation?.permissionState === 'denied' ? t('catalog.root.permission_denied') : observation?.availabilityState === 'online' ? t('catalog.root.online') : t('catalog.root.stale', { state: t(rootAvailabilityKey[observation?.availabilityState || 'unknown']) })}</div>
      {(onRescan || onRemove) && <div className="mt-2 flex gap-2">{onRescan && <button type="button" onClick={() => onRescan(root.rootId)} className="rounded border border-edge px-2 py-1 text-xs">{t('catalog.root.rescan')}</button>}{onRemove && <button type="button" onClick={() => onRemove(root.rootId)} className="rounded border border-edge px-2 py-1 text-xs">{t('catalog.root.remove')}</button>}</div>}
    </div>)}
  </section>
}

export function CatalogOnboarding({ preview, choice, onChoice, locale = 'en' }: { preview?: CatalogOnboardingPreview; choice?: CatalogOnboardingArchiveChoice; onChoice(choice: CatalogOnboardingArchiveChoice, preview: CatalogOnboardingPreview): void; locale?: CatalogLocale }) {
  const t = (key: CatalogTranslationKey, params?: Record<string, string | number>) => translateCatalog(locale, key, params)
  const derived = readCatalogOnboardingPreview(preview)
  const choices: Array<{ id: CatalogOnboardingArchiveChoice; key: CatalogTranslationKey }> = [
    { id: 'default-library', key: 'catalog.onboarding.default_library' },
    { id: 'index-only', key: 'catalog.onboarding.index_only' },
    { id: 'skip', key: 'catalog.onboarding.skip' }
  ]
  return <section aria-label={t('catalog.onboarding.aria')} className="rounded-lg border border-edge bg-surface p-4">
    <h2 className="font-semibold">{t('catalog.onboarding.title')}</h2>
    {!derived && <p className="mt-1 text-sm text-secondary">{t('catalog.onboarding.preview_unavailable')}</p>}
    {derived && <><p className="mt-1 text-sm text-secondary">{t('catalog.onboarding.preview', { sessions: derived.sessionCount, size: Math.ceil(derived.estimatedArchiveBytes / 1024 / 1024) })}</p>
      <p className="mt-1 text-xs text-muted">{t('catalog.onboarding.privacy', { scopes: derived.privacyScopes.join(', ') })}</p>
      <p className="mt-2 text-xs text-secondary">{derived.complete ? t('catalog.onboarding.read_only') : t('catalog.onboarding.preview_partial')}</p>
      {derived.complete && <div className="mt-3 grid gap-2">{choices.map((item) => <button key={item.id} type="button" aria-pressed={choice === item.id} onClick={() => onChoice(item.id, preview!)} className={`rounded border px-3 py-2 text-left text-sm ${choice === item.id ? 'border-accent bg-base' : 'border-edge'}`}>{t(item.key)}</button>)}</div>}</>}
  </section>
}
