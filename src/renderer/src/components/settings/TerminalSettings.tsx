import { useCallback, useEffect, useState } from 'react'
import { Check, Code2, RefreshCw, Terminal } from 'lucide-react'
import { useStore } from '../../store'
import { useT } from '../../i18n'
import { SettingField, useSettingsPreferences, type DetectedTerminal } from './shared'
import { usePlatformCapabilities } from '../WindowsAlphaNotice'

const WINDOWS_ALPHA_TERMINALS: DetectedTerminal[] = [
  { id: 'windows-terminal', name: 'Windows Terminal', path: 'wt.exe', executable: 'wt.exe', commandSupport: 'stable', canRunCommand: true, evidence: 'executable' },
  { id: 'powershell', name: 'PowerShell', path: 'powershell.exe / pwsh.exe', executable: 'powershell.exe', commandSupport: 'stable', canRunCommand: true, evidence: 'executable' },
  { id: 'cmd', name: 'cmd', path: 'cmd.exe', executable: 'cmd.exe', commandSupport: 'stable', canRunCommand: true, evidence: 'executable' }
]

export function TerminalSettings() {
  const { savePreferences } = useStore()
  const t = useT()
  const preferences = useSettingsPreferences()
  const isWindowsAlpha = usePlatformCapabilities()?.windowsNativeAlpha === true
  const [terminals, setTerminals] = useState<DetectedTerminal[]>([])
  const [detecting, setDetecting] = useState(false)

  const customTemplate = typeof preferences.resumeTerminalCommandTemplate === 'string'
    ? preferences.resumeTerminalCommandTemplate : ''
  const customTemplateInvalid = preferences.defaultTerminalId === 'custom' &&
    (!customTemplate.trim() || !customTemplate.includes('{{command}}'))

  const detectTerminals = useCallback(async (force = false) => {
    setDetecting(true)
    try { setTerminals(await window.api.getDetectedTerminals(force)) }
    finally { setDetecting(false) }
  }, [])

  useEffect(() => { void detectTerminals() }, [detectTerminals])

  const saveTerminal = (terminalId: string) => {
    const legacy = terminalId === 'iterm2'
      ? 'iterm'
      : terminalId === 'custom'
        ? 'custom'
        : ['windows-terminal', 'powershell', 'cmd'].includes(terminalId)
          ? terminalId
          : 'terminal-app'
    savePreferences({ defaultTerminalId: terminalId, resumeTerminal: legacy })
  }

  const visibleTerminals = isWindowsAlpha ? WINDOWS_ALPHA_TERMINALS : terminals

  return (
    <>
      <SettingField
        label={t('renderer.terminal_settings.default_terminal')}
        hint={t('renderer.terminal_settings.all_cli_resumes_use_this_terminal_apps_without')}
        icon={<Terminal size={12} />}
      >
        <div className="space-y-1.5">
          {detecting && visibleTerminals.length === 0 && <p className="text-[11px] text-muted">{t('renderer.terminal_settings.detecting')}</p>}
          {visibleTerminals.map((terminal) => (
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
          {!isWindowsAlpha && <button
            type="button"
            onClick={() => saveTerminal('custom')}
            className={`w-full flex items-center gap-3 rounded-md border px-3 py-2 text-left ${preferences.defaultTerminalId === 'custom' ? 'border-accent bg-accent/5' : 'border-edge-subtle bg-surface hover:border-edge'}`}
          >
            <span className="w-6 h-6 rounded bg-hover text-muted flex items-center justify-center"><Code2 size={12} /></span>
            <span className="text-xs text-primary">{t('renderer.terminal_settings.custom_template')}</span>
          </button>}
        </div>
        {!isWindowsAlpha && <button onClick={() => void detectTerminals(true)} disabled={detecting} className="mt-2 inline-flex items-center gap-1 text-[11px] text-muted hover:text-primary disabled:opacity-40">
          <RefreshCw size={10} className={detecting ? 'animate-spin' : ''} />
          {t('renderer.terminal_settings.scan_again')}
        </button>}
      </SettingField>

      {!isWindowsAlpha && preferences.defaultTerminalId === 'custom' && (
        <SettingField label={t('renderer.terminal_settings.command_template')}>
          <textarea
            value={customTemplate}
            onChange={(event) => savePreferences({ resumeTerminalCommandTemplate: event.target.value })}
            placeholder="otty {{command}}"
            rows={3}
            className="w-full px-2 py-1.5 text-xs bg-surface border border-edge rounded-md text-primary placeholder:text-faint focus:outline-none focus:border-edge-focus font-mono resize-y"
          />
          <p className={`text-[11px] ${customTemplateInvalid ? 'text-soft-amber' : 'text-faint'}`}>
            {customTemplateInvalid
              ? t('renderer.terminal_settings.template_must_include_command_or_swob_falls_back')
              : t('renderer.terminal_settings.swob_replaces_command_with_the_safely_quoted_resume')}
          </p>
        </SettingField>
      )}
    </>
  )
}
