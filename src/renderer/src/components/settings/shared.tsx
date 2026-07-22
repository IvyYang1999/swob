import { useMemo } from 'react'
import { ChevronDown } from 'lucide-react'
import { useStore } from '../../store'
import { useT } from '../../i18n'
import { migrateSettingsPreferences } from '../../../../shared/settings-capabilities'
import claudeIcon from '../../assets/icons/claude.png'
import openaiIcon from '../../assets/icons/openai.png'
import cursorIcon from '../../assets/icons/cursor.png'

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
  const image = id === 'claude-code' ? claudeIcon : id === 'codex' ? openaiIcon : id === 'cursor' ? cursorIcon : null
  if (image) return <img src={image} alt="" className="w-6 h-6 rounded-full shrink-0" />
  const tones: Record<string, string> = {
    opencode: 'bg-soft-emerald/15 text-soft-emerald',
    zcode: 'bg-soft-cyan/15 text-soft-cyan',
    antigravity: 'bg-soft-purple/15 text-soft-purple',
    grok: 'bg-soft-blue/15 text-soft-blue',
    hermes: 'bg-soft-amber/15 text-soft-amber',
    pi: 'bg-soft-pink/15 text-soft-pink',
    kimi: 'bg-soft-orange/15 text-soft-orange'
  }
  return (
    <span className={`w-6 h-6 rounded-full shrink-0 flex items-center justify-center text-[10px] font-medium ${tones[id] || 'bg-surface text-secondary'}`}>
      {id.slice(0, 2).toUpperCase()}
    </span>
  )
}

export function SshTutorial() {
  const t = useT()
  const items = [
    {
      title: t('renderer.shared.find_the_remote_machine_address'),
      body: t('renderer.shared.run_hostname_remotely_or_inspect_its_network_ip')
    },
    {
      title: t('renderer.shared.configure_an_ssh_key'),
      body: t('renderer.shared.run_ssh_keygen_locally_then_ssh_copy_id')
    },
    {
      title: t('renderer.shared.test_the_connection'),
      body: t('renderer.shared.first_run_ssh_user_host_in_a_terminal')
    }
  ]
  return (
    <SettingField label={t('renderer.shared.connection_guide')} icon={<ChevronDown size={12} />}>
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
