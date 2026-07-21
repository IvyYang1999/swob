import { useStore } from '../../store'
import { useT } from '../../i18n'
import { HARNESS_CAPABILITIES, type ResumeMethod } from '../../../../shared/settings-capabilities'
import { copy, HarnessMark, ToggleRow, useSettingsPreferences } from './shared'
import { usePlatformCapabilities } from '../WindowsAlphaNotice'

export function ResumeSettings() {
  const { locale, savePreferences } = useStore()
  const t = useT()
  const preferences = useSettingsPreferences()
  const platformCapabilities = usePlatformCapabilities()
  const isWindowsAlpha = platformCapabilities?.windowsNativeAlpha === true
  const experimentalClaudeDesktopImport = preferences.experimentalClaudeDesktopImport === true
  const resumeMethodByHarness = preferences.resumeMethodByHarness

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
  const harnesses = isWindowsAlpha
    ? HARNESS_CAPABILITIES.filter((harness) => harness.id === 'claude-code' || harness.id === 'codex')
    : HARNESS_CAPABILITIES

  return (
    <>
      <p className="text-[11px] leading-relaxed text-muted">
        {copy(locale, '每个 harness 只显示经过验证的入口；「打开 App」和「恢复指定会话」不会混为一谈。', 'Each harness exposes only verified entry points. Opening an app is never presented as exact-session resume.', '検証済みの入口だけを表示し、アプリ起動とセッション復元を区別します。')}
      </p>
      <div className="space-y-2">
        {harnesses.map((harness) => {
          const choices = isWindowsAlpha
            ? harness.choices.filter((choice) => choice.id === 'terminal' || (
                harness.id === 'codex' && choice.id === 'codex-desktop'
              ))
            : harness.choices
          const requested = resumeMethodByHarness[harness.id] || harness.defaultMethod
          const value = choices.some((choice) => choice.id === requested)
            ? requested
            : harness.id === 'codex' ? 'codex-desktop' : 'terminal'
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
                  {choices.map((choice) => {
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
      {!isWindowsAlpha && <div className="rounded-md bg-soft-amber/5 px-3 py-2.5">
        <ToggleRow
          checked={experimentalClaudeDesktopImport}
          onChange={saveClaudeExperiment}
          label={t('settings.experimental_claude_desktop')}
          hint={t('settings.experimental_claude_desktop_warning')}
        />
      </div>}
    </>
  )
}
