import { useT } from '../../i18n'

export function CodeChangesCard({ changes }: { changes: { filesRead: number; filesWritten: number; filesEdited: number } }) {
  const t = useT()
  const total = changes.filesRead + changes.filesWritten + changes.filesEdited
  if (total === 0) return null
  return (
    <div className="bg-surface rounded-lg p-4 border border-edge space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium text-primary">{t('renderer.code_changes.title')}</div>
        <span className="rounded bg-hover px-1.5 py-0.5 text-[9px] text-faint" title={t('renderer.code_changes.caveat')}>
          {t('renderer.code_changes.badge')}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-3 text-center">
        <div>
          <div className="text-lg font-bold text-soft-blue">{changes.filesRead.toLocaleString()}</div>
          <div className="text-[10px] text-muted">Files Read</div>
        </div>
        <div>
          <div className="text-lg font-bold text-soft-amber">{changes.filesEdited.toLocaleString()}</div>
          <div className="text-[10px] text-muted">Files Edited</div>
        </div>
        <div>
          <div className="text-lg font-bold text-soft-emerald">{changes.filesWritten.toLocaleString()}</div>
          <div className="text-[10px] text-muted">Files Created</div>
        </div>
      </div>
    </div>
  )
}
