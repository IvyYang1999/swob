import { useState, useCallback, useEffect, useRef } from 'react'
import { useStore } from '../store'
import { useT } from '../i18n'
import { X, Sun, Moon, Monitor, Globe, Keyboard, Server, FolderTree, Terminal, Check, AlertCircle, Smartphone, RefreshCw, Copy, Wifi, Globe2, Shield, HardDrive } from 'lucide-react'

const ELECTRON_MODIFIER_MAP: Record<string, string> = {
  Meta: 'CommandOrControl',
  Control: 'CommandOrControl',
  Alt: 'Alt',
  Shift: 'Shift'
}

const DISPLAY_MODIFIER_MAP: Record<string, string> = {
  CommandOrControl: '⌘',
  Alt: '⌥',
  Shift: '⇧'
}

function keyEventToAccelerator(e: KeyboardEvent): string | null {
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return null

  const parts: string[] = []
  if (e.metaKey || e.ctrlKey) parts.push('CommandOrControl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')

  if (parts.length === 0) return null

  let key = e.key.length === 1 ? e.key.toUpperCase() : e.key
  if (key === ' ') key = 'Space'
  parts.push(key)
  return parts.join('+')
}

function formatAccelerator(accel: string): string {
  return accel
    .split('+')
    .map((p) => DISPLAY_MODIFIER_MAP[p] || p)
    .join('')
}

function CliSection() {
  const [status, setStatus] = useState<{
    cliInstalled: boolean; symlinkInstalled: boolean; skillInstalled: boolean
  } | null>(null)
  const [installing, setInstalling] = useState(false)
  const [result, setResult] = useState<{ cliManualInstall?: string; error?: string } | null>(null)

  useEffect(() => {
    window.api.cliGetStatus().then(setStatus)
  }, [])

  const handleInstall = async () => {
    setInstalling(true)
    setResult(null)
    try {
      const r = await window.api.cliInstall()
      setResult(r)
      window.api.cliGetStatus().then(setStatus)
    } catch (e) {
      setResult({ error: String(e) })
    } finally {
      setInstalling(false)
    }
  }

  const allGood = status?.cliInstalled && status?.symlinkInstalled && status?.skillInstalled

  return (
    <section>
      <label className="flex items-center gap-2 text-xs font-medium text-secondary mb-2">
        <Terminal size={12} />
        CLI & Agent
      </label>
      <div className="space-y-2">
        <p className="text-[11px] text-muted">
          安装 Swob CLI 后，你的 AI Agent 可以通过命令行搜索、整理和恢复会话。
        </p>

        {status && (
          <div className="space-y-1">
            <StatusRow label="CLI 文件" ok={status.cliInstalled} />
            <StatusRow label="swob 命令" ok={status.symlinkInstalled} />
            <StatusRow label="Agent Skill" ok={status.skillInstalled} />
          </div>
        )}

        {!allGood && (
          <button
            onClick={handleInstall}
            disabled={installing}
            className="w-full px-2 py-1.5 rounded-md text-xs bg-accent/15 text-accent hover:bg-accent/25 disabled:opacity-40 transition-colors"
          >
            {installing ? '安装中...' : '安装 / 更新 CLI'}
          </button>
        )}

        {allGood && (
          <div className="flex items-center gap-1.5 text-[11px] text-green-400">
            <Check size={11} />
            已安装，Agent 可以使用 swob 命令
          </div>
        )}

        {result?.cliManualInstall && (
          <div className="text-[11px] text-muted">
            <p className="flex items-center gap-1 text-amber-400 mb-1">
              <AlertCircle size={10} />
              需要手动创建 symlink:
            </p>
            <code className="block px-2 py-1 bg-surface rounded text-[10px] font-mono text-primary select-all">
              {result.cliManualInstall}
            </code>
          </div>
        )}

        {result?.error && (
          <p className="text-[11px] text-red-400">{result.error}</p>
        )}
      </div>
    </section>
  )
}

function StatusRow({ label, ok }: { label: string; ok: boolean }) {
  return (
    <div className="flex items-center gap-2 text-[11px]">
      {ok
        ? <Check size={10} className="text-green-400" />
        : <AlertCircle size={10} className="text-muted" />
      }
      <span className={ok ? 'text-primary' : 'text-muted'}>{label}</span>
    </div>
  )
}

type NetworkInfo = {
  localIps: string[]
  tailscaleIp: string | null
  publicIp: string | null
  hostname: string
  sshEnabled: boolean
}

function IpRow({ ip, label, icon, desc, warn }: {
  ip: string
  label: string
  icon: React.ReactNode
  desc: string
  warn?: string
}) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard.writeText(ip)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div className="flex flex-col gap-1 p-2.5 rounded-lg bg-surface border border-edge-subtle">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-secondary">
        {icon}
        {label}
      </div>
      <div className="flex items-center gap-2">
        <code className="flex-1 text-xs font-mono text-primary bg-hover px-2 py-1 rounded select-all">{ip}</code>
        <button
          onClick={copy}
          className="p-1 rounded hover:bg-hover text-muted hover:text-primary"
          title="复制"
        >
          {copied ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
        </button>
      </div>
      <p className="text-[10px] text-muted leading-relaxed">{desc}</p>
      {warn && <p className="text-[10px] text-amber-400 leading-relaxed">⚠️ {warn}</p>}
    </div>
  )
}

function MobileConnectSection() {
  const [info, setInfo] = useState<NetworkInfo | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await window.api.networkGetInfo()
      setInfo(result)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const localIpsWithoutTailscale = info?.localIps.filter(ip => !ip.startsWith('100.')) ?? []

  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <label className="flex items-center gap-2 text-xs font-medium text-secondary">
          <Smartphone size={12} />
          手机连接信息
        </label>
        <button
          onClick={load}
          disabled={loading}
          className="p-1 rounded hover:bg-hover text-muted hover:text-primary disabled:opacity-40"
          title="刷新"
        >
          <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {!info && loading && (
        <p className="text-[11px] text-muted">检测中...</p>
      )}

      {info && (
        <div className="flex flex-col gap-2">
          {!info.sshEnabled && (
            <div className="flex items-start gap-2 p-2.5 rounded-lg bg-amber-400/10 border border-amber-400/30 text-[11px] text-amber-400">
              <AlertCircle size={12} className="mt-0.5 shrink-0" />
              <span>未开启「远程登录」(SSH)。请前往 系统设置 → 通用 → 共享 → 远程登录 开启。</span>
            </div>
          )}

          {info.tailscaleIp && (
            <IpRow
              ip={info.tailscaleIp}
              label="Tailscale（推荐，跨网络可用）"
              icon={<Shield size={10} className="text-purple-400" />}
              desc="已检测到 Tailscale。只要手机也安装 Tailscale 并登录同一账号，任何网络下都能连接，无需公网 IP。"
            />
          )}

          {localIpsWithoutTailscale.map((ip) => (
            <IpRow
              key={ip}
              ip={ip}
              label="局域网 IP（同一 WiFi 下可用）"
              icon={<Wifi size={10} className="text-blue-400" />}
              desc="仅限手机和 Mac 在同一个 WiFi 网络时使用。IP 可能随网络变化，建议配合路由器固定 IP 使用。"
              warn="跨网络、VPN 下不可用"
            />
          ))}

          {info.publicIp && (
            <IpRow
              ip={info.publicIp}
              label="公网 IP（跨网络可用，需端口转发）"
              icon={<Globe2 size={10} className="text-green-400" />}
              desc="从互联网可见的 IP。需在路由器上将 22 端口转发到这台 Mac。家用 IP 通常会定期变化。"
              warn="需要路由器端口转发，且 IP 可能随时变化"
            />
          )}

          {!info.publicIp && !loading && (
            <p className="text-[10px] text-muted">公网 IP 获取失败（可能无网络）</p>
          )}

          {!info.tailscaleIp && (
            <div className="p-2.5 rounded-lg bg-surface border border-edge-subtle text-[10px] text-muted leading-relaxed">
              <span className="font-medium text-secondary">推荐：安装 Tailscale</span> 实现最简单的跨网络连接——无需公网 IP、无需端口转发，手机和 Mac 各安装一次即可。
              免费个人计划支持 3 台设备。
            </div>
          )}

          <p className="text-[10px] text-faint">
            用户名：{info.hostname ? <code className="bg-hover px-1 rounded">{info.hostname}</code> : '未知'}。在终端运行 <code className="bg-hover px-1 rounded">whoami</code> 获取用户名。
          </p>
        </div>
      )}
    </section>
  )
}

function LlmSettingsSection() {
  const locale = useStore((s) => s.locale)
  const [provider, setProvider] = useState('anthropic')
  const [apiKey, setApiKey] = useState('')
  const [keyHint, setKeyHint] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [model, setModel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [saved, setSaved] = useState(false)
  const [models, setModels] = useState<string[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [modelsFailed, setModelsFailed] = useState(false)

  useEffect(() => {
    window.api.getLlmSettings().then((s) => {
      setProvider(s.provider)
      setKeyHint(s.keyHint)
      setHasKey(s.hasKey)
      setModel(s.model)
      setBaseUrl(s.baseUrl)
    }).catch(() => {})
  }, [])

  const fetchModels = useCallback(async () => {
    setLoadingModels(true)
    setModelsFailed(false)
    try {
      const list = await window.api.listModels()
      setModels(list)
      if (list.length === 0) setModelsFailed(true)
    } catch {
      setModelsFailed(true)
    }
    setLoadingModels(false)
  }, [])

  // Auto-fetch models when key is available
  useEffect(() => {
    if (hasKey) fetchModels()
  }, [hasKey, fetchModels])

  const handleSave = useCallback(async () => {
    const ok = await window.api.setLlmSettings({ provider, apiKey, model, baseUrl })
    if (ok) {
      setSaved(true)
      setApiKey('')
      const s = await window.api.getLlmSettings()
      setKeyHint(s.keyHint)
      setHasKey(s.hasKey)
      setTimeout(() => setSaved(false), 2000)
      // Refresh model list after saving new key
      if (apiKey.trim()) fetchModels()
    }
  }, [provider, apiKey, model, baseUrl])

  return (
    <section>
      <label className="flex items-center gap-2 text-xs font-medium text-secondary mb-2">
        ✨ {locale === 'zh-CN' ? 'AI 分析（Insights 报告）' : 'AI Analysis (Insights Report)'}
      </label>
      <div className="space-y-2">
        <div className="flex gap-1.5">
          {(['anthropic', 'openai', 'custom'] as const).map((p) => (
            <button
              key={p}
              onClick={() => setProvider(p)}
              className={`px-2 py-1 rounded text-[11px] capitalize transition-colors ${
                provider === p ? 'bg-soft-blue/15 text-soft-blue font-medium' : 'bg-surface text-muted hover:text-primary'
              }`}
            >
              {p}
            </button>
          ))}
        </div>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={hasKey ? `${locale === 'zh-CN' ? '已保存' : 'Saved'} ${keyHint} — ${locale === 'zh-CN' ? '输入新 key 可替换' : 'enter new key to replace'}` : 'API Key'}
          className="w-full px-2 py-1.5 rounded-md text-xs bg-surface border border-edge focus:border-soft-blue outline-none text-primary placeholder:text-faint"
        />
        {/* Model selector — dropdown when models available, text fallback otherwise */}
        {loadingModels ? (
          <div className="flex items-center gap-2 text-[11px] text-muted py-1.5">
            <div className="animate-spin w-3 h-3 border border-soft-blue border-t-transparent rounded-full" />
            {locale === 'zh-CN' ? '获取可用模型…' : 'Fetching models…'}
          </div>
        ) : models.length > 0 && !modelsFailed ? (
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="w-full px-2 py-1.5 rounded-md text-xs bg-surface border border-edge focus:border-soft-blue outline-none text-primary"
          >
            <option value="">{locale === 'zh-CN' ? '自动选择（推荐最便宜）' : 'Auto (cheapest recommended)'}</option>
            {models.map((m) => <option key={m} value={m}>{m}</option>)}
            <option value="__custom__">{locale === 'zh-CN' ? '自定义输入…' : 'Custom…'}</option>
          </select>
        ) : (
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={locale === 'zh-CN' ? `模型（留空用默认：${provider === 'anthropic' ? 'claude-haiku-4-5' : provider === 'openai' ? 'gpt-4o-mini' : '必填'}）` : `Model (default: ${provider === 'anthropic' ? 'claude-haiku-4-5' : provider === 'openai' ? 'gpt-4o-mini' : 'required'})`}
            className="w-full px-2 py-1.5 rounded-md text-xs bg-surface border border-edge focus:border-soft-blue outline-none text-primary placeholder:text-faint"
          />
        )}
        {model === '__custom__' && (
          <input
            type="text"
            value=""
            onChange={(e) => setModel(e.target.value)}
            placeholder={locale === 'zh-CN' ? '输入自定义模型 ID' : 'Enter custom model ID'}
            className="w-full px-2 py-1.5 rounded-md text-xs bg-surface border border-edge focus:border-soft-blue outline-none text-primary placeholder:text-faint"
            autoFocus
          />
        )}
        {modelsFailed && hasKey && (
          <div className="text-[10px] text-soft-amber">{locale === 'zh-CN' ? '获取模型列表失败，请手动输入' : 'Failed to fetch models, enter manually'}</div>
        )}
        {provider === 'custom' && (
          <input
            type="text"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="Base URL (OpenAI-compatible, e.g. https://api.example.com/v1)"
            className="w-full px-2 py-1.5 rounded-md text-xs bg-surface border border-edge focus:border-soft-blue outline-none text-primary placeholder:text-faint"
          />
        )}
        <div className="flex items-center gap-2">
          <button
            onClick={handleSave}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-soft-blue/15 text-soft-blue hover:bg-soft-blue/25 transition-colors"
          >
            {saved ? (locale === 'zh-CN' ? '已保存 ✓' : 'Saved ✓') : (locale === 'zh-CN' ? '保存' : 'Save')}
          </button>
          <span className="text-[10px] text-faint">
            {locale === 'zh-CN' ? 'key 仅存本地，生成 AI 报告时会话内容将发送至所选服务商' : 'Key stored locally. Session content is sent to your provider when generating AI reports.'}
          </span>
        </div>
      </div>
    </section>
  )
}

function RetentionSection() {
  const t = useT()
  const locale = useStore((s) => s.locale)
  const [days, setDays] = useState(30)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    window.api.getCleanupDays().then((d) => { setDays(d); setLoaded(true) }).catch(() => setLoaded(true))
  }, [])

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleChange = useCallback((value: number) => {
    setDays(value)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      setSaving(true)
      window.api.setCleanupDays(value).finally(() => setSaving(false))
    }, 500)
  }, [])

  const label = days >= 3650
    ? (locale === 'zh-CN' ? '永不删除' : 'Never delete')
    : days === 30
      ? (locale === 'zh-CN' ? '30 天（官方默认）' : '30 days (official default)')
      : (locale === 'zh-CN' ? `${days} 天` : `${days} days`)

  if (!loaded) return null

  return (
    <section>
      <label className="flex items-center gap-2 text-xs font-medium text-secondary mb-2">
        <HardDrive size={12} />
        {locale === 'zh-CN' ? '会话保留与备份' : 'Session Retention & Backup'}
      </label>
      <div className="space-y-3">
        <div>
          <div className="flex items-center justify-between text-xs mb-1.5">
            <span className="text-muted">
              {locale === 'zh-CN' ? 'Claude Code 本地会话保留期' : 'Claude Code local session retention'}
            </span>
            <span className={`font-medium ${days >= 3650 ? 'text-soft-emerald' : days <= 30 ? 'text-soft-amber' : 'text-primary'}`}>
              {label}
            </span>
          </div>
          <input
            type="range"
            min={7}
            max={3650}
            step={1}
            value={days}
            onChange={(e) => handleChange(Number(e.target.value))}
            className="w-full h-1.5 rounded-full appearance-none cursor-pointer bg-edge accent-soft-blue"
          />
          <div className="flex justify-between text-[10px] text-faint mt-1">
            <span>7d</span>
            <span>30d</span>
            <span>90d</span>
            <span>365d</span>
            <span>{locale === 'zh-CN' ? '永久' : '∞'}</span>
          </div>
          {days <= 30 && (
            <div className="mt-2 text-[10px] text-soft-amber bg-soft-amber/5 rounded px-2 py-1.5">
              ⚠️ {locale === 'zh-CN'
                ? `Claude Code 默认 30 天后自动删除本地会话。建议调高以保留完整历史。`
                : `Claude Code deletes local sessions after 30 days by default. Consider increasing to preserve history.`}
            </div>
          )}
          {saving && <div className="text-[10px] text-muted mt-1">Saving...</div>}
        </div>
      </div>
    </section>
  )
}

type SettingsCategory = 'appearance' | 'shortcuts' | 'terminal' | 'retention' | 'ai' | 'ssh' | 'mobile' | 'updates'

const SETTINGS_CATEGORIES: Array<{ id: SettingsCategory; icon: string; labelZh: string; labelEn: string }> = [
  { id: 'appearance', icon: '🎨', labelZh: '外观', labelEn: 'Appearance' },
  { id: 'shortcuts', icon: '⌨️', labelZh: '快捷键', labelEn: 'Shortcuts' },
  { id: 'terminal', icon: '🖥️', labelZh: '终端与 Resume', labelEn: 'Terminal' },
  { id: 'retention', icon: '🔒', labelZh: '会话保留', labelEn: 'Retention' },
  { id: 'ai', icon: '✨', labelZh: 'AI 分析', labelEn: 'AI Analysis' },
  { id: 'ssh', icon: '🌐', labelZh: 'SSH 远程', labelEn: 'SSH Remote' },
  { id: 'mobile', icon: '📱', labelZh: '手机连接', labelEn: 'Mobile' },
  { id: 'updates', icon: '🔄', labelZh: '更新与 CLI', labelEn: 'Updates & CLI' },
]

export function SettingsPanel() {
  const {
    settingsOpen, toggleSettings,
    locale, setLocale,
    themeMode, setThemeMode,
    config, savePreferences,
    sshConfig, setSshConfig
  } = useStore()
  const t = useT()
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>('appearance')

  const currentShortcut = config?.preferences?.spotlightShortcut || 'CommandOrControl+Shift+Space'
  const resumeTerminal = config?.preferences?.resumeTerminal || 'terminal-app'
  const resumeTerminalTemplate = config?.preferences?.resumeTerminalCommandTemplate || ''
  const resumeTerminalTemplateInvalid = resumeTerminal === 'custom' &&
    (!resumeTerminalTemplate.trim() || !resumeTerminalTemplate.includes('{{command}}'))
  const experimentalClaudeDesktopImport = config?.preferences?.experimentalClaudeDesktopImport === true
  const [recording, setRecording] = useState(false)
  const [pendingShortcut, setPendingShortcut] = useState<string | null>(null)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const shortcutRef = useRef<HTMLButtonElement>(null)

  const [sshHost, setSshHost] = useState(sshConfig?.host || '')
  const [sshUser, setSshUser] = useState(sshConfig?.user || '')
  const [sshRemotePath, setSshRemotePath] = useState(sshConfig?.remotePath || '')

  useEffect(() => {
    setSshHost(sshConfig?.host || '')
    setSshUser(sshConfig?.user || '')
    setSshRemotePath(sshConfig?.remotePath || '')
  }, [sshConfig])

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (!recording) return
    e.preventDefault()
    e.stopPropagation()
    const accel = keyEventToAccelerator(e)
    if (accel) {
      setPendingShortcut(accel)
      setRecording(false)
      savePreferences({ spotlightShortcut: accel })
    }
  }, [recording, savePreferences])

  useEffect(() => {
    if (recording) {
      window.addEventListener('keydown', handleKeyDown, true)
      return () => window.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [recording, handleKeyDown])

  const handleSshSave = useCallback(async () => {
    if (!sshHost.trim() || !sshUser.trim()) return
    await setSshConfig({ host: sshHost.trim(), user: sshUser.trim(), remotePath: sshRemotePath.trim() || undefined })
  }, [sshHost, sshUser, sshRemotePath, setSshConfig])

  const handleCheckForUpdates = useCallback(async () => {
    setCheckingUpdate(true)
    try {
      await window.api.checkForUpdates()
    } finally {
      setCheckingUpdate(false)
    }
  }, [])

  if (!settingsOpen) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={toggleSettings}
    >
      <div
        className="bg-base border border-edge rounded-xl shadow-2xl flex"
        style={{ width: 640, height: 'min(85vh, 600px)' }}
        onClick={(e) => e.stopPropagation()}
      >
      {/* Left sidebar — category nav */}
      <div className="w-40 shrink-0 border-r border-edge py-3 px-2 overflow-y-auto">
        <h2 className="text-sm font-medium text-primary px-2 mb-3">{t('settings.title')}</h2>
        {SETTINGS_CATEGORIES.map((cat) => (
          <button
            key={cat.id}
            onClick={() => setActiveCategory(cat.id)}
            className={`w-full text-left px-2.5 py-1.5 rounded-md text-xs flex items-center gap-2 mb-0.5 transition-colors ${
              activeCategory === cat.id
                ? 'bg-accent/10 text-accent font-medium'
                : 'text-secondary hover:bg-hover hover:text-primary'
            }`}
          >
            <span className="text-sm">{cat.icon}</span>
            <span>{locale === 'zh-CN' ? cat.labelZh : cat.labelEn}</span>
          </button>
        ))}
      </div>

      {/* Right content area */}
      <div className="flex-1 overflow-y-auto">
      <div className="flex items-center justify-between px-5 py-3 border-b border-edge">
        <h3 className="text-xs font-medium text-primary">
          {SETTINGS_CATEGORIES.find(c => c.id === activeCategory)?.[locale === 'zh-CN' ? 'labelZh' : 'labelEn']}
        </h3>
        <button onClick={toggleSettings} className="p-1 rounded hover:bg-hover text-muted hover:text-primary">
          <X size={14} />
        </button>
      </div>

      <div className="p-5 space-y-5">
        {/* ─── Appearance ─── */}
        {activeCategory === 'appearance' && <>
        {/* Theme */}
        <section>
          <label className="flex items-center gap-2 text-xs font-medium text-secondary mb-2">
            <Sun size={12} />
            {t('settings.theme')}
          </label>
          <div className="flex gap-1">
            {(['light', 'dark', 'system'] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setThemeMode(mode)}
                className={`flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-md text-xs transition-colors ${
                  themeMode === mode
                    ? 'bg-accent/15 text-accent'
                    : 'bg-surface text-muted hover:text-primary hover:bg-hover'
                }`}
              >
                {mode === 'light' && <Sun size={11} />}
                {mode === 'dark' && <Moon size={11} />}
                {mode === 'system' && <Monitor size={11} />}
                {t(`settings.theme_${mode}`)}
              </button>
            ))}
          </div>
        </section>

        {/* Language */}
        <section>
          <label className="flex items-center gap-2 text-xs font-medium text-secondary mb-2">
            <Globe size={12} />
            {t('settings.language')}
          </label>
          <div className="flex gap-1">
            {([['zh-CN', '中文'], ['en', 'English']] as const).map(([code, label]) => (
              <button
                key={code}
                onClick={() => setLocale(code)}
                className={`flex-1 px-2 py-1.5 rounded-md text-xs transition-colors ${
                  locale === code
                    ? 'bg-accent/15 text-accent'
                    : 'bg-surface text-muted hover:text-primary hover:bg-hover'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </section>

        </>}

        {/* ─── Shortcuts ─── */}
        {activeCategory === 'shortcuts' && <>
        {/* Spotlight shortcut */}
        <section>
          <label className="flex items-center gap-2 text-xs font-medium text-secondary mb-2">
            <Keyboard size={12} />
            {t('settings.spotlight_shortcut')}
          </label>
          <div className="flex items-center gap-2">
            <button
              ref={shortcutRef}
              onClick={() => { setRecording(true); setPendingShortcut(null) }}
              className={`flex-1 px-3 py-1.5 rounded-md text-xs border transition-colors text-left font-mono ${
                recording
                  ? 'border-accent text-accent bg-accent/5'
                  : 'border-edge bg-surface text-primary hover:border-edge-focus'
              }`}
            >
              {recording
                ? t('settings.spotlight_shortcut_recording')
                : formatAccelerator(pendingShortcut || currentShortcut)
              }
            </button>
            {(pendingShortcut || currentShortcut !== 'CommandOrControl+Shift+Space') && (
              <button
                onClick={() => {
                  setPendingShortcut(null)
                  savePreferences({ spotlightShortcut: 'CommandOrControl+Shift+Space' })
                }}
                className="text-[11px] text-muted hover:text-primary"
              >
                {t('settings.reset_shortcut')}
              </button>
            )}
          </div>
          <p className="text-[11px] text-faint mt-1">{t('settings.spotlight_shortcut_hint')}</p>
        </section>

        </>}

        {/* ─── Terminal ─── */}
        {activeCategory === 'terminal' && <>
        {/* Resume Terminal */}
        <section>
          <label className="flex items-center gap-2 text-xs font-medium text-secondary mb-2">
            <Terminal size={12} />
            {t('settings.resume_terminal')}
          </label>
          <div className="flex gap-1">
            {([
              ['terminal-app', t('settings.resume_terminal_terminal_app')],
              ['iterm', t('settings.resume_terminal_iterm')],
              ['custom', t('settings.resume_terminal_custom')]
            ] as const).map(([mode, label]) => (
              <button
                key={mode}
                onClick={() => savePreferences({ resumeTerminal: mode })}
                className={`flex-1 px-2 py-1.5 rounded-md text-xs transition-colors ${
                  resumeTerminal === mode
                    ? 'bg-accent/15 text-accent'
                    : 'bg-surface text-muted hover:text-primary hover:bg-hover'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {resumeTerminal === 'custom' && (
            <div className="mt-2 space-y-1">
              <textarea
                value={resumeTerminalTemplate}
                onChange={(e) => savePreferences({ resumeTerminalCommandTemplate: e.target.value })}
                placeholder="otty {{command}}"
                rows={2}
                className="w-full px-2 py-1.5 text-xs bg-surface border border-edge rounded-md text-primary placeholder:text-muted focus:outline-none focus:border-edge-focus font-mono resize-y"
              />
              <p className={resumeTerminalTemplateInvalid ? 'text-[11px] text-amber-400' : 'text-[11px] text-faint'}>
                {resumeTerminalTemplateInvalid
                  ? t('settings.resume_terminal_custom_invalid')
                  : t('settings.resume_terminal_custom_hint')}
              </p>
            </div>
          )}
        </section>

        {/* Experimental Claude Desktop handoff */}
        <section>
          <label className="flex items-center justify-between gap-3">
            <span className="min-w-0">
              <span className="flex items-center gap-2 text-xs font-medium text-secondary">
                <AlertCircle size={12} className="text-soft-amber" />
                {t('settings.experimental_claude_desktop')}
              </span>
              <span className="block mt-1 text-[11px] leading-relaxed text-soft-amber">
                {t('settings.experimental_claude_desktop_warning')}
              </span>
            </span>
            <input
              type="checkbox"
              aria-label={t('settings.experimental_claude_desktop')}
              checked={experimentalClaudeDesktopImport}
              onChange={(event) => savePreferences({
                experimentalClaudeDesktopImport: event.target.checked
              })}
              className="h-4 w-4 shrink-0 accent-soft-blue"
            />
          </label>
        </section>

        {/* SSH */}
        <section>
          <label className="flex items-center gap-2 text-xs font-medium text-secondary mb-2">
            <Server size={12} />
            {t('settings.ssh')}
          </label>
          <div className="space-y-2">
            <input
              value={sshHost}
              onChange={(e) => setSshHost(e.target.value)}
              placeholder={t('settings.ssh_host')}
              className="w-full px-2 py-1.5 text-xs bg-surface border border-edge rounded-md text-primary placeholder:text-muted focus:outline-none focus:border-edge-focus"
            />
            <input
              value={sshUser}
              onChange={(e) => setSshUser(e.target.value)}
              placeholder={t('settings.ssh_user')}
              className="w-full px-2 py-1.5 text-xs bg-surface border border-edge rounded-md text-primary placeholder:text-muted focus:outline-none focus:border-edge-focus"
            />
            <input
              value={sshRemotePath}
              onChange={(e) => setSshRemotePath(e.target.value)}
              placeholder={t('settings.ssh_remote_path')}
              className="w-full px-2 py-1.5 text-xs bg-surface border border-edge rounded-md text-primary placeholder:text-muted focus:outline-none focus:border-edge-focus"
            />
            <div className="flex gap-2">
              <button
                onClick={handleSshSave}
                disabled={!sshHost.trim() || !sshUser.trim()}
                className="flex-1 px-2 py-1.5 rounded-md text-xs bg-accent/15 text-accent hover:bg-accent/25 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {t('settings.ssh_save')}
              </button>
              {sshConfig && (
                <button
                  onClick={() => setSshConfig(null)}
                  className="px-2 py-1.5 rounded-md text-xs text-muted hover:text-danger hover:bg-danger/10 transition-colors"
                >
                  {t('settings.ssh_clear')}
                </button>
              )}
            </div>
          </div>
        </section>

        {/* Project View */}
        <section>
          <label className="flex items-center gap-2 text-xs font-medium text-secondary mb-2">
            <FolderTree size={12} />
            {t('settings.project_view')}
          </label>
          <div className="flex gap-1">
            {([['folders', t('settings.project_view_folders')], ['paths', t('settings.project_view_paths')]] as const).map(([mode, label]) => (
              <button
                key={mode}
                onClick={() => savePreferences({ projectViewMode: mode })}
                className={`flex-1 px-2 py-1.5 rounded-md text-xs transition-colors ${
                  (config?.preferences?.projectViewMode || 'folders') === mode
                    ? 'bg-accent/15 text-accent'
                    : 'bg-surface text-muted hover:text-primary hover:bg-hover'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </section>

        </>}

        {/* ─── Retention ─── */}
        {activeCategory === 'retention' && <>
        <RetentionSection />

        </>}

        {/* ─── AI Analysis ─── */}
        {activeCategory === 'ai' && <>
        <LlmSettingsSection />

        </>}

        {/* ─── Updates & CLI ─── */}
        {activeCategory === 'updates' && <>
        {/* App updates */}
        <section>
          <label className="flex items-center gap-2 text-xs font-medium text-secondary mb-2">
            <RefreshCw size={12} />
            {t('settings.update')}
          </label>
          <button
            onClick={handleCheckForUpdates}
            disabled={checkingUpdate}
            className="w-full px-2 py-1.5 rounded-md text-xs bg-surface text-muted hover:text-primary hover:bg-hover disabled:opacity-40 transition-colors"
          >
            {checkingUpdate ? t('settings.checking_update') : t('settings.check_for_updates')}
          </button>
        </section>

        <CliSection />
        </>}

        {/* ─── SSH ─── */}
        {activeCategory === 'ssh' && <>
        <section className="space-y-3">
          <div className="text-xs text-muted">{locale === 'zh-CN' ? 'SSH 远程连接配置' : 'SSH Remote Connection'}</div>
          <input value={sshHost} onChange={(e) => setSshHost(e.target.value)} placeholder="Host (e.g. myserver.local)" className="w-full px-2 py-1.5 rounded-md text-xs bg-surface border border-edge focus:border-soft-blue outline-none text-primary" />
          <input value={sshUser} onChange={(e) => setSshUser(e.target.value)} placeholder="Username" className="w-full px-2 py-1.5 rounded-md text-xs bg-surface border border-edge focus:border-soft-blue outline-none text-primary" />
          <input value={sshRemotePath} onChange={(e) => setSshRemotePath(e.target.value)} placeholder="Remote path (e.g. ~/.claude/projects)" className="w-full px-2 py-1.5 rounded-md text-xs bg-surface border border-edge focus:border-soft-blue outline-none text-primary" />
          <button onClick={() => setSshConfig({ host: sshHost, user: sshUser, remotePath: sshRemotePath })} className="px-3 py-1.5 rounded-md text-xs font-medium bg-soft-blue/15 text-soft-blue hover:bg-soft-blue/25 transition-colors">{locale === 'zh-CN' ? '保存' : 'Save'}</button>
        </section>
        </>}

        {/* ─── Mobile ─── */}
        {activeCategory === 'mobile' && <>
        <MobileConnectSection />
        </>}
      </div>
      </div>
      </div>
    </div>
  )
}
