import { useState, useCallback, useEffect, useRef } from 'react'
import { useStore } from '../../store'
import { translate, useT } from '../../i18n'
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
  const t = useT()
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
          {t('renderer.sections.cli_description')}
        </p>

        {status && (
          <div className="space-y-1">
            <StatusRow label={t('renderer.sections.cli_file')} ok={status.cliInstalled} path={status.cliPath} />
            <StatusRow label={t('renderer.sections.swob_command')} ok={status.symlinkInstalled} path={status.commandPath} />
            <StatusRow label="Agent Skill" ok={status.skillInstalled} path={status.skillPath} />
          </div>
        )}

        {!allGood && (
          <button
            onClick={handleInstall}
            disabled={installing}
            className="w-full px-2 py-1.5 rounded-md text-xs bg-accent/15 text-accent hover:bg-accent/25 disabled:opacity-40 transition-colors"
          >
            {installing ? t('renderer.sections.installing') : t('renderer.sections.install_cli')}
          </button>
        )}

        {allGood && (
          <div className="flex items-center gap-1.5 text-[11px] text-green-400">
            <Check size={11} />
            {t('renderer.sections.cli_ready')}
          </div>
        )}

        {result?.cliManualInstall && (
          <div className="text-[11px] text-muted">
            <p className="flex items-center gap-1 text-amber-400 mb-1">
              <AlertCircle size={10} />
              {t('renderer.sections.symlink_required')}
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
  const t = useT()
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
          title={t('renderer.sections.copy_ip')}
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
  const t = useT()
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
          {t('renderer.sections.remote_info')}
        </label>
        <button
          onClick={load}
          disabled={loading}
          className="p-1 rounded hover:bg-hover text-muted hover:text-primary disabled:opacity-40"
          title={t('renderer.sections.refresh')}
        >
          <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {!info && loading && (
        <p className="text-[11px] text-muted">{t('renderer.sections.detecting')}</p>
      )}

      {info && (
        <div className="flex flex-col gap-2">
          {!info.sshEnabled && (
            <div className="flex items-start gap-2 p-2.5 rounded-lg bg-amber-400/10 border border-amber-400/30 text-[11px] text-amber-400">
              <AlertCircle size={12} className="mt-0.5 shrink-0" />
              <span>{t('renderer.sections.ssh_disabled')}</span>
            </div>
          )}

          {info.tailscaleIp && (
            <IpRow
              ip={info.tailscaleIp}
              label={t('renderer.sections.tailscale_label')}
              icon={<Shield size={10} className="text-purple-400" />}
              desc={t('renderer.sections.tailscale_desc')}
            />
          )}

          {localIpsWithoutTailscale.map((ip) => (
            <IpRow
              key={ip}
              ip={ip}
              label={t('renderer.sections.lan_label')}
              icon={<Wifi size={10} className="text-blue-400" />}
              desc={t('renderer.sections.lan_desc')}
              warn={t('renderer.sections.lan_warn')}
            />
          ))}

          {info.publicIp && (
            <IpRow
              ip={info.publicIp}
              label={t('renderer.sections.public_label')}
              icon={<Globe2 size={10} className="text-green-400" />}
              desc={t('renderer.sections.public_desc')}
              warn={t('renderer.sections.public_warn')}
            />
          )}

          {!info.publicIp && !loading && (
            <p className="text-[10px] text-muted">{t('renderer.sections.public_failed')}</p>
          )}

          {!info.tailscaleIp && (
            <div className="p-2.5 rounded-lg bg-surface border border-edge-subtle text-[10px] text-muted leading-relaxed">
              <span className="font-medium text-secondary">{t('renderer.sections.tailscale_recommend')}</span> {t('renderer.sections.tailscale_recommend_body')}
            </div>
          )}

          <p className="text-[10px] text-faint">
            {t('renderer.sections.username')}{info.hostname ? <code className="bg-hover px-1 rounded">{info.hostname}</code> : t('renderer.sections.unknown')}{t('renderer.sections.run_terminal')} <code className="bg-hover px-1 rounded">whoami</code> {t('renderer.sections.get_username')}
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
        ✨ {translate(locale, 'renderer.sections.ai_analysis_insights_report')}
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
          placeholder={hasKey ? `${translate(locale, 'renderer.sections.saved')} ${keyHint} — ${translate(locale, 'renderer.sections.enter_new_key_to_replace')}` : 'API Key'}
          className="w-full px-2 py-1.5 rounded-md text-xs bg-surface border border-edge focus:border-soft-blue outline-none text-primary placeholder:text-faint"
        />
        {/* Model selector — dropdown when models available, text fallback otherwise */}
        {loadingModels ? (
          <div className="flex items-center gap-2 text-[11px] text-muted py-1.5">
            <div className="animate-spin w-3 h-3 border border-soft-blue border-t-transparent rounded-full" />
            {translate(locale, 'renderer.sections.fetching_models')}
          </div>
        ) : models.length > 0 && !modelsFailed ? (
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="w-full px-2 py-1.5 rounded-md text-xs bg-surface border border-edge focus:border-soft-blue outline-none text-primary"
          >
            <option value="">{translate(locale, 'renderer.sections.auto_cheapest_recommended')}</option>
            {models.map((m) => <option key={m} value={m}>{m}</option>)}
            <option value="__custom__">{translate(locale, 'renderer.sections.custom')}</option>
          </select>
        ) : (
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={translate(locale, 'renderer.sections.model_default', { value0: provider === 'anthropic' ? 'claude-haiku-4-5' : provider === 'openai' ? 'gpt-4o-mini' : translate(locale, 'renderer.sections.required') })}
            className="w-full px-2 py-1.5 rounded-md text-xs bg-surface border border-edge focus:border-soft-blue outline-none text-primary placeholder:text-faint"
          />
        )}
        {model === '__custom__' && (
          <input
            type="text"
            value=""
            onChange={(e) => setModel(e.target.value)}
            placeholder={translate(locale, 'renderer.sections.enter_custom_model_id')}
            className="w-full px-2 py-1.5 rounded-md text-xs bg-surface border border-edge focus:border-soft-blue outline-none text-primary placeholder:text-faint"
            autoFocus
          />
        )}
        {modelsFailed && hasKey && (
          <div className="text-[10px] text-soft-amber">{translate(locale, 'renderer.sections.failed_to_fetch_models_enter_manually')}</div>
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
            {saved ? (translate(locale, 'renderer.sections.saved_2')) : (translate(locale, 'renderer.sections.save'))}
          </button>
          <span className="text-[10px] text-faint">
            {translate(locale, 'renderer.sections.key_stored_locally_session_content_is_sent_to')}
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
    ? (translate(locale, 'renderer.sections.never_delete'))
    : days === 30
      ? (translate(locale, 'renderer.sections.30_days_official_default'))
      : (translate(locale, 'renderer.sections.value_days', { value0: days }))

  if (!loaded) return null

  return (
    <section>
      <label className="flex items-center gap-2 text-xs font-medium text-secondary mb-2">
        <HardDrive size={12} />
        {translate(locale, 'renderer.sections.session_retention_backup')}
      </label>
      <div className="space-y-3">
        <div>
          <div className="flex items-center justify-between text-xs mb-1.5">
            <span className="text-muted">
              {translate(locale, 'renderer.sections.claude_code_local_session_retention')}
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
            <span>{translate(locale, 'renderer.sections.copy')}</span>
          </div>
          {days <= 30 && (
            <div className="mt-2 text-[10px] text-soft-amber bg-soft-amber/5 rounded px-2 py-1.5">
              ⚠️ {translate(locale, 'renderer.sections.claude_code_deletes_local_sessions_after_30_days')}
            </div>
          )}
          {saving && <div className="text-[10px] text-muted mt-1">Saving...</div>}
        </div>
      </div>
    </section>
  )
}
