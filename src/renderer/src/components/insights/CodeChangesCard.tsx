export function CodeChangesCard({ changes }: { changes: { filesRead: number; filesWritten: number; filesEdited: number } }) {
  const total = changes.filesRead + changes.filesWritten + changes.filesEdited
  if (total === 0) return null
  return (
    <div className="bg-surface rounded-lg p-4 border border-edge space-y-2">
      <div className="text-sm font-medium text-primary">Code Changes</div>
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
