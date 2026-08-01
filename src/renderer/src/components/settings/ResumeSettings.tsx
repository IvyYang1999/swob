import { useStore } from '../../store'
import { useT } from '../../i18n'
import { HARNESS_CAPABILITIES, type ResumeMethod } from '../../../../shared/settings-capabilities'
import { HarnessMark, ToggleRow, useSettingsPreferences } from './shared'
import { usePlatformCapabilities } from '../WindowsAlphaNotice'

export function ResumeSettings() {
  const { savePreferences } = useStore()
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
        {t('renderer.resume_settings.each_harness_exposes_only_verified_entry_points_opening')}
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
          const hasEnabledChoice = choices.some((choice) =>
            choice.support === 'stable' ||
            (choice.id === 'claude-desktop' && experimentalClaudeDesktopImport)
          )
          return (
            <div key={harness.id} className="rounded-md bg-surface px-3 py-2.5 flex items-start gap-3">
              <HarnessMark id={harness.id} />
              <div className="min-w-0 flex-1 sm:flex sm:items-start sm:justify-between sm:gap-4">
                <div className="mb-2 sm:mb-0">
                  <div className="text-xs font-medium text-primary">{harness.name}</div>
                  <div className="mt-0.5 text-[10px] text-faint">
                    {t('renderer.resume_settings.default_method')}
                  </div>
                </div>
                <select
                  aria-label={`${harness.name} ${t('renderer.resume_settings.default_method_2')}`}
                  value={value}
                  disabled={!hasEnabledChoice}
                  onChange={(event) => saveResumeMethod(harness.id, event.target.value as ResumeMethod)}
                  className="w-full sm:w-64 px-2 py-1.5 rounded-md text-xs bg-base border border-edge focus:border-accent outline-none text-primary disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {choices.map((choice) => {
                    const enabled = choice.support === 'stable' || (choice.id === 'claude-desktop' && experimentalClaudeDesktopImport)
                    return (
                      <option key={`${choice.id}-${choice.label || choice.labelKey}`} value={choice.id} disabled={!enabled}>
                        {choice.labelKey ? t(choice.labelKey) : choice.label}
                        {choice.reason ? ` — ${choice.reason}` : choice.reasonCode ? ` — ${t(choice.reasonCode)}` : ''}
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
