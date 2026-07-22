import { useState, useEffect, useCallback } from 'react'
import { useStore } from '../../store'
import { Pencil, Trash2, Plus, RefreshCw } from 'lucide-react'

type Provider = 'anthropic' | 'openai' | 'custom'

interface LlmProfile {
  id: string
  name: string
  provider: Provider
  model: string
  baseUrl?: string
  keyHint: string
}

interface SmartFeatureBinding {
  insights?: string
  smartOrganize?: string
  smartRename?: string
  globalAgent?: string
}

type FeatureKey = 'insights' | 'smartOrganize' | 'smartRename' | 'globalAgent'

interface ProfileDraft {
  id?: string
  name: string
  provider: Provider
  model: string
  baseUrl: string
  credential: string
}

const EMPTY_DRAFT: ProfileDraft = { name: '', provider: 'anthropic', model: '', baseUrl: '', credential: '' }

const CCSWITCH_IMPORT_ENABLED = false

const FEATURES: Array<{ key: FeatureKey; zh: string; en: string; hint?: string }> = [
  { key: 'insights', zh: 'Insights 报告', en: 'Insights report' },
  { key: 'smartOrganize', zh: '智能整理', en: 'Smart organize' },
  { key: 'smartRename', zh: '智能重命名', en: 'Smart rename' },
  { key: 'globalAgent', zh: '全局助手(自定义 LLM 模式)', en: 'Global agent (custom LLM mode)' }
]

/**
 * Multi-profile LLM management (t110 backend): metadata in library config,
 * keys in Keychain per profile, each smart feature bound independently.
 */
export function ProfilesSettings() {
  const locale = useStore((s) => s.locale)
  const zh = locale === 'zh-CN'
  const [profiles, setProfiles] = useState<LlmProfile[]>([])
  const [bindings, setBindings] = useState<SmartFeatureBinding>({})
  const [draft, setDraft] = useState<ProfileDraft | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Model dropdown states for draft editor
  const [draftModels, setDraftModels] = useState<string[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [modelsFailed, setModelsFailed] = useState(false)
  // ccswitch import placeholder
  const [ccswitchMessage, setCcswitchMessage] = useState(false)

  const reload = useCallback(async () => {
    try {
      const [list, binds] = await Promise.all([
        window.api.llmListProfiles(),
        window.api.llmGetBindings()
      ])
      setProfiles(list)
      setBindings(binds)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  // Fetch available models from API. Note: listModels() uses the globally configured
  // insights API key, not the draft's own provider/key — a limitation of the current IPC.
  const fetchDraftModels = useCallback(async () => {
    setLoadingModels(true)
    setModelsFailed(false)
    try {
      const list = await window.api.listModels()
      setDraftModels(list)
      if (list.length === 0) setModelsFailed(true)
    } catch {
      setModelsFailed(true)
    }
    setLoadingModels(false)
  }, [])

  const saveDraft = useCallback(async () => {
    if (!draft || !draft.name.trim()) return
    setSaving(true)
    setError(null)
    try {
      await window.api.llmSaveProfile({
        ...(draft.id ? { id: draft.id } : {}),
        name: draft.name.trim(),
        provider: draft.provider,
        ...(draft.model.trim() ? { model: draft.model.trim() } : {}),
        ...(draft.baseUrl.trim() ? { baseUrl: draft.baseUrl.trim() } : {}),
        ...(draft.credential ? { credential: draft.credential } : {})
      })
      setDraft(null)
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }, [draft, reload])

  const deleteProfile = useCallback(async (profile: LlmProfile) => {
    const boundTo = FEATURES.filter((f) => bindings[f.key] === profile.id).map((f) => zh ? f.zh : f.en)
    const warning = boundTo.length > 0
      ? (zh ? `「${profile.name}」正被 ${boundTo.join('、')} 使用,删除后这些功能将失去绑定。确认删除?`
            : `"${profile.name}" is bound to ${boundTo.join(', ')}. Delete anyway?`)
      : (zh ? `删除 Profile「${profile.name}」?其 Keychain 密钥将一并清除。`
            : `Delete profile "${profile.name}"? Its Keychain entry is removed too.`)
    if (!window.confirm(warning)) return
    try {
      await window.api.llmDeleteProfile(profile.id)
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [bindings, reload, zh])

  const bind = useCallback(async (feature: FeatureKey, profileId: string) => {
    try {
      const next = await window.api.llmSetBindings({ ...bindings, [feature]: profileId || undefined })
      setBindings(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [bindings])

  const editingExisting = draft?.id ? profiles.find((p) => p.id === draft.id) : undefined

  return (
    <section>
      <label className="flex items-center gap-2 text-xs font-medium text-secondary mb-2">
        ✨ {zh ? 'AI 与智能功能' : 'AI & Smart Features'}
      </label>
      <div className="space-y-3">
        {/* Profile list */}
        <div className="space-y-1.5">
          {profiles.map((profile) => (
            <div key={profile.id} className="flex items-center gap-2 rounded-md border border-edge bg-surface px-2.5 py-1.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium text-primary">{profile.name}</div>
                <div className="truncate text-[10px] text-muted">
                  {profile.provider}{profile.model ? ` · ${profile.model}` : ''}
                  {profile.keyHint ? ` · ${profile.keyHint}` : (zh ? ' · 未配置 key' : ' · no key')}
                </div>
              </div>
              <button
                onClick={() => setDraft({
                  id: profile.id, name: profile.name, provider: profile.provider,
                  model: profile.model || '', baseUrl: profile.baseUrl || '', credential: ''
                })}
                className="rounded p-1 text-muted hover:bg-hover hover:text-primary"
                title={zh ? '编辑' : 'Edit'}
              >
                <Pencil size={12} />
              </button>
              <button
                onClick={() => void deleteProfile(profile)}
                className="rounded p-1 text-muted hover:bg-hover hover:text-red-400"
                title={zh ? '删除' : 'Delete'}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
          {profiles.length === 0 && !draft && (
            <div className="rounded-md border border-dashed border-edge px-3 py-2 text-[11px] text-muted">
              {zh ? '还没有 Profile。智能功能(报告/整理/重命名)需要至少一个带 API key 的 Profile。' : 'No profiles yet. Smart features need at least one profile with an API key.'}
            </div>
          )}
          {!draft && (
            <button
              onClick={() => setDraft({ ...EMPTY_DRAFT })}
              className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-soft-blue hover:bg-soft-blue/10"
            >
              <Plus size={12} /> {zh ? '新增 Profile' : 'Add profile'}
            </button>
          )}
        </div>

        {/* Draft editor */}
        {draft && (
          <div className="space-y-2 rounded-md border border-soft-blue/30 bg-surface p-3">
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder={zh ? 'Profile 名称,如「智谱备用」' : 'Profile name'}
              className="w-full rounded-md border border-edge bg-panel px-2 py-1.5 text-xs text-primary outline-none placeholder:text-faint focus:border-soft-blue"
            />
            <div className="flex gap-1.5">
              {(['anthropic', 'openai', 'custom'] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => setDraft({ ...draft, provider: p })}
                  className={`rounded px-2 py-1 text-[11px] capitalize transition-colors ${
                    draft.provider === p ? 'bg-soft-blue/15 font-medium text-soft-blue' : 'bg-panel text-muted hover:text-primary'
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
            {/* Model selector — dropdown when models fetched, text fallback otherwise */}
            {loadingModels ? (
              <div className="flex items-center gap-2 text-[11px] text-muted py-1.5">
                <div className="animate-spin w-3 h-3 border border-soft-blue border-t-transparent rounded-full" />
                {zh ? '获取可用模型…' : 'Fetching models…'}
              </div>
            ) : draftModels.length > 0 && !modelsFailed ? (
              <select
                value={draft.model}
                onChange={(e) => setDraft({ ...draft, model: e.target.value === '__custom__' ? '' : e.target.value })}
                className="w-full rounded-md border border-edge bg-panel px-2 py-1.5 text-xs text-primary outline-none focus:border-soft-blue"
              >
                <option value="">{zh ? '自动选择' : 'Auto'}</option>
                {draftModels.map((m) => <option key={m} value={m}>{m}</option>)}
                <option value="__custom__">{zh ? '自定义输入…' : 'Custom…'}</option>
              </select>
            ) : (
              <div className="flex items-center gap-1.5">
                <input
                  value={draft.model}
                  onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                  placeholder={zh ? '模型 ID(如 claude-haiku-4-5)' : 'Model ID'}
                  className="flex-1 rounded-md border border-edge bg-panel px-2 py-1.5 text-xs text-primary outline-none placeholder:text-faint focus:border-soft-blue"
                />
                <button
                  onClick={() => void fetchDraftModels()}
                  disabled={loadingModels}
                  className="shrink-0 rounded-md p-1.5 text-muted hover:bg-hover hover:text-primary disabled:opacity-40"
                  title={zh ? '拉取模型列表' : 'Fetch models'}
                >
                  <RefreshCw size={12} />
                </button>
              </div>
            )}
            {draft.model === '__custom__' && (
              <input
                type="text"
                value=""
                onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                placeholder={zh ? '输入自定义模型 ID' : 'Enter custom model ID'}
                className="w-full rounded-md border border-edge bg-panel px-2 py-1.5 text-xs text-primary outline-none placeholder:text-faint focus:border-soft-blue"
                autoFocus
              />
            )}
            {modelsFailed && (
              <div className="text-[10px] text-soft-amber">{zh ? '获取模型列表失败，请手动输入' : 'Failed to fetch models, enter manually'}</div>
            )}
            {draft.provider === 'custom' && (
              <input
                value={draft.baseUrl}
                onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
                placeholder="Base URL"
                className="w-full rounded-md border border-edge bg-panel px-2 py-1.5 text-xs text-primary outline-none placeholder:text-faint focus:border-soft-blue"
              />
            )}
            <input
              type="password"
              value={draft.credential}
              onChange={(e) => setDraft({ ...draft, credential: e.target.value })}
              placeholder={editingExisting?.keyHint
                ? (zh ? `已保存 ${editingExisting.keyHint} — 留空保持不变` : `Saved ${editingExisting.keyHint} — leave empty to keep`)
                : 'API Key'}
              className="w-full rounded-md border border-edge bg-panel px-2 py-1.5 text-xs text-primary outline-none placeholder:text-faint focus:border-soft-blue"
            />
            <div className="flex items-center gap-2">
              <button
                onClick={() => void saveDraft()}
                disabled={saving || !draft.name.trim()}
                className="rounded-md bg-soft-blue/15 px-3 py-1 text-[11px] font-medium text-soft-blue hover:bg-soft-blue/25 disabled:opacity-50"
              >
                {saving ? (zh ? '保存中…' : 'Saving…') : (zh ? '保存' : 'Save')}
              </button>
              <button
                onClick={() => setDraft(null)}
                className="rounded-md px-3 py-1 text-[11px] text-muted hover:text-primary"
              >
                {zh ? '取消' : 'Cancel'}
              </button>
              <span className="text-[9px] text-faint">
                {zh ? 'key 只进 macOS Keychain,不落明文文件' : 'Keys are stored in the macOS Keychain only'}
              </span>
            </div>
          </div>
        )}

        {/* Feature bindings */}
        <div className="space-y-1.5">
          <div className="text-[10px] font-medium uppercase tracking-wide text-faint">
            {zh ? '功能绑定' : 'Feature bindings'}
          </div>
          {FEATURES.map((feature) => (
            <div key={feature.key} className="flex items-center justify-between gap-2 text-[11px]">
              <span className="text-secondary">{zh ? feature.zh : feature.en}</span>
              <select
                value={bindings[feature.key] || ''}
                onChange={(e) => void bind(feature.key, e.target.value)}
                className="max-w-[180px] rounded-md border border-edge bg-surface px-1.5 py-1 text-[11px] text-primary outline-none focus:border-soft-blue"
              >
                <option value="">{zh ? '未绑定' : 'Not bound'}</option>
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>{profile.name}</option>
                ))}
              </select>
            </div>
          ))}
          <div className="text-[9px] leading-relaxed text-faint">
            {zh
              ? '未绑定的功能会在使用时提示先来这里配置。全局助手默认复用本机已装的 CLI(如 Claude Code),仅自定义 LLM 模式才需要绑定。'
              : 'Unbound features prompt for setup when used. The global agent reuses your installed CLI by default; binding is only for custom-LLM mode.'}
          </div>
        </div>

        {error && <div className="text-[10px] text-red-400">{error}</div>}

        {/* ccswitch import — hidden behind feature flag */}
        {CCSWITCH_IMPORT_ENABLED && (
          <div className="pt-2">
            {ccswitchMessage ? (
              <div className="text-[11px] text-muted">{zh ? '即将支持' : 'Coming soon'}</div>
            ) : (
              <button
                onClick={() => setCcswitchMessage(true)}
                className="text-[11px] text-soft-blue hover:underline"
              >
                {zh ? '从 ccswitch 导入' : 'Import from ccswitch'}
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
