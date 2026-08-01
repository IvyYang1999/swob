import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import { useT } from '../i18n'
import {
  MessageSquare, FolderHeart, Sparkles, ScanSearch, ArchiveRestore,
  ChevronRight, FolderOpen, ShieldAlert, Check,
  BookOpen, Code2, Layers
} from 'lucide-react'
import { WindowsAlphaNotice, usePlatformCapabilities } from './WindowsAlphaNotice'
import { lensIdsForScene } from '../../../shared/lens-registry'

type Step = 'welcome' | 'scene' | 'vault' | 'scan'

const SOURCE_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  zcode: 'Zcode',
  'cc-mirror': 'CC-Mirror',
  antigravity: 'Antigravity',
  grok: 'Grok',
  pi: 'Pi',
  kimi: 'Kimi',
  hermes: 'Hermes'
}

function StepDots({ step }: { step: Step }) {
  const order: Step[] = ['welcome', 'scene', 'vault', 'scan']
  return (
    <div className="flex items-center justify-center gap-1.5 mt-8">
      {order.map((s) => (
        <span
          key={s}
          className={`h-1.5 rounded-full transition-all ${s === step ? 'w-6 bg-accent' : 'w-1.5 bg-edge-strong'}`}
        />
      ))}
    </div>
  )
}

export function Onboarding({ defaultPath, onDone }: { defaultPath: string; onDone: () => void }) {
  const t = useT()
  const platformCapabilities = usePlatformCapabilities()
  const { sessions, showToast, savePreferences } = useStore()
  const [step, setStep] = useState<Step>('welcome')
  const [vaultPath, setVaultPath] = useState(defaultPath)
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const [retentionDone, setRetentionDone] = useState(false)
  const [busy, setBusy] = useState(false)

  function handleSceneSelect(scene: 'knowledge' | 'developer' | 'both') {
    const ids = lensIdsForScene(scene)
    void savePreferences({ enabledLenses: scene === 'both' ? null : ids })
    setStep('vault')
  }

  const shortPath = vaultPath
    .replace(/^\/Users\/[^/]+/, '~')
    .replace(/^[A-Za-z]:\\Users\\[^\\]+/i, '~')

  const sourceCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const s of sessions) {
      const source = s.source || 'claude-code'
      counts.set(source, (counts.get(source) || 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [sessions])

  const hasClaudeCode = sourceCounts.some(([source]) => source === 'claude-code')

  async function handlePickDirectory() {
    const selected = await (window.api as any).librarySelectDirectory?.()
    if (selected) setVaultPath(selected)
  }

  async function handleExtendRetention() {
    const result = await window.api.onboardingExtendClaudeRetention()
    if (result.ok) {
      setRetentionDone(true)
      showToast(t('onboarding.retention_done'), 'success')
    } else {
      showToast(result.errorCode ? t(result.errorCode) : t('onboarding.retention_failed'), 'error')
    }
  }

  async function handleComplete() {
    setBusy(true)
    try {
      await window.api.onboardingComplete(vaultPath, [...excluded])
      onDone()
    } catch {
      showToast(t('onboarding.complete_failed'), 'error')
      setBusy(false)
    }
  }

  return (
    <div data-testid="onboarding" className="h-screen flex items-center justify-center bg-base text-primary overflow-y-auto">
      <div className="w-full max-w-lg px-8 py-10">

        {step === 'welcome' && (
          <div className="text-center">
            <div className="w-14 h-14 mx-auto rounded-2xl bg-soft-purple/15 flex items-center justify-center mb-5">
              <MessageSquare size={26} className="text-soft-purple" />
            </div>
            <h1 className="text-xl font-semibold mb-2">{t('onboarding.welcome_title')}</h1>
            <p className="text-sm text-secondary leading-relaxed mb-8">{t('onboarding.welcome_body')}</p>

            <div className="flex items-stretch gap-2 mb-10 text-left">
              {[
                { icon: ScanSearch, title: t('onboarding.pillar_scan'), hint: t('onboarding.pillar_scan_hint') },
                { icon: ArchiveRestore, title: t('onboarding.pillar_backup'), hint: t('onboarding.pillar_backup_hint') },
                { icon: Sparkles, title: t('onboarding.pillar_organize'), hint: t('onboarding.pillar_organize_hint') }
              ].map(({ icon: Icon, title, hint }) => (
                <div key={title} className="flex-1 p-3 rounded-lg bg-surface/60 border border-edge">
                  <Icon size={16} className="text-accent mb-2" />
                  <div className="text-xs font-medium text-primary">{title}</div>
                  <div className="text-[11px] text-muted mt-0.5 leading-relaxed">{hint}</div>
                </div>
              ))}
            </div>

            <button
              onClick={() => setStep('scene')}
              className="w-full py-2.5 rounded-lg bg-accent/90 hover:bg-accent text-white text-sm font-medium flex items-center justify-center gap-1.5"
            >
              {t('onboarding.start')} <ChevronRight size={15} />
            </button>
          </div>
        )}

        {step === 'scene' && (
          <div className="text-center">
            <div className="w-14 h-14 mx-auto rounded-2xl bg-soft-blue/15 flex items-center justify-center mb-5">
              <Layers size={26} className="text-soft-blue" />
            </div>
            <h1 className="text-xl font-semibold mb-2">{t('onboarding.scene_title')}</h1>
            <div className="space-y-2.5 mt-6 mb-6">
              {([
                {
                  scene: 'knowledge' as const,
                  icon: BookOpen,
                  title: t('onboarding.scene_knowledge'),
                  hint: t('onboarding.scene_knowledge_hint'),
                  cardClass: 'hover:border-soft-blue/50',
                  iconWrapClass: 'bg-soft-blue/15',
                  iconClass: 'text-soft-blue'
                },
                {
                  scene: 'developer' as const,
                  icon: Code2,
                  title: t('onboarding.scene_developer'),
                  hint: t('onboarding.scene_developer_hint'),
                  cardClass: 'hover:border-soft-purple/50',
                  iconWrapClass: 'bg-soft-purple/15',
                  iconClass: 'text-soft-purple'
                },
                {
                  scene: 'both' as const,
                  icon: Layers,
                  title: t('onboarding.scene_both'),
                  hint: t('onboarding.scene_both_hint'),
                  cardClass: 'hover:border-soft-green/50',
                  iconWrapClass: 'bg-soft-green/15',
                  iconClass: 'text-soft-green'
                }
              ]).map(({ scene, icon: Icon, title, hint, cardClass, iconWrapClass, iconClass }) => (
                <button
                  key={scene}
                  onClick={() => handleSceneSelect(scene)}
                  className={`w-full p-4 rounded-lg border border-edge ${cardClass} bg-surface/60 hover:bg-surface flex items-center gap-3 text-left transition-colors group`}
                >
                  <div className={`w-10 h-10 rounded-lg ${iconWrapClass} flex items-center justify-center shrink-0`}>
                    <Icon size={20} className={iconClass} />
                  </div>
                  <div>
                    <div className="text-sm font-medium text-primary">{title}</div>
                    <div className="text-xs text-muted mt-0.5">{hint}</div>
                  </div>
                  <ChevronRight size={14} className="ml-auto text-muted group-hover:text-primary" />
                </button>
              ))}
            </div>
            <button
              onClick={() => setStep('vault')}
              className="text-xs text-muted hover:text-primary"
            >
              {t('onboarding.scene_skip')}
            </button>
          </div>
        )}

        {step === 'vault' && (
          <div>
            <div className="w-14 h-14 mx-auto rounded-2xl bg-soft-amber/15 flex items-center justify-center mb-5">
              <FolderHeart size={26} className="text-soft-amber" />
            </div>
            <h1 className="text-xl font-semibold mb-2 text-center">{t('onboarding.vault_title')}</h1>
            <p className="text-sm text-secondary leading-relaxed mb-6">{t('onboarding.vault_body')}</p>

            <button
              onClick={handlePickDirectory}
              className="w-full mb-6 px-4 py-3 rounded-lg bg-surface border border-edge hover:border-edge-strong flex items-center gap-3 text-left group"
              title={vaultPath}
            >
              <FolderOpen size={18} className="text-accent shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="text-sm text-primary truncate">{shortPath}</div>
                <div className="text-[11px] text-muted mt-0.5">{t('onboarding.vault_change_hint')}</div>
              </div>
            </button>

            <button
              onClick={() => setStep('scan')}
              className="w-full py-2.5 rounded-lg bg-accent/90 hover:bg-accent text-white text-sm font-medium flex items-center justify-center gap-1.5"
            >
              {t('onboarding.vault_confirm')} <ChevronRight size={15} />
            </button>
          </div>
        )}

        {step === 'scan' && (
          <div>
            <div className="w-14 h-14 mx-auto rounded-2xl bg-soft-green/15 flex items-center justify-center mb-5">
              <ScanSearch size={26} className="text-soft-green" />
            </div>
            <h1 className="text-xl font-semibold mb-2 text-center">{t('onboarding.scan_title')}</h1>
            <p className="text-sm text-secondary leading-relaxed mb-5 text-center">
              {sourceCounts.length > 0
                ? t('onboarding.scan_body', { n: sessions.length })
                : t('onboarding.scan_empty')}
            </p>

            <div className="mb-5">
              <WindowsAlphaNotice capabilities={platformCapabilities} />
            </div>

            {sourceCounts.length > 0 && (
              <div className="mb-5 rounded-lg border border-edge divide-y divide-edge overflow-hidden">
                {sourceCounts.map(([source, count]) => {
                  const included = !excluded.has(source)
                  return (
                    <label
                      key={source}
                      className="flex items-center gap-3 px-3.5 py-2.5 bg-surface/40 hover:bg-surface cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={included}
                        onChange={() => {
                          setExcluded((prev) => {
                            const next = new Set(prev)
                            next.has(source) ? next.delete(source) : next.add(source)
                            return next
                          })
                        }}
                        className="accent-[var(--color-accent)]"
                      />
                      <span className="text-sm text-primary flex-1">{SOURCE_LABELS[source] || source}</span>
                      <span className="text-xs text-muted">{t('onboarding.scan_count', { n: count })}</span>
                    </label>
                  )
                })}
              </div>
            )}

            {hasClaudeCode && (
              <div className="mb-5 p-3.5 rounded-lg bg-soft-amber/8 border border-soft-amber/25">
                <div className="flex items-center gap-2 text-sm text-soft-amber font-medium mb-1">
                  <ShieldAlert size={15} /> {t('onboarding.retention_title')}
                </div>
                <p className="text-xs text-secondary leading-relaxed mb-2.5">{t('onboarding.retention_body')}</p>
                {retentionDone ? (
                  <div className="flex items-center gap-1.5 text-xs text-soft-green"><Check size={13} /> {t('onboarding.retention_done')}</div>
                ) : (
                  <button
                    onClick={handleExtendRetention}
                    className="px-3 py-1.5 rounded bg-soft-amber/15 hover:bg-soft-amber/25 text-soft-amber text-xs font-medium"
                  >
                    {t('onboarding.retention_cta')}
                  </button>
                )}
              </div>
            )}

            <button
              onClick={handleComplete}
              disabled={busy}
              className="w-full py-2.5 rounded-lg bg-accent/90 hover:bg-accent disabled:opacity-60 text-white text-sm font-medium flex items-center justify-center gap-1.5"
            >
              {busy ? t('onboarding.finishing') : t('onboarding.finish')}
            </button>
          </div>
        )}

        <StepDots step={step} />
      </div>
    </div>
  )
}
