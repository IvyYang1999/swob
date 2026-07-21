import { useState, useCallback, useEffect, useRef } from 'react'
import { useStore } from '../../store'
import { useT } from '../../i18n'
import {
  X, Sun, Moon, Monitor, Globe, Keyboard, Server, FolderTree, Terminal, Check,
  AlertCircle, RefreshCw, Copy, Wifi, Globe2, Shield, HardDrive
} from 'lucide-react'

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

export function keyEventToAccelerator(e: KeyboardEvent): string | null {
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

export function formatAccelerator(accel: string): string {
  return accel
    .split('+')
    .map((p) => DISPLAY_MODIFIER_MAP[p] || p)
    .join('')
}

export function CliSection() {
  const [status, setStatus] = useState<{
    cliInstalled: boolean
    symlinkInstalled: boolean
    skillInstalled: boolean
    cliPath: string | null
    commandPath: string | null
    skillPath: string | null
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
            <StatusRow label="CLI 文件" ok={status.cliInstalled} path={status.cliPath} />
            <StatusRow label="swob 命令" ok={status.symlinkInstalled} path={status.commandPath} />
            <StatusRow label="Agent Skill" ok={status.skillInstalled} path={status.skillPath} />
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

function StatusRow({ label, ok, path: itemPath }: { label: string; ok: boolean; path?: string | null }) {
  return (
    <div className="flex items-start gap-2 text-[11px] min-w-0">
      <span className="mt-0.5">{ok
        ? <Check size={10} className="text-soft-green" />
        : <AlertCircle size={10} className="text-muted" />
      }</span>
      <span className="min-w-0">
        <span className={ok ? 'text-primary' : 'text-muted'}>{label}</span>
        {itemPath && <code className="block text-[10px] font-mono text-faint truncate" title={itemPath}>{itemPath}</code>}
      </span>
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

export function RemoteConnectionSection() {
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
          <Server size={12} />
          远程连接信息
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
              desc="已检测到 Tailscale。同一账号下的另一台设备可跨网络连接，无需公网 IP。"
            />
          )}

          {localIpsWithoutTailscale.map((ip) => (
            <IpRow
              key={ip}
              ip={ip}
              label="局域网 IP（同一 WiFi 下可用）"
              icon={<Wifi size={10} className="text-blue-400" />}
              desc="仅限两台设备处于同一局域网时使用。IP 可能随网络变化。"
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
              <span className="font-medium text-secondary">推荐：安装 Tailscale</span> 实现跨网络连接——无需公网 IP、无需端口转发，两端各安装一次即可。
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

export function LlmSettingsSection() {
  const locale = useStore((s) => s.locale)
  const [provider, setProvider] = useState('anthropic')
  const [credential, setCredential] = useState('')
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
    const ok = await window.api.setLlmSettings({ provider, credential, model, baseUrl })
    if (ok) {
      setSaved(true)
      setCredential('')
      const s = await window.api.getLlmSettings()
      setKeyHint(s.keyHint)
      setHasKey(s.hasKey)
      setTimeout(() => setSaved(false), 2000)
      // Refresh model list after saving new key
      if (credential.trim()) fetchModels()
    }
  }, [provider, credential, model, baseUrl])

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
          value={credential}
          onChange={(e) => setCredential(e.target.value)}
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

export function RetentionSection() {
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

