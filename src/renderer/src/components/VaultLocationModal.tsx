import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { FolderOpen, Truck, ArrowLeftRight, X, Check, AlertTriangle } from 'lucide-react'

type Mode = 'menu' | 'migrating' | 'migrated' | 'error'

export function VaultLocationModal({ currentPath, onClose, onPathChanged }: {
  currentPath: string
  onClose: () => void
  onPathChanged: (newPath: string) => void
}) {
  const { showToast } = useStore()
  const [mode, setMode] = useState<Mode>('menu')
  const [progress, setProgress] = useState<{ phase: string; copied: number; total: number } | null>(null)
  const [errorText, setErrorText] = useState('')
  const [newRoot, setNewRoot] = useState('')

  useEffect(() => {
    const unsubscribe = window.api.onVaultMigrateProgress?.((p) => setProgress(p))
    return () => { unsubscribe?.() }
  }, [])

  const shortPath = (value: string) => value.replace(/^\/Users\/[^/]+/, '~')

  async function handleSwitch() {
    const selected = await (window.api as any).librarySelectDirectory?.()
    if (!selected || selected === currentPath) return
    const isExisting = await (window.api as any).libraryIsInitialized?.(selected)
    const confirmMsg = isExisting
      ? `切换到已有库:\n${selected}\n\n当前库的内容保持原样，但不再显示。`
      : `在此位置创建新库:\n${selected}\n\n当前库的内容保持原样，但不再显示。`
    if (!window.confirm(confirmMsg)) return
    const root = await (window.api as any).libraryChangePath?.(selected)
    if (root) {
      onPathChanged(root)
      showToast('库位置已切换', 'success')
      onClose()
    }
  }

  async function handleMigrate() {
    const target = await window.api.vaultSelectMigrationTarget()
    if (!target) return
    setMode('migrating')
    setProgress(null)
    const result = await window.api.vaultMigrate(target)
    if (result.ok && result.newRoot) {
      setNewRoot(result.newRoot)
      onPathChanged(result.newRoot)
      setMode('migrated')
    } else {
      setErrorText(result.error || '迁移失败')
      setMode('error')
    }
  }

  const percent = progress && progress.total > 0
    ? Math.min(100, Math.round((progress.copied / progress.total) * 100))
    : 0

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center" onClick={mode === 'menu' ? onClose : undefined}>
      <div
        data-testid="vault-location-modal"
        className="w-[420px] max-w-[92vw] rounded-xl bg-base border border-edge shadow-2xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        {mode === 'menu' && (
          <>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-primary">库位置</h2>
              <button onClick={onClose} className="p-1 rounded hover:bg-hover text-muted hover:text-primary"><X size={14} /></button>
            </div>
            <div className="mb-5 px-3 py-2.5 rounded-lg bg-surface border border-edge flex items-center gap-2.5">
              <FolderOpen size={16} className="text-accent shrink-0" />
              <span className="text-xs text-primary truncate" title={currentPath}>{shortPath(currentPath)}</span>
            </div>
            <div className="space-y-2">
              <button
                onClick={handleMigrate}
                className="w-full px-3.5 py-3 rounded-lg border border-edge hover:border-edge-strong bg-surface/40 hover:bg-surface flex items-start gap-3 text-left"
              >
                <Truck size={16} className="text-soft-green shrink-0 mt-0.5" />
                <div>
                  <div className="text-sm text-primary">迁移到新位置…</div>
                  <div className="text-[11px] text-muted mt-0.5 leading-relaxed">完整复制到新文件夹并校验。原库保留不删，确认无误后可手动清理。</div>
                </div>
              </button>
              <button
                onClick={handleSwitch}
                className="w-full px-3.5 py-3 rounded-lg border border-edge hover:border-edge-strong bg-surface/40 hover:bg-surface flex items-start gap-3 text-left"
              >
                <ArrowLeftRight size={16} className="text-soft-blue shrink-0 mt-0.5" />
                <div>
                  <div className="text-sm text-primary">切换到其他库…</div>
                  <div className="text-[11px] text-muted mt-0.5 leading-relaxed">改用另一个位置的库（或新建空库）。当前库不移动。</div>
                </div>
              </button>
            </div>
          </>
        )}

        {mode === 'migrating' && (
          <div className="py-4 text-center">
            <div className="text-sm font-medium text-primary mb-4">正在迁移…请不要关闭 Swob</div>
            <div className="h-2 rounded-full bg-surface overflow-hidden mb-2">
              <div className="h-full bg-accent transition-all" style={{ width: `${percent}%` }} />
            </div>
            <div className="text-xs text-muted">
              {progress?.phase === 'verifying'
                ? '正在校验完整性…'
                : progress
                  ? `${progress.copied} / ${progress.total} 个文件`
                  : '正在统计文件…'}
            </div>
          </div>
        )}

        {mode === 'migrated' && (
          <div className="py-4 text-center">
            <div className="w-11 h-11 mx-auto rounded-full bg-soft-green/15 flex items-center justify-center mb-3">
              <Check size={20} className="text-soft-green" />
            </div>
            <div className="text-sm font-medium text-primary mb-1.5">迁移完成</div>
            <p className="text-xs text-secondary leading-relaxed mb-1">
              新位置：<span className="text-primary">{shortPath(newRoot)}</span>
            </p>
            <p className="text-xs text-muted leading-relaxed mb-4">
              原库已保留并留有 MOVED.md 说明，确认一切正常后可手动删除。
            </p>
            <button onClick={onClose} className="px-4 py-2 rounded-lg bg-accent/90 hover:bg-accent text-white text-xs font-medium">好的</button>
          </div>
        )}

        {mode === 'error' && (
          <div className="py-4 text-center">
            <div className="w-11 h-11 mx-auto rounded-full bg-soft-red/15 flex items-center justify-center mb-3">
              <AlertTriangle size={20} className="text-soft-red" />
            </div>
            <div className="text-sm font-medium text-primary mb-1.5">迁移未完成</div>
            <p className="text-xs text-secondary leading-relaxed mb-4">{errorText}<br />原库未受影响。</p>
            <button onClick={() => setMode('menu')} className="px-4 py-2 rounded-lg bg-surface hover:bg-hover text-primary text-xs font-medium border border-edge">返回</button>
          </div>
        )}
      </div>
    </div>
  )
}
