import { useEffect, useRef, useState } from 'react'
import {
  Monitor, Terminal, Play, Server, PanelsTopLeft, RefreshCw, SquareTerminal, X
} from 'lucide-react'
import { useStore } from '../../store'
import { useT, type Locale } from '../../i18n'
import { copy } from './shared'
import { GeneralSettings } from './GeneralSettings'
import { TerminalSettings } from './TerminalSettings'
import { ResumeSettings } from './ResumeSettings'
import { SshSettings } from './SshSettings'
import { ViewSettings } from './ViewSettings'
import { UpdateSettings } from './UpdateSettings'
import { CliSettings } from './CliSettings'

export type SettingsCategory = 'general' | 'terminal' | 'resume' | 'ssh' | 'view' | 'updates' | 'cli'

const CATEGORIES: Array<{
  id: SettingsCategory
  icon: typeof Monitor
  zh: string
  en: string
  ja: string
}> = [
  { id: 'general', icon: Monitor, zh: '通用', en: 'General', ja: '一般' },
  { id: 'terminal', icon: Terminal, zh: '终端', en: 'Terminal', ja: 'ターミナル' },
  { id: 'resume', icon: Play, zh: 'Resume', en: 'Resume', ja: 'Resume' },
  { id: 'ssh', icon: Server, zh: 'SSH', en: 'SSH', ja: 'SSH' },
  { id: 'view', icon: PanelsTopLeft, zh: '视图', en: 'View', ja: '表示' },
  { id: 'updates', icon: RefreshCw, zh: '更新', en: 'Updates', ja: '更新' },
  { id: 'cli', icon: SquareTerminal, zh: 'CLI', en: 'CLI', ja: 'CLI' }
]

function SettingsNav({ active, locale, onSelect }: {
  active: SettingsCategory
  locale: Locale
  onSelect: (category: SettingsCategory) => void
}) {
  return (
    <nav
      aria-label={copy(locale, '设置分类', 'Settings categories', '設定カテゴリ')}
      className="settings-nav shrink-0 border-r border-edge overflow-y-auto py-2 px-1.5"
    >
      {CATEGORIES.map(({ id, icon: Icon, zh, en, ja }) => {
        const isActive = active === id
        return (
          <button
            key={id}
            aria-current={isActive ? 'page' : undefined}
            onClick={() => onSelect(id)}
            className={`w-full flex items-center gap-2 rounded-md px-2.5 py-1.5 mb-0.5 text-xs text-left transition-colors ${
              isActive
                ? 'bg-accent/12 text-primary font-medium'
                : 'text-secondary hover:bg-hover hover:text-primary'
            }`}
          >
            <Icon size={13} className={isActive ? 'text-accent' : 'text-muted'} />
            <span className="truncate">{copy(locale, zh, en, ja)}</span>
          </button>
        )
      })}
    </nav>
  )
}

export function SettingsPanel() {
  const { settingsOpen, toggleSettings, locale } = useStore()
  const t = useT()
  const [category, setCategory] = useState<SettingsCategory>('general')
  const dialogRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!settingsOpen) return
    dialogRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') toggleSettings()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [settingsOpen, toggleSettings])

  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0
  }, [category])

  if (!settingsOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3" onClick={toggleSettings}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t('settings.title')}
        className="bg-base border border-edge rounded-xl shadow-2xl flex flex-col overflow-hidden outline-none"
        style={{ width: 'min(780px, calc(100vw - 24px))', height: 'min(84vh, 660px)' }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between pl-4 pr-3 py-2.5 border-b border-edge shrink-0">
          <h2 className="text-sm font-medium text-primary">{t('settings.title')}</h2>
          <button
            onClick={toggleSettings}
            className="p-1 rounded hover:bg-hover text-muted hover:text-primary"
            aria-label={copy(locale, '关闭设置', 'Close settings', '設定を閉じる')}
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex-1 min-h-0 flex">
          <SettingsNav active={category} locale={locale} onSelect={setCategory} />
          <div
            ref={contentRef}
            data-settings-category={category}
            className="flex-1 min-w-0 overflow-y-auto overscroll-contain p-5"
          >
            <div className="max-w-2xl space-y-6">
              {category === 'general' && <GeneralSettings />}
              {category === 'terminal' && <TerminalSettings />}
              {category === 'resume' && <ResumeSettings />}
              {category === 'ssh' && <SshSettings />}
              {category === 'view' && <ViewSettings />}
              {category === 'updates' && <UpdateSettings />}
              {category === 'cli' && <CliSettings />}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
