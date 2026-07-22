import { useMemo } from 'react'
import { ChevronDown } from 'lucide-react'
import { useStore } from '../../store'
import { type Locale } from '../../i18n'
import { migrateSettingsPreferences } from '../../../../shared/settings-capabilities'
import { getHarnessPresentation } from '../../utils/harness-presentation'

export interface DetectedTerminal {
  id: string
  name: string
  path: string
  executable?: string
  commandSupport: 'stable' | 'conditional' | 'none'
  canRunCommand: boolean
  limitation?: string
  evidence: 'system-path' | 'app-path' | 'bundle-id' | 'executable'
}

export function copy(locale: Locale, zh: string, en: string, ja = en): string {
  return locale === 'zh-CN' ? zh : locale === 'ja' ? ja : en
}

/** Migrated preferences derived from store config — single source for all setting pages. */
export function useSettingsPreferences() {
  const { config } = useStore()
  return useMemo(
    () => migrateSettingsPreferences(config?.preferences as unknown as Record<string, unknown>),
    [config?.preferences]
  )
}

export function SettingField({ label, hint, icon, children }: {
  label: string
  hint?: string
  icon?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="space-y-2">
      <div>
        <div className="flex items-center gap-2 text-xs font-medium text-secondary">
          {icon}{label}
        </div>
        {hint && <p className="mt-1 text-[11px] leading-relaxed text-faint">{hint}</p>}
      </div>
      {children}
    </section>
  )
}

export function Segmented<T extends string>({ value, options, onChange, ariaLabel }: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
  ariaLabel: string
}) {
  return (
    <div className="flex flex-wrap gap-1" role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={`px-3 py-1.5 rounded-md text-xs transition-colors ${
            value === option.value
              ? 'bg-accent/15 text-accent font-medium'
              : 'bg-surface text-muted hover:bg-hover hover:text-primary'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function ToggleRow({ checked, onChange, label, hint }: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  hint?: string
}) {
  return (
    <label className="flex items-start justify-between gap-4 cursor-pointer">
      <span className="min-w-0">
        <span className="block text-xs text-primary">{label}</span>
        {hint && <span className="block mt-1 text-[11px] leading-relaxed text-faint">{hint}</span>}
      </span>
      <input
        type="checkbox"
        aria-label={label}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
      />
    </label>
  )
}

export function HarnessMark({ id }: { id: string }) {
  const p = getHarnessPresentation(id)
  if (p.iconImage) return <img src={p.iconImage} alt="" className="w-6 h-6 rounded-full shrink-0" />
  return (
    <span className={`w-6 h-6 rounded-full shrink-0 flex items-center justify-center text-[10px] font-medium ${p.badgeClass}`}>
      {p.shortLabel}
    </span>
  )
}

export function SshTutorial({ locale }: { locale: Locale }) {
  const items = [
    {
      title: copy(locale, '查找远程机器地址', 'Find the remote machine address', 'リモートマシンのアドレス'),
      body: copy(locale, '在远程机器运行 hostname，或在网络设置中查看 IP。优先使用稳定 hostname 或 Tailscale 地址。', 'Run hostname remotely or inspect its network IP. Prefer a stable hostname or Tailscale address.', 'リモート側で hostname を実行するか、ネットワーク設定で IP を確認します。')
    },
    {
      title: copy(locale, '配置 SSH key', 'Configure an SSH key', 'SSH キーを設定'),
      body: copy(locale, '本机运行 ssh-keygen，再用 ssh-copy-id user@host 安装公钥。私钥只保留在本机。', 'Run ssh-keygen locally, then ssh-copy-id user@host. Keep the private key only on this machine.', 'ローカルで ssh-keygen を実行し、ssh-copy-id user@host で公開鍵を登録します。')
    },
    {
      title: copy(locale, '测试连接', 'Test the connection', '接続をテスト'),
      body: copy(locale, '先在终端运行 ssh user@host。确认无需交互输入密码且目标目录存在后，再交给 Swob。', 'First run ssh user@host in a terminal. Confirm key login and the target path before using Swob.', 'ターミナルで ssh user@host を実行し、鍵ログインと対象パスを確認します。')
    }
  ]
  return (
    <SettingField label={copy(locale, '连接教程', 'Connection guide', '接続ガイド')} icon={<ChevronDown size={12} />}>
      <div className="space-y-1">
        {items.map((item) => (
          <details key={item.title} className="group rounded-md bg-surface">
            <summary className="cursor-pointer list-none px-3 py-2 text-xs text-secondary hover:text-primary flex items-center gap-2">
              <ChevronDown size={11} className="transition-transform group-open:rotate-180" />
              {item.title}
            </summary>
            <p className="px-3 pb-3 pl-8 text-[11px] leading-relaxed text-muted">{item.body}</p>
          </details>
        ))}
      </div>
    </SettingField>
  )
}
