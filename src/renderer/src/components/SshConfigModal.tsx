import { useState } from 'react'
import { X, Terminal, Server, ChevronDown, ChevronRight, ExternalLink } from 'lucide-react'
import { useStore, type SshConfig } from '../store'
import { useT } from '../i18n'

interface Props {
  onClose: () => void
}

export function SshConfigModal({ onClose }: Props) {
  const { sshConfig, setSshConfig } = useStore()
  const t = useT()
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
            <span className="text-primary font-semibold text-sm">{t('renderer.ssh_modal.title')}</span>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-hover rounded text-muted hover:text-primary">
            <X size={14} />
          </button>
        </div>

        <p className="text-xs text-secondary leading-relaxed">
          {t('renderer.ssh_modal.description')}
        </p>

        {/* 远程登录设置指引 */}
        <button
          onClick={() => setGuideOpen(!guideOpen)}
          className="flex items-center gap-1.5 text-xs font-medium text-soft-blue hover:text-soft-blue/80 w-full text-left"
        >
          {guideOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span>{t('renderer.ssh_modal.guide')}</span>
        </button>

        {guideOpen && (
          <div className="bg-surface rounded-lg p-3.5 flex flex-col gap-3 text-xs text-body leading-relaxed border border-edge-subtle">
            <div className="flex flex-col gap-1.5">
              <span className="font-medium text-primary">{t('renderer.ssh_modal.step1')}</span>
              <span className="text-secondary">
                {t('renderer.ssh_modal.step1_before')}<span className="font-medium text-primary">{t('renderer.ssh_modal.remote_login')}</span>{t('renderer.ssh_modal.switch')}
              </span>
              <span className="text-muted">
                {t('renderer.ssh_modal.prompt_before')} <code className="text-[11px] font-mono bg-hover px-1 py-0.5 rounded">ssh username@hostname</code> {t('renderer.ssh_modal.prompt_after')}
              </span>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="font-medium text-primary">{t('renderer.ssh_modal.step2')}</span>
              <span className="text-secondary">
                {t('renderer.ssh_modal.run_remote')} <code className="text-[11px] font-mono bg-hover px-1 py-0.5 rounded">hostname</code>{t('renderer.ssh_modal.hostname_result_before')} <code className="text-[11px] font-mono bg-hover px-1 py-0.5 rounded">mac-mini.local</code> {t('renderer.ssh_modal.hostname_result_after')}
              </span>
              <span className="text-muted">{t('renderer.ssh_modal.lan_ip_hint')}</span>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="font-medium text-primary">{t('renderer.ssh_modal.step3')}</span>
              <span className="text-secondary">
                {t('renderer.ssh_modal.run_remote')} <code className="text-[11px] font-mono bg-hover px-1 py-0.5 rounded">whoami</code>{t('renderer.ssh_modal.username_result')}
              </span>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="font-medium text-primary">{t('renderer.ssh_modal.step4')}</span>
              <span className="text-secondary">
                {t('renderer.ssh_modal.key_hint')}
              </span>
              <code className="text-[11px] font-mono bg-hover px-1.5 py-1 rounded block text-primary select-all">
                ssh-copy-id username@hostname
              </code>
            </div>
          </div>
        )}

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-secondary">{t('renderer.ssh_modal.host')} <span className="text-red-400">*</span></label>
            <input
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder={t('renderer.ssh_modal.host_placeholder')}
              className="px-3 py-2 text-sm bg-surface border border-edge rounded-lg text-primary placeholder:text-muted focus:outline-none focus:border-accent"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-secondary">{t('renderer.ssh_modal.username')} <span className="text-red-400">*</span></label>
            <input
              value={user}
              onChange={(e) => setUser(e.target.value)}
              placeholder={t('renderer.ssh_modal.username_placeholder')}
              className="px-3 py-2 text-sm bg-surface border border-edge rounded-lg text-primary placeholder:text-muted focus:outline-none focus:border-accent"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-secondary">{t('renderer.ssh_modal.executable')}</label>
            <input
              value={remotePath}
              onChange={(e) => setRemotePath(e.target.value)}
              placeholder={t('renderer.ssh_modal.executable_placeholder')}
              className="px-3 py-2 text-sm bg-surface border border-edge rounded-lg text-primary placeholder:text-muted focus:outline-none focus:border-accent"
            />
            <span className="text-[10px] text-faint">{t('renderer.ssh_modal.executable_hint')}</span>
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
              {t('renderer.ssh_modal.clear')}
            </button>
          )}
          <div className="flex-1" />
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-muted hover:bg-hover rounded-lg"
          >
            {t('renderer.ssh_modal.cancel')}
          </button>
          <button
            onClick={handleSave}
            disabled={!host.trim() || !user.trim() || saving}
            className="px-4 py-1.5 text-xs bg-accent text-white rounded-lg hover:bg-accent/80 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {saving ? t('renderer.ssh_modal.saving') : t('renderer.ssh_modal.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
