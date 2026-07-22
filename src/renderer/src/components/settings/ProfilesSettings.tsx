import { translate } from '../../i18n'
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

const FEATURES: Array<{ key: FeatureKey; labelKey: string; hint?: string }> = [
  { key: 'insights', labelKey: 'renderer.profiles.feature_insights' },
  { key: 'smartOrganize', labelKey: 'renderer.profiles.feature_organize' },
  { key: 'smartRename', labelKey: 'renderer.profiles.feature_rename' },
  { key: 'globalAgent', labelKey: 'renderer.profiles.feature_agent' }
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
    const boundTo = FEATURES.filter((f) => bindings[f.key] === profile.id).map((f) => translate(locale, f.labelKey))
    const warning = boundTo.length > 0
      ? translate(locale, 'renderer.profiles.delete_bound_warning', {
          value0: profile.name,
          value1: boundTo.join(locale === 'zh-CN' ? '、' : ', ')
        })
      : (translate(zh ? 'zh-CN' : 'en', 'renderer.profiles_settings.delete_profile_value_its_keychain_entry_is_removed', { value0: profile.name }))
    if (!window.confirm(warning)) return
    try {
      await window.api.llmDeleteProfile(profile.id)
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [bindings, reload, locale])

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
        ✨ {translate(zh ? 'zh-CN' : 'en', 'renderer.profiles_settings.ai_smart_features')}
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
                  {profile.keyHint ? ` · ${profile.keyHint}` : (translate(zh ? 'zh-CN' : 'en', 'renderer.profiles_settings.no_key'))}
                </div>
              </div>
              <button
                onClick={() => setDraft({
                  id: profile.id, name: profile.name, provider: profile.provider,
                  model: profile.model || '', baseUrl: profile.baseUrl || '', credential: ''
                })}
                className="rounded p-1 text-muted hover:bg-hover hover:text-primary"
                title={translate(zh ? 'zh-CN' : 'en', 'renderer.profiles_settings.edit')}
              >
                <Pencil size={12} />
              </button>
              <button
                onClick={() => void deleteProfile(profile)}
                className="rounded p-1 text-muted hover:bg-hover hover:text-red-400"
                title={translate(zh ? 'zh-CN' : 'en', 'renderer.profiles_settings.delete')}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
          {profiles.length === 0 && !draft && (
            <div className="rounded-md border border-dashed border-edge px-3 py-2 text-[11px] text-muted">
              {translate(zh ? 'zh-CN' : 'en', 'renderer.profiles_settings.no_profiles_yet_smart_features_need_at_least')}
            </div>
          )}
          {!draft && (
            <button
              onClick={() => setDraft({ ...EMPTY_DRAFT })}
              className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-soft-blue hover:bg-soft-blue/10"
            >
              <Plus size={12} /> {translate(zh ? 'zh-CN' : 'en', 'renderer.profiles_settings.add_profile')}
            </button>
          )}
        </div>

        {/* Draft editor */}
        {draft && (
          <div className="space-y-2 rounded-md border border-soft-blue/30 bg-surface p-3">
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder={translate(zh ? 'zh-CN' : 'en', 'renderer.profiles_settings.profile_name')}
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
                {translate(zh ? 'zh-CN' : 'en', 'renderer.profiles_settings.fetching_models')}
              </div>
            ) : draftModels.length > 0 && !modelsFailed ? (
              <select
                value={draft.model}
                onChange={(e) => setDraft({ ...draft, model: e.target.value === '__custom__' ? '' : e.target.value })}
                className="w-full rounded-md border border-edge bg-panel px-2 py-1.5 text-xs text-primary outline-none focus:border-soft-blue"
              >
                <option value="">{translate(zh ? 'zh-CN' : 'en', 'renderer.profiles_settings.auto')}</option>
                {draftModels.map((m) => <option key={m} value={m}>{m}</option>)}
                <option value="__custom__">{translate(zh ? 'zh-CN' : 'en', 'renderer.profiles_settings.custom')}</option>
              </select>
            ) : (
              <div className="flex items-center gap-1.5">
                <input
                  value={draft.model}
                  onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                  placeholder={translate(zh ? 'zh-CN' : 'en', 'renderer.profiles_settings.model_id')}
                  className="flex-1 rounded-md border border-edge bg-panel px-2 py-1.5 text-xs text-primary outline-none placeholder:text-faint focus:border-soft-blue"
                />
                <button
                  onClick={() => void fetchDraftModels()}
                  disabled={loadingModels}
                  className="shrink-0 rounded-md p-1.5 text-muted hover:bg-hover hover:text-primary disabled:opacity-40"
                  title={translate(zh ? 'zh-CN' : 'en', 'renderer.profiles_settings.fetch_models')}
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
                placeholder={translate(zh ? 'zh-CN' : 'en', 'renderer.profiles_settings.enter_custom_model_id')}
                className="w-full rounded-md border border-edge bg-panel px-2 py-1.5 text-xs text-primary outline-none placeholder:text-faint focus:border-soft-blue"
                autoFocus
              />
            )}
            {modelsFailed && (
              <div className="text-[10px] text-soft-amber">{translate(zh ? 'zh-CN' : 'en', 'renderer.profiles_settings.failed_to_fetch_models_enter_manually')}</div>
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
                ? (translate(zh ? 'zh-CN' : 'en', 'renderer.profiles_settings.saved_value_leave_empty_to_keep', { value0: editingExisting.keyHint }))
                : 'API Key'}
              className="w-full rounded-md border border-edge bg-panel px-2 py-1.5 text-xs text-primary outline-none placeholder:text-faint focus:border-soft-blue"
            />
            <div className="flex items-center gap-2">
              <button
                onClick={() => void saveDraft()}
                disabled={saving || !draft.name.trim()}
                className="rounded-md bg-soft-blue/15 px-3 py-1 text-[11px] font-medium text-soft-blue hover:bg-soft-blue/25 disabled:opacity-50"
              >
                {saving ? (translate(zh ? 'zh-CN' : 'en', 'renderer.profiles_settings.saving')) : (translate(zh ? 'zh-CN' : 'en', 'renderer.profiles_settings.save'))}
              </button>
              <button
                onClick={() => setDraft(null)}
                className="rounded-md px-3 py-1 text-[11px] text-muted hover:text-primary"
              >
                {translate(zh ? 'zh-CN' : 'en', 'renderer.profiles_settings.cancel')}
              </button>
<<<<<<< HEAD
              <span className="text-[10px] text-faint">
                {zh ? 'key 只进 macOS Keychain,不落明文文件' : 'Keys are stored in the macOS Keychain only'}
=======
              <span className="text-[9px] text-faint">
                {translate(zh ? 'zh-CN' : 'en', 'renderer.profiles_settings.keys_are_stored_in_the_macos_keychain_only')}
>>>>>>> fix/tf19-i18n-production-completion
              </span>
            </div>
          </div>
        )}

        {/* Feature bindings */}
        <div className="space-y-1.5">
          <div className="text-[10px] font-medium uppercase tracking-wide text-faint">
            {translate(zh ? 'zh-CN' : 'en', 'renderer.profiles_settings.feature_bindings')}
          </div>
          {FEATURES.map((feature) => (
            <div key={feature.key} className="flex items-center justify-between gap-2 text-[11px]">
              <span className="text-secondary">{translate(locale, feature.labelKey)}</span>
              <select
                value={bindings[feature.key] || ''}
                onChange={(e) => void bind(feature.key, e.target.value)}
                className="max-w-[180px] rounded-md border border-edge bg-surface px-1.5 py-1 text-[11px] text-primary outline-none focus:border-soft-blue"
              >
                <option value="">{translate(zh ? 'zh-CN' : 'en', 'renderer.profiles_settings.not_bound')}</option>
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>{profile.name}</option>
                ))}
              </select>
            </div>
          ))}
<<<<<<< HEAD
          <div className="text-[10px] leading-relaxed text-faint">
            {zh
              ? '未绑定的功能会在使用时提示先来这里配置。全局助手默认复用本机已装的 CLI(如 Claude Code),仅自定义 LLM 模式才需要绑定。'
              : 'Unbound features prompt for setup when used. The global agent reuses your installed CLI by default; binding is only for custom-LLM mode.'}
=======
          <div className="text-[9px] leading-relaxed text-faint">
            {translate(zh ? 'zh-CN' : 'en', 'renderer.profiles_settings.unbound_features_prompt_for_setup_when_used_the')}
>>>>>>> fix/tf19-i18n-production-completion
          </div>
        </div>

        {error && <div className="text-[10px] text-red-400">{error}</div>}

        {/* ccswitch import — hidden behind feature flag */}
        {CCSWITCH_IMPORT_ENABLED && (
          <div className="pt-2">
            {ccswitchMessage ? (
              <div className="text-[11px] text-muted">{translate(zh ? 'zh-CN' : 'en', 'renderer.profiles_settings.coming_soon')}</div>
            ) : (
              <button
                onClick={() => setCcswitchMessage(true)}
                className="text-[11px] text-soft-blue hover:underline"
              >
                {translate(zh ? 'zh-CN' : 'en', 'renderer.profiles_settings.import_from_ccswitch')}
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
