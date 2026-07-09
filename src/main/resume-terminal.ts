import * as fs from 'fs'
import { exec as childExec, execFile as childExecFile } from 'child_process'

export type ResumeTerminal = 'terminal-app' | 'iterm' | 'custom'

export interface ResumeTerminalSettings {
  resumeTerminal: ResumeTerminal
  resumeTerminalCommandTemplate: string
}

export interface ResumeTerminalPreferences {
  resumeTerminal?: unknown
  resumeTerminalCommandTemplate?: unknown
}

export interface OpenResumeTerminalResult {
  terminal: ResumeTerminal
  fallbackReason?: 'invalid-custom-template'
}

interface ResumeTerminalDeps {
  fs: Pick<typeof fs, 'writeFileSync' | 'chmodSync'>
  exec: (command: string) => unknown
  execFile: (
    file: string,
    args: string[],
    options: { encoding: BufferEncoding; timeout: number },
    callback: (error: Error | null, stdout: string, stderr: string) => void
  ) => unknown
  now: () => number
  random: () => number
  tmpDir: string
  logger: Pick<Console, 'warn'>
}

const defaultDeps: ResumeTerminalDeps = {
  fs,
  exec: childExec,
  execFile: childExecFile,
  now: Date.now,
  random: Math.random,
  tmpDir: '/tmp',
  logger: console
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

export function normalizeResumeTerminal(value: unknown): ResumeTerminal {
  if (value === 'iterm' || value === 'iTerm' || value === 'iTerm2') return 'iterm'
  if (value === 'custom') return 'custom'
  if (value === 'terminal-app' || value === 'Terminal.app' || value === 'Terminal') return 'terminal-app'
  return 'terminal-app'
}

export function normalizeResumeTerminalSettings(
  preferences?: ResumeTerminalPreferences | null
): ResumeTerminalSettings {
  return {
    resumeTerminal: normalizeResumeTerminal(preferences?.resumeTerminal),
    resumeTerminalCommandTemplate: typeof preferences?.resumeTerminalCommandTemplate === 'string'
      ? preferences.resumeTerminalCommandTemplate
      : ''
  }
}

export function renderCustomResumeTerminalCommand(template: string, command: string): string | null {
  const trimmed = template.trim()
  if (!trimmed || !trimmed.includes('{{command}}')) return null
  return trimmed.replace(/{{command}}/g, shellQuote(command))
}

export function openWithTerminalApp(command: string, deps: Partial<ResumeTerminalDeps> = {}): void {
  const d = { ...defaultDeps, ...deps }
  const tmpPath = `${d.tmpDir}/csm-${d.now()}-${d.random().toString(36).slice(2, 6)}.command`
  // Script deletes itself after command finishes, so Terminal won't kill a running process.
  d.fs.writeFileSync(tmpPath, `#!/bin/bash\n${command}\nrm -f "${tmpPath}"\n`)
  d.fs.chmodSync(tmpPath, 0o755)
  d.exec(`open "${tmpPath}"`)
}

export function openWithITerm(command: string, deps: Partial<ResumeTerminalDeps> = {}): void {
  const d = { ...defaultDeps, ...deps }
  d.execFile(
    'osascript',
    [
      '-e', 'on run argv',
      '-e', 'tell application "iTerm"',
      '-e', 'activate',
      '-e', 'set newWindow to (create window with default profile)',
      '-e', 'tell current session of newWindow',
      '-e', 'write text (item 1 of argv)',
      '-e', 'end tell',
      '-e', 'end tell',
      '-e', 'end run',
      command
    ],
    { encoding: 'utf8', timeout: 15000 },
    (error, _stdout, stderr) => {
      if (error) {
        d.logger.warn(`iTerm 启动失败：${stderr.trim().split('\n')[0] || error.message}`)
      }
    }
  )
}

export function openResumeTerminal(
  command: string,
  settings: ResumeTerminalSettings,
  deps: Partial<ResumeTerminalDeps> = {}
): OpenResumeTerminalResult {
  if (settings.resumeTerminal === 'iterm') {
    openWithITerm(command, deps)
    return { terminal: 'iterm' }
  }

  if (settings.resumeTerminal === 'custom') {
    const rendered = renderCustomResumeTerminalCommand(settings.resumeTerminalCommandTemplate, command)
    if (!rendered) {
      const d = { ...defaultDeps, ...deps }
      d.logger.warn('自定义 Resume 终端模板为空或缺少 {{command}}，已改用 Terminal.app')
      openWithTerminalApp(command, deps)
      return { terminal: 'terminal-app', fallbackReason: 'invalid-custom-template' }
    }
    const d = { ...defaultDeps, ...deps }
    d.exec(rendered)
    return { terminal: 'custom' }
  }

  openWithTerminalApp(command, deps)
  return { terminal: 'terminal-app' }
}
