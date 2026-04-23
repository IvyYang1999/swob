import { useState } from 'react'
import { X, Terminal, Server, ChevronDown, ChevronRight, ExternalLink } from 'lucide-react'
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
  const [guideOpen, setGuideOpen] = useState(!sshConfig)

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
        className="bg-base border border-edge rounded-xl shadow-2xl w-[460px] max-h-[85vh] overflow-y-auto p-6 flex flex-col gap-4"
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

        <p className="text-xs text-secondary leading-relaxed">
          配置另一台 Mac 的远程登录信息，就能在这台设备上一键恢复另一台设备上的 Claude 会话。
        </p>

        {/* 远程登录设置指引 */}
        <button
          onClick={() => setGuideOpen(!guideOpen)}
          className="flex items-center gap-1.5 text-xs font-medium text-soft-blue hover:text-soft-blue/80 w-full text-left"
        >
          {guideOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span>不知道怎么填？看设置指引</span>
        </button>

        {guideOpen && (
          <div className="bg-surface rounded-lg p-3.5 flex flex-col gap-3 text-xs text-body leading-relaxed border border-edge-subtle">
            <div className="flex flex-col gap-1.5">
              <span className="font-medium text-primary">① 在远程 Mac 上开启"远程登录"</span>
              <span className="text-secondary">
                系统设置 → 通用 → 共享 → 打开<span className="font-medium text-primary">「远程登录」</span>开关
              </span>
              <span className="text-muted">
                开启后你会看到类似 <code className="text-[11px] font-mono bg-hover px-1 py-0.5 rounded">ssh username@hostname</code> 的提示
              </span>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="font-medium text-primary">② 获取主机名 / 地址</span>
              <span className="text-secondary">
                在远程 Mac 的终端里运行 <code className="text-[11px] font-mono bg-hover px-1 py-0.5 rounded">hostname</code>，
                得到类似 <code className="text-[11px] font-mono bg-hover px-1 py-0.5 rounded">mac-mini.local</code> 的结果，填到下面"主机地址"里
              </span>
              <span className="text-muted">也可以直接用局域网 IP 地址（如 192.168.1.x）</span>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="font-medium text-primary">③ 获取用户名</span>
              <span className="text-secondary">
                在远程 Mac 的终端里运行 <code className="text-[11px] font-mono bg-hover px-1 py-0.5 rounded">whoami</code>，
                得到的就是用户名
              </span>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="font-medium text-primary">④ 免密登录（推荐）</span>
              <span className="text-secondary">
                在本机终端运行以下命令，之后 SSH 就不用每次输密码了：
              </span>
              <code className="text-[11px] font-mono bg-hover px-1.5 py-1 rounded block text-primary select-all">
                ssh-copy-id username@hostname
              </code>
            </div>
          </div>
        )}

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
            <label className="text-xs text-secondary">用户名 <span className="text-red-400">*</span></label>
            <input
              value={user}
              onChange={(e) => setUser(e.target.value)}
              placeholder="远程 Mac 的用户名（whoami 的输出）"
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
