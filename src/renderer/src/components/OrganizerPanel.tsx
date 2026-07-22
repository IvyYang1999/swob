import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, Check, FolderKanban, LoaderCircle, Sparkles, X } from 'lucide-react'
import { useStore, type OrganizationApplyItem } from '../store'
import { translate } from '../i18n'

type OrganizerKind = 'project' | 'smart'

interface PreviewItem extends OrganizationApplyItem {
  title: string
  fromRelative?: string
  selected: boolean
}

export function OrganizerPanel({ kind, sidebarWidth, onClose }: {
  kind: OrganizerKind
  sidebarWidth: number
  onClose: () => void
}) {
  const applyOrganization = useStore((state) => state.applyOrganization)
  const locale = useStore((state) => state.locale)
  const t = (key: string, params?: Record<string, string | number>) => translate(locale, key, params)
  const [items, setItems] = useState<PreviewItem[]>([])
  const [loading, setLoading] = useState(true)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    const load = kind === 'project'
      ? window.api.organizerPreviewProject().then((rows) => rows.map((row) => ({
          sessionId: row.sessionId,
          targetRelativeFolder: row.targetRelativeFolder,
          title: row.title,
          fromRelative: row.fromRelative,
          selected: true
        })))
      : window.api.organizerPreviewSmart().then((result) => {
          if (!result.ok) throw new Error(result.errorCode)
          return result.items.map((row) => ({
            sessionId: row.sessionId,
            targetRelativeFolder: row.folder,
            title: row.title,
            topic: row.topic,
            tags: row.tags,
            confidence: row.confidence,
            selected: true
          }))
        })
    load.then((rows) => {
      if (!cancelled) setItems(rows)
    }).catch((reason) => {
      if (cancelled) return
      const errorCode = reason instanceof Error ? reason.message : 'organizer.error.preview_failed'
      setError(t(errorCode.startsWith('organizer.error.') ? errorCode : 'organizer.error.preview_failed'))
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [kind, locale])

  const selectedItems = useMemo(() => items.filter((item) => item.selected), [items])

  const patchItem = (sessionId: string, patch: Partial<PreviewItem>): void => {
    setItems((current) => current.map((item) => item.sessionId === sessionId ? { ...item, ...patch } : item))
  }

  async function apply(itemsToApply: PreviewItem[]): Promise<void> {
    if (itemsToApply.length === 0) return
    setApplying(true)
    setError('')
    try {
      await applyOrganization(kind, itemsToApply.map(({ selected: _selected, title: _title, fromRelative: _from, ...item }) => item))
      const appliedIds = new Set(itemsToApply.map((item) => item.sessionId))
      setItems((current) => current.filter((item) => !appliedIds.has(item.sessionId)))
      if (itemsToApply.length === items.length) onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setApplying(false)
    }
  }

  const title = kind === 'project' ? t('renderer.organizer.project_title') : t('renderer.organizer.smart_title')
  const Icon = kind === 'project' ? FolderKanban : Sparkles

  return (
    <aside
      data-testid="organizer-panel"
      className="fixed top-[52px] bottom-4 z-40 flex flex-col bg-base border border-edge-strong rounded-lg shadow-2xl overflow-hidden"
      style={{ left: sidebarWidth + 8, width: `min(720px, calc(100vw - ${sidebarWidth + 28}px))` }}
    >
      <header className="p-4 border-b border-edge flex items-start gap-3">
        <div className="mt-0.5 text-accent"><Icon size={18} /></div>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-medium text-bright">{title}</h2>
          <p className="text-xs text-muted mt-1">
            {kind === 'project'
              ? t('renderer.organizer.project_hint')
              : t('renderer.organizer.smart_hint')}
          </p>
        </div>
        <button onClick={onClose} className="p-1 text-muted hover:text-primary hover:bg-hover rounded" aria-label={t('renderer.organizer.close')}>
          <X size={16} />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-4">
        {loading && (
          <div className="h-full flex items-center justify-center gap-2 text-sm text-secondary">
            <LoaderCircle size={16} className="animate-spin" />
            {kind === 'project' ? t('renderer.organizer.loading_project') : t('renderer.organizer.loading_smart')}
          </div>
        )}
        {!loading && error && (
          <div className="p-3 rounded bg-soft-red/10 border border-soft-red/20 text-sm text-soft-red">{error}</div>
        )}
        {!loading && !error && items.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center text-center">
            <Check size={24} className="text-soft-green mb-3" />
            <div className="text-sm text-primary">{t('renderer.organizer.done')}</div>
            <div className="text-xs text-muted mt-1">{t('renderer.organizer.empty')}</div>
          </div>
        )}
        {!loading && items.length > 0 && (
          <div className="space-y-2">
            {items.map((item) => (
              <div key={item.sessionId} className="grid grid-cols-[20px_minmax(0,1fr)_18px_minmax(160px,0.8fr)_auto] gap-2 items-center px-3 py-2.5 border-b border-edge-subtle">
                <input
                  type="checkbox"
                  checked={item.selected}
                  onChange={(event) => patchItem(item.sessionId, { selected: event.target.checked })}
                  className="accent-accent"
                  aria-label={t('renderer.organizer.select', { value0: item.title })}
                />
                <div className="min-w-0">
                  <div className="text-sm text-primary truncate" title={item.title}>{item.title}</div>
                  <div className="text-[11px] text-faint truncate">{item.fromRelative || item.topic || item.sessionId}</div>
                  {item.tags && item.tags.length > 0 && (
                    <div className="flex gap-1 mt-1 overflow-hidden">
                      {item.tags.map((tag) => <span key={tag} className="px-1 py-0.5 rounded text-[10px] bg-soft-purple/10 text-soft-purple">{tag}</span>)}
                    </div>
                  )}
                </div>
                <ArrowRight size={14} className="text-faint" />
                <div className="min-w-0">
                  <input
                    value={item.targetRelativeFolder}
                    onChange={(event) => patchItem(item.sessionId, { targetRelativeFolder: event.target.value })}
                    className="w-full px-2 py-1.5 text-xs bg-surface border border-edge rounded text-primary focus:outline-none focus:border-accent"
                    aria-label={t('renderer.organizer.target_folder', { value0: item.title })}
                  />
                  {item.confidence !== undefined && (
                    <div className="text-[10px] text-muted mt-1">{t('renderer.organizer.confidence', { value0: Math.round(item.confidence * 100) })}</div>
                  )}
                </div>
                <button
                  disabled={applying}
                  onClick={() => void apply([item])}
                  className="px-2 py-1.5 text-[11px] text-secondary hover:text-primary hover:bg-hover rounded disabled:opacity-40"
                >
                  {t('renderer.organizer.only_this')}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {!loading && items.length > 0 && (
        <footer className="p-3 border-t border-edge flex items-center gap-2">
          <span className="text-xs text-muted">{t('renderer.organizer.selected', { value0: selectedItems.length, value1: items.length })}</span>
          <button onClick={onClose} className="ml-auto px-3 py-1.5 text-xs text-secondary hover:text-primary">{t('renderer.organizer.cancel')}</button>
          <button
            disabled={applying || selectedItems.length === 0}
            onClick={() => void apply(selectedItems)}
            className="px-3 py-1.5 rounded bg-accent text-bright text-xs font-medium hover:opacity-90 disabled:opacity-40"
          >
            {applying ? t('renderer.organizer.applying') : t('renderer.organizer.accept_selected', { value0: selectedItems.length })}
          </button>
        </footer>
      )}
    </aside>
  )
}
