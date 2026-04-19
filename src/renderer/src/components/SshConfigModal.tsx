import { useState } from 'react'
import { X, Terminal, Server } from 'lucide-react'
import { useStore, type SshConfig } from '../store'

interface Props {
  onClose: () => void
}

export function SshConfigModal({ onClose }: Props) {
  const { sshConfig, setSshConfig } = useStore()
  const [host, setHost] = useState(sshConfig?.host ?? '')
  const [user, setUser] = useState(sshConfig?.user ?? '')
  const [remotePath, setRemotePath] = useState(sshConfig?.remotePath ?? '')
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    if (!host.trim() || !user.trim()) return
    setSaving(true)
    const cfg: SshConfig = {
      host: host.trim(),
      user: user.trim(),
      ...(remotePath.trim() ? { remotePath: remotePath.trim() } : {})
    }
    await setSshConfig(cfg)
    setSaving(false)
    onClose()
  }

  async function handleClear() {
    await setSshConfig(null)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-base border border-edge rounded-xl shadow-2xl w-[420px] p-6 flex flex-col gap-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Server size={16} className="text-accent" />
            <span className="text-primary font-semibold text-sm">SSH 远程访问配置</span>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-hover rounded text-muted hover:text-primary">
            <X size={14} />
          </button>
        </div>

        <p className="text-xs text-muted leading-relaxed">
          配置远程主机（如 Mac Mini），在 MacBook 上可一键 SSH 到该主机并恢复会话。
        </p>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-secondary">主机地址 <span className="text-red-400">*</span></label>
            <input
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="mac-mini.local 或 192.168.1.x"
              className="px-3 py-2 text-sm bg-surface border border-edge rounded-lg text-primary placeholder:text-muted focus:outline-none focus:border-accent"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-secondary">SSH 用户名 <span className="text-red-400">*</span></label>
            <input
              value={user}
              onChange={(e) => setUser(e.target.value)}
              placeholder="username"
              className="px-3 py-2 text-sm bg-surface border border-edge rounded-lg text-primary placeholder:text-muted focus:outline-none focus:border-accent"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-secondary">Claude 可执行路径（可选）</label>
            <input
              value={remotePath}
              onChange={(e) => setRemotePath(e.target.value)}
              placeholder="/usr/local/bin/claude（留空使用默认）"
              className="px-3 py-2 text-sm bg-surface border border-edge rounded-lg text-primary placeholder:text-muted focus:outline-none focus:border-accent"
            />
            <span className="text-[10px] text-faint">如果远程 claude 不在 PATH，填写完整路径</span>
          </div>
        </div>

        {host && user && (
          <div className="bg-surface rounded-lg px-3 py-2 flex items-center gap-2">
            <Terminal size={12} className="text-muted shrink-0" />
            <code className="text-xs text-secondary truncate">
              ssh -t {user}@{host} &quot;claude --resume &lt;id&gt;&quot;
            </code>
          </div>
        )}

        <div className="flex items-center gap-2 pt-1">
          {sshConfig && (
            <button
              onClick={handleClear}
              className="px-3 py-1.5 text-xs text-red-400 hover:bg-red-400/10 rounded-lg border border-red-400/30"
            >
              清除配置
            </button>
          )}
          <div className="flex-1" />
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-muted hover:bg-hover rounded-lg"
          >
            取消
          </button>
          <button
            onClick={handleSave}
            disabled={!host.trim() || !user.trim() || saving}
            className="px-4 py-1.5 text-xs bg-accent text-white rounded-lg hover:bg-accent/80 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
