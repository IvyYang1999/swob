import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUpDown, Check, ChevronDown, Code2, FolderTree, Globe,
  Keyboard, Layers3, Radio, RefreshCw, Server,
  Sun, Terminal, X
} from 'lucide-react'
import { useStore } from '../store'
import { useT, type Locale } from '../i18n'
import {
  HARNESS_CAPABILITIES,
  migrateSettingsPreferences,
  type ResumeMethod
} from '../../../shared/settings-capabilities'
import claudeIcon from '../assets/icons/claude.png'
import openaiIcon from '../assets/icons/openai.png'
import cursorIcon from '../assets/icons/cursor.png'
import {
  CliSection,
  LlmSettingsSection,
  RemoteConnectionSection,
  RetentionSection,
  formatAccelerator,
  keyEventToAccelerator
} from './SettingsPanel'

type SettingsTab = 'general' | 'terminal' | 'resume' | 'ssh' | 'view' | 'updates' | 'cli'

interface DetectedTerminal {
  id: string
  name: string
  path: string
  executable?: string
  commandSupport: 'stable' | 'conditional' | 'none'
  canRunCommand: boolean
  limitation?: string
  evidence: 'system-path' | 'app-path' | 'bundle-id' | 'executable'
}

const TABS: Array<{ id: SettingsTab; zh: string; en: string; ja: string }> = [
  { id: 'general', zh: '通用', en: 'General', ja: '一般' },
  { id: 'terminal', zh: '终端', en: 'Terminal', ja: 'ターミナル' },
  { id: 'resume', zh: 'Resume', en: 'Resume', ja: 'Resume' },
  { id: 'ssh', zh: 'SSH', en: 'SSH', ja: 'SSH' },
  { id: 'view', zh: '视图', en: 'View', ja: '表示' },
  { id: 'updates', zh: '更新', en: 'Updates', ja: '更新' },
  { id: 'cli', zh: 'CLI', en: 'CLI', ja: 'CLI' }
]

function copy(locale: Locale, zh: string, en: string, ja = en): string {
  return locale === 'zh-CN' ? zh : locale === 'ja' ? ja : en
}

function SettingField({ label, hint, icon, children }: {
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

function Segmented<T extends string>({ value, options, onChange, ariaLabel }: {
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
          className={`min-w-24 flex-1 px-2 py-1.5 rounded-md text-xs transition-colors ${
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

function ToggleRow({ checked, onChange, label, hint }: {
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

function HarnessMark({ id }: { id: string }) {
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

function SshTutorial({ locale }: { locale: Locale }) {
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

export function SettingsPanel() {
  const {
    settingsOpen, toggleSettings, locale, setLocale, themeMode, setThemeMode,
    config, savePreferences, sshConfig, setSshConfig
  } = useStore()
  const t = useT()
  const [activeTab, setActiveTab] = useState<SettingsTab>('general')
  const [recording, setRecording] = useState(false)
  const [pendingShortcut, setPendingShortcut] = useState<string | null>(null)
  const [terminals, setTerminals] = useState<DetectedTerminal[]>([])
  const [detectingTerminals, setDetectingTerminals] = useState(false)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [appInfo, setAppInfo] = useState<{ version: string; platform: string } | null>(null)
  const [sshHost, setSshHost] = useState(sshConfig?.host || '')
  const [sshUser, setSshUser] = useState(sshConfig?.user || '')
  const [sshRemotePath, setSshRemotePath] = useState(sshConfig?.remotePath || '')
  const shortcutButton = useRef<HTMLButtonElement>(null)

  const preferences = useMemo(
    () => migrateSettingsPreferences(config?.preferences as unknown as Record<string, unknown>),
    [config?.preferences]
  )
  const currentShortcut = String(preferences.spotlightShortcut || 'CommandOrControl+Shift+Space')
  const experimentalClaudeDesktopImport = preferences.experimentalClaudeDesktopImport === true
  const resumeMethodByHarness = preferences.resumeMethodByHarness
  const customTemplate = typeof preferences.resumeTerminalCommandTemplate === 'string'
    ? preferences.resumeTerminalCommandTemplate : ''
  const customTemplateInvalid = preferences.defaultTerminalId === 'custom' &&
    (!customTemplate.trim() || !customTemplate.includes('{{command}}'))

  const detectTerminals = useCallback(async (force = false) => {
    setDetectingTerminals(true)
    try { setTerminals(await window.api.getDetectedTerminals(force)) }
    finally { setDetectingTerminals(false) }
  }, [])

  useEffect(() => {
    if (!settingsOpen) return
    void detectTerminals()
    void window.api.getAppInfo().then(setAppInfo)
  }, [settingsOpen, detectTerminals])

  useEffect(() => {
    setSshHost(sshConfig?.host || '')
    setSshUser(sshConfig?.user || '')
    setSshRemotePath(sshConfig?.remotePath || '')
  }, [sshConfig])

  useEffect(() => {
    if (!recording) return
    const handleKeyDown = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopPropagation()
      const accelerator = keyEventToAccelerator(event)
      if (!accelerator) return
      setPendingShortcut(accelerator)
      setRecording(false)
      savePreferences({ spotlightShortcut: accelerator })
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [recording, savePreferences])

  if (!settingsOpen) return null

  const saveTerminal = (terminalId: string) => {
    const legacy = terminalId === 'iterm2' ? 'iterm' : terminalId === 'custom' ? 'custom' : 'terminal-app'
    savePreferences({ defaultTerminalId: terminalId, resumeTerminal: legacy })
  }

  const saveResumeMethod = (harnessId: string, method: ResumeMethod) => {
    savePreferences({
      resumeMethodByHarness: { ...resumeMethodByHarness, [harnessId]: method }
    })
  }

  const saveClaudeExperiment = (enabled: boolean) => {
    const resumeMethods = { ...resumeMethodByHarness }
    if (!enabled && resumeMethods['claude-code'] === 'claude-desktop') resumeMethods['claude-code'] = 'terminal'
    savePreferences({ experimentalClaudeDesktopImport: enabled, resumeMethodByHarness: resumeMethods })
  }

  const saveSsh = async () => {
    if (!sshHost.trim() || !sshUser.trim()) return
    await setSshConfig({ host: sshHost.trim(), user: sshUser.trim(), remotePath: sshRemotePath.trim() || undefined })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3" onClick={toggleSettings}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('settings.title')}
        className="bg-base border border-edge rounded-xl shadow-2xl flex flex-col overflow-hidden"
        style={{ width: 'min(760px, calc(100vw - 24px))', height: 'min(84vh, 660px)' }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 shrink-0">
          <h2 className="text-sm font-medium text-primary">{t('settings.title')}</h2>
          <button onClick={toggleSettings} className="p-1 rounded hover:bg-hover text-muted hover:text-primary" aria-label={copy(locale, '关闭设置', 'Close settings', '設定を閉じる')}>
            <X size={14} />
          </button>
        </div>

        <div className="settings-tab-strip shrink-0 overflow-x-auto border-b border-edge px-3" role="tablist" aria-label={copy(locale, '设置分类', 'Settings categories', '設定カテゴリ')}>
          <div className="flex min-w-max gap-1">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                role="tab"
                aria-selected={activeTab === tab.id}
                aria-controls={`settings-panel-${tab.id}`}
                onClick={() => setActiveTab(tab.id)}
                className={`px-3 py-2 text-xs border-b-2 transition-colors ${
                  activeTab === tab.id
                    ? 'border-accent text-primary font-medium'
                    : 'border-transparent text-muted hover:text-secondary'
                }`}
              >
                {copy(locale, tab.zh, tab.en, tab.ja)}
              </button>
            ))}
          </div>
        </div>

        <div
          id={`settings-panel-${activeTab}`}
          role="tabpanel"
          data-settings-tab={activeTab}
          className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-5"
        >
          <div className="mx-auto max-w-2xl space-y-6">
            {activeTab === 'general' && (
              <>
                <SettingField label={copy(locale, '主题', 'Theme', 'テーマ')} icon={<Sun size={12} />}>
                  <Segmented
                    ariaLabel={copy(locale, '主题', 'Theme', 'テーマ')}
                    value={themeMode}
                    onChange={setThemeMode}
                    options={[
                      { value: 'light', label: t('settings.theme_light') },
                      { value: 'dark', label: t('settings.theme_dark') },
                      { value: 'system', label: t('settings.theme_system') }
                    ]}
                  />
                </SettingField>

                <SettingField label={t('settings.language')} icon={<Globe size={12} />}>
                  <Segmented
                    ariaLabel={t('settings.language')}
                    value={locale}
                    onChange={(value) => setLocale(value)}
                    options={[
                      { value: 'zh-CN', label: '中文' },
                      { value: 'en', label: 'English' },
                      { value: 'ja', label: '日本語' }
                    ]}
                  />
                </SettingField>

                <SettingField label={t('settings.spotlight_shortcut')} hint={t('settings.spotlight_shortcut_hint')} icon={<Keyboard size={12} />}>
                  <div className="flex items-center gap-2">
                    <button
                      ref={shortcutButton}
                      onClick={() => { setRecording(true); setPendingShortcut(null) }}
                      className={`flex-1 px-3 py-1.5 rounded-md text-xs border text-left font-mono ${recording ? 'border-accent text-accent bg-accent/5' : 'border-edge bg-surface text-primary hover:border-edge-focus'}`}
                    >
                      {recording ? t('settings.spotlight_shortcut_recording') : formatAccelerator(pendingShortcut || currentShortcut)}
                    </button>
                    {(pendingShortcut || currentShortcut !== 'CommandOrControl+Shift+Space') && (
                      <button onClick={() => { setPendingShortcut(null); savePreferences({ spotlightShortcut: 'CommandOrControl+Shift+Space' }) }} className="text-[11px] text-muted hover:text-primary">
                        {t('settings.reset_shortcut')}
                      </button>
                    )}
                  </div>
                </SettingField>

                <RetentionSection />
                <LlmSettingsSection />
              </>
            )}

            {activeTab === 'terminal' && (
              <>
                <SettingField
                  label={copy(locale, '默认终端', 'Default terminal', '既定のターミナル')}
                  hint={copy(locale, '所有 CLI Resume 都会使用这里选择的终端。只允许选择具备可靠命令入口的应用。', 'All CLI resumes use this terminal. Apps without a reliable command entry point remain visible but disabled.', 'すべての CLI Resume で使用します。信頼できるコマンド入口がないアプリは選択できません。')}
                  icon={<Terminal size={12} />}
                >
                  <div className="space-y-1.5">
                    {detectingTerminals && terminals.length === 0 && <p className="text-[11px] text-muted">{copy(locale, '正在检测…', 'Detecting…', '検出中…')}</p>}
                    {terminals.map((terminal) => (
                      <button
                        key={terminal.id}
                        type="button"
                        disabled={!terminal.canRunCommand}
                        onClick={() => saveTerminal(terminal.id)}
                        className={`w-full flex items-start gap-3 rounded-md border px-3 py-2 text-left transition-colors ${
                          preferences.defaultTerminalId === terminal.id
                            ? 'border-accent bg-accent/5'
                            : 'border-edge-subtle bg-surface hover:border-edge disabled:opacity-55 disabled:hover:border-edge-subtle'
                        }`}
                      >
                        <span className={`mt-0.5 w-6 h-6 rounded flex items-center justify-center ${terminal.canRunCommand ? 'bg-soft-purple/15 text-soft-purple' : 'bg-hover text-faint'}`}>
                          <Terminal size={12} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2 text-xs text-primary">
                            {terminal.name}
                            {preferences.defaultTerminalId === terminal.id && <Check size={11} className="text-accent" />}
                          </span>
                          <code className="block mt-0.5 truncate text-[10px] font-mono text-faint" title={terminal.path}>{terminal.path}</code>
                          {terminal.limitation && <span className="block mt-1 text-[10px] leading-snug text-soft-amber">{terminal.limitation}</span>}
                        </span>
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => saveTerminal('custom')}
                      className={`w-full flex items-center gap-3 rounded-md border px-3 py-2 text-left ${preferences.defaultTerminalId === 'custom' ? 'border-accent bg-accent/5' : 'border-edge-subtle bg-surface hover:border-edge'}`}
                    >
                      <span className="w-6 h-6 rounded bg-hover text-muted flex items-center justify-center"><Code2 size={12} /></span>
                      <span className="text-xs text-primary">{copy(locale, '自定义模板', 'Custom template', 'カスタムテンプレート')}</span>
                    </button>
                  </div>
                  <button onClick={() => void detectTerminals(true)} disabled={detectingTerminals} className="mt-2 inline-flex items-center gap-1 text-[11px] text-muted hover:text-primary disabled:opacity-40">
                    <RefreshCw size={10} className={detectingTerminals ? 'animate-spin' : ''} />
                    {copy(locale, '重新检测', 'Scan again', '再検出')}
                  </button>
                </SettingField>

                {preferences.defaultTerminalId === 'custom' && (
                  <SettingField label={copy(locale, '命令模板', 'Command template', 'コマンドテンプレート')}>
                    <textarea
                      value={customTemplate}
                      onChange={(event) => savePreferences({ resumeTerminalCommandTemplate: event.target.value })}
                      placeholder="otty {{command}}"
                      rows={3}
                      className="w-full px-2 py-1.5 text-xs bg-surface border border-edge rounded-md text-primary placeholder:text-faint focus:outline-none focus:border-edge-focus font-mono resize-y"
                    />
                    <p className={`text-[11px] ${customTemplateInvalid ? 'text-soft-amber' : 'text-faint'}`}>
                      {customTemplateInvalid
                        ? copy(locale, '模板必须包含 {{command}}，否则会降级到系统终端。', 'Template must include {{command}} or Swob falls back to the system terminal.', 'テンプレートには {{command}} が必要です。')
                        : copy(locale, 'Swob 会对完整 Resume 命令转义后替换 {{command}}。', 'Swob replaces {{command}} with the safely quoted resume command.', 'Swob が Resume コマンドを安全に置換します。')}
                    </p>
                  </SettingField>
                )}
              </>
            )}

            {activeTab === 'resume' && (
              <>
                <p className="text-[11px] leading-relaxed text-muted">
                  {copy(locale, '每个 harness 只显示经过验证的入口；“打开 App”和“恢复指定会话”不会混为一谈。', 'Each harness exposes only verified entry points. Opening an app is never presented as exact-session resume.', '検証済みの入口だけを表示し、アプリ起動とセッション復元を区別します。')}
                </p>
                <div className="space-y-2">
                  {HARNESS_CAPABILITIES.map((harness) => {
                    const value = resumeMethodByHarness[harness.id] || harness.defaultMethod
                    return (
                      <div key={harness.id} className="rounded-md bg-surface px-3 py-2.5 flex items-start gap-3">
                        <HarnessMark id={harness.id} />
                        <div className="min-w-0 flex-1 sm:flex sm:items-start sm:justify-between sm:gap-4">
                          <div className="mb-2 sm:mb-0">
                            <div className="text-xs font-medium text-primary">{harness.name}</div>
                            <div className="mt-0.5 text-[10px] text-faint">
                              {copy(locale, '默认方式', 'Default method', '既定の方法')}
                            </div>
                          </div>
                          <select
                            aria-label={`${harness.name} ${copy(locale, '默认方式', 'default method', '既定の方法')}`}
                            value={value}
                            onChange={(event) => saveResumeMethod(harness.id, event.target.value as ResumeMethod)}
                            className="w-full sm:w-64 px-2 py-1.5 rounded-md text-xs bg-base border border-edge focus:border-accent outline-none text-primary"
                          >
                            {harness.choices.map((choice) => {
                              const enabled = choice.support === 'stable' || (choice.id === 'claude-desktop' && experimentalClaudeDesktopImport)
                              return (
                                <option key={`${choice.id}-${choice.label}`} value={choice.id} disabled={!enabled}>
                                  {choice.label}{choice.reason ? ` — ${choice.reason}` : ''}
                                </option>
                              )
                            })}
                          </select>
                        </div>
                      </div>
                    )
                  })}
                </div>
                <div className="rounded-md bg-soft-amber/5 px-3 py-2.5">
                  <ToggleRow
                    checked={experimentalClaudeDesktopImport}
                    onChange={saveClaudeExperiment}
                    label={t('settings.experimental_claude_desktop')}
                    hint={t('settings.experimental_claude_desktop_warning')}
                  />
                </div>
              </>
            )}

            {activeTab === 'ssh' && (
              <>
                <SettingField
                  label={copy(locale, 'SSH 主机', 'SSH host', 'SSH ホスト')}
                  hint={copy(locale, '用于恢复来自另一台机器的会话。', 'Used to resume sessions from another machine.', '別のマシンのセッションを再開するために使用します。')}
                  icon={<Server size={12} />}
                >
                  <div className="space-y-2">
                    <input value={sshHost} onChange={(event) => setSshHost(event.target.value)} placeholder={t('settings.ssh_host')} className="w-full px-2 py-1.5 text-xs bg-surface border border-edge rounded-md text-primary placeholder:text-faint focus:outline-none focus:border-edge-focus" />
                    <input value={sshUser} onChange={(event) => setSshUser(event.target.value)} placeholder={t('settings.ssh_user')} className="w-full px-2 py-1.5 text-xs bg-surface border border-edge rounded-md text-primary placeholder:text-faint focus:outline-none focus:border-edge-focus" />
                    <input value={sshRemotePath} onChange={(event) => setSshRemotePath(event.target.value)} placeholder={t('settings.ssh_remote_path')} className="w-full px-2 py-1.5 text-xs bg-surface border border-edge rounded-md text-primary placeholder:text-faint focus:outline-none focus:border-edge-focus" />
                    <div className="flex gap-2">
                      <button onClick={() => void saveSsh()} disabled={!sshHost.trim() || !sshUser.trim()} className="px-3 py-1.5 rounded-md text-xs font-medium bg-accent/15 text-accent hover:bg-accent/25 disabled:opacity-40">{t('settings.ssh_save')}</button>
                      {sshConfig && <button onClick={() => setSshConfig(null)} className="px-3 py-1.5 rounded-md text-xs text-muted hover:bg-hover hover:text-soft-red">{t('settings.ssh_clear')}</button>}
                    </div>
                  </div>
                </SettingField>
                <RemoteConnectionSection />
                <SshTutorial locale={locale} />
              </>
            )}

            {activeTab === 'view' && (
              <>
                <SettingField label={copy(locale, '默认视图模式', 'Default project view', '既定のプロジェクト表示')} icon={<FolderTree size={12} />}>
                  <Segmented
                    ariaLabel={copy(locale, '默认视图模式', 'Default project view', '既定のプロジェクト表示')}
                    value={(preferences.projectViewMode === 'paths' ? 'paths' : 'folders') as 'folders' | 'paths'}
                    onChange={(projectViewMode) => savePreferences({ projectViewMode })}
                    options={[
                      { value: 'folders', label: t('settings.project_view_folders') },
                      { value: 'paths', label: t('settings.project_view_paths') }
                    ]}
                  />
                </SettingField>
                <SettingField label={copy(locale, '默认排序', 'Default sort', '既定の並び順')} icon={<ArrowUpDown size={12} />}>
                  <Segmented
                    ariaLabel={copy(locale, '默认排序', 'Default sort', '既定の並び順')}
                    value={preferences.defaultSort}
                    onChange={(defaultSort) => savePreferences({ defaultSort })}
                    options={[
                      { value: 'updated', label: copy(locale, '最近更新', 'Recently updated', '最近の更新') },
                      { value: 'created', label: copy(locale, '创建时间', 'Created', '作成日時') },
                      { value: 'turns', label: copy(locale, '轮数', 'Turns', 'ターン数') },
                      { value: 'name', label: copy(locale, '名称', 'Name', '名前') }
                    ]}
                  />
                </SettingField>
                <SettingField label={copy(locale, '默认分组', 'Default grouping', '既定のグループ')} icon={<Layers3 size={12} />}>
                  <Segmented
                    ariaLabel={copy(locale, '默认分组', 'Default grouping', '既定のグループ')}
                    value={preferences.defaultGrouping}
                    onChange={(defaultGrouping) => savePreferences({ defaultGrouping })}
                    options={[
                      { value: 'none', label: copy(locale, '无', 'None', 'なし') },
                      { value: 'project', label: copy(locale, '按项目', 'Project', 'プロジェクト') },
                      { value: 'date', label: copy(locale, '按日期', 'Date', '日付') },
                      { value: 'harness', label: 'Harness' }
                    ]}
                  />
                </SettingField>
                <SettingField label={copy(locale, '单轮会话处理', 'Single-turn sessions', '単一ターンのセッション')} icon={<Radio size={12} />}>
                  <Segmented
                    ariaLabel={copy(locale, '单轮会话处理', 'Single-turn sessions', '単一ターンのセッション')}
                    value={preferences.singleTurnBehavior}
                    onChange={(singleTurnBehavior) => savePreferences({ singleTurnBehavior })}
                    options={[
                      { value: 'show', label: copy(locale, '显示', 'Show', '表示') },
                      { value: 'hide', label: copy(locale, '隐藏', 'Hide', '非表示') },
                      { value: 'collapse', label: copy(locale, '折叠', 'Collapse', '折りたたむ') }
                    ]}
                  />
                </SettingField>
              </>
            )}

            {activeTab === 'updates' && (
              <>
                <SettingField label={copy(locale, '自动更新', 'Automatic updates', '自動更新')} icon={<RefreshCw size={12} />}>
                  <ToggleRow
                    checked={preferences.autoCheckUpdates}
                    onChange={(autoCheckUpdates) => savePreferences({ autoCheckUpdates })}
                    label={copy(locale, '启动后自动检查更新', 'Check for updates after launch', '起動後に更新を確認')}
                    hint={copy(locale, '关闭后仍可随时手动检查。', 'You can still check manually at any time.', 'いつでも手動で確認できます。')}
                  />
                </SettingField>
                <SettingField label={copy(locale, '更新通道', 'Update channel', '更新チャンネル')}>
                  <Segmented
                    ariaLabel={copy(locale, '更新通道', 'Update channel', '更新チャンネル')}
                    value={preferences.updateChannel}
                    onChange={(updateChannel) => savePreferences({ updateChannel })}
                    options={[
                      { value: 'stable', label: copy(locale, '稳定', 'Stable', '安定版') },
                      { value: 'development', label: copy(locale, '开发', 'Development', '開発版') }
                    ]}
                  />
                </SettingField>
                <div className="rounded-md bg-surface px-3 py-2.5 flex items-center justify-between gap-3">
                  <span>
                    <span className="block text-xs text-primary">Swob {appInfo ? `v${appInfo.version}` : ''}</span>
                    <span className="block mt-0.5 text-[10px] text-faint">{appInfo?.platform || ''}</span>
                  </span>
                  <button
                    onClick={async () => {
                      setCheckingUpdate(true)
                      try { await window.api.checkForUpdates() } finally { setCheckingUpdate(false) }
                    }}
                    disabled={checkingUpdate}
                    className="px-3 py-1.5 rounded-md text-xs bg-accent/15 text-accent hover:bg-accent/25 disabled:opacity-40"
                  >
                    {checkingUpdate ? t('settings.checking_update') : t('settings.check_for_updates')}
                  </button>
                </div>
              </>
            )}

            {activeTab === 'cli' && (
              <>
                <p className="text-[11px] leading-relaxed text-muted">
                  {copy(locale, 'CLI 与 Agent Skill 是本地自动化入口；路径仅用于核对当前安装，不会上传。', 'CLI and Agent Skill are local automation surfaces. Paths are shown only for local verification.', 'CLI と Agent Skill はローカル自動化の入口です。パスはローカル確認のみに表示されます。')}
                </p>
                <CliSection />
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
