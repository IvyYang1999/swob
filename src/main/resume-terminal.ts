import * as fs from 'fs'
import {
  exec as childExec,
  execFile as childExecFile,
  execFileSync,
  spawn as childSpawn
} from 'child_process'
import { migrateSettingsPreferences } from '../shared/settings-capabilities'
import type { LaunchSpec } from './session-actions'

export type ResumeTerminal = 'terminal-app' | 'iterm' | 'custom' | 'windows-terminal' | 'powershell' | 'cmd'

export interface ResumeTerminalSettings {
  resumeTerminal: ResumeTerminal
  resumeTerminalCommandTemplate: string
  defaultTerminalId: string
  terminalExecutable?: string
}

export interface ResumeTerminalPreferences {
  resumeTerminal?: unknown
  resumeTerminalCommandTemplate?: unknown
  defaultTerminalId?: unknown
}

export interface OpenResumeTerminalResult {
  terminal: string
  fallbackReason?: 'invalid-custom-template' | 'terminal-unavailable'
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

interface WindowsTerminalDeps {
  commandExists: (executable: string) => boolean
  spawn: typeof childSpawn
}

export interface WindowsTerminalInvocation {
  terminal: 'windows-terminal' | 'powershell' | 'cmd'
  executable: string
  args: string[]
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

export function powershellQuote(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new Error('PowerShell 参数包含非法控制字符')
  return `'${value.replace(/'/g, "''")}'`
}

export function renderPowerShellLaunchCommand(spec: LaunchSpec): string {
  return `& ${[spec.executable, ...spec.args].map(powershellQuote).join(' ')}`
}

function renderCmdLaunchCommand(spec: LaunchSpec): string {
  const values = [spec.executable, ...spec.args]
  if (values.some((value) => /[\0\r\n%!^&|<>"]/.test(value))) {
    throw new Error('cmd 降级无法安全表示 Resume 参数')
  }
  return values.map((value) => `"${value}"`).join(' ')
}

function defaultCommandExists(executable: string): boolean {
  try {
    execFileSync('where.exe', [executable], { stdio: 'ignore', timeout: 3000 })
    return true
  } catch {
    return false
  }
}

export function buildWindowsTerminalInvocation(
  spec: LaunchSpec,
  commandExists: (executable: string) => boolean = defaultCommandExists,
  preferred: ResumeTerminal = 'windows-terminal'
): WindowsTerminalInvocation {
  const powershellCommand = renderPowerShellLaunchCommand(spec)

  if (preferred !== 'powershell' && preferred !== 'cmd' && commandExists('wt.exe')) {
    const args = ['-w', 'new', 'new-tab']
    if (spec.cwd) args.push('-d', spec.cwd)
    args.push('powershell.exe', '-NoExit', '-Command', powershellCommand)
    return { terminal: 'windows-terminal', executable: 'wt.exe', args }
  }

  if (preferred !== 'cmd' && commandExists('pwsh.exe')) {
    return {
      terminal: 'powershell',
      executable: 'pwsh.exe',
      args: ['-NoLogo', '-NoExit', '-Command', powershellCommand]
    }
  }

  if (preferred !== 'cmd' && commandExists('powershell.exe')) {
    return {
      terminal: 'powershell',
      executable: 'powershell.exe',
      args: ['-NoLogo', '-NoExit', '-Command', powershellCommand]
    }
  }

  return {
    terminal: 'cmd',
    executable: 'cmd.exe',
    args: ['/D', '/K', renderCmdLaunchCommand(spec)]
  }
}

export async function openResumeLaunchSpec(
  spec: LaunchSpec,
  settings: ResumeTerminalSettings,
  deps: Partial<WindowsTerminalDeps> = {}
): Promise<OpenResumeTerminalResult> {
  const commandExists = deps.commandExists || defaultCommandExists
  const spawn = deps.spawn || childSpawn
  const preferred = normalizeResumeTerminal(settings.defaultTerminalId, 'win32')
  const invocation = buildWindowsTerminalInvocation(spec, commandExists, preferred)
  const child = spawn(invocation.executable, invocation.args, {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    detached: true,
    windowsHide: false,
    stdio: 'ignore'
  })

  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  child.unref()
  return { terminal: invocation.terminal }
}

export function normalizeResumeTerminal(
  value: unknown,
  platform: NodeJS.Platform = process.platform
): ResumeTerminal {
  if (platform === 'win32') {
    if (value === 'powershell' || value === 'cmd' || value === 'windows-terminal') return value
    return 'windows-terminal'
  }
  if (value === 'iterm' || value === 'iTerm' || value === 'iTerm2') return 'iterm'
  if (value === 'custom') return 'custom'
  if (value === 'terminal-app' || value === 'Terminal.app' || value === 'Terminal') return 'terminal-app'
  return 'terminal-app'
}

export function normalizeResumeTerminalSettings(
  preferences?: ResumeTerminalPreferences | null,
  platform: NodeJS.Platform = process.platform
): ResumeTerminalSettings {
  const migrated = migrateSettingsPreferences(preferences as Record<string, unknown> | undefined)
  const legacyTerminal = migrated.defaultTerminalId === 'iterm2'
    ? 'iterm'
    : migrated.defaultTerminalId === 'custom' ? 'custom' : 'terminal-app'
  if (platform === 'win32') {
    const requested = ['windows-terminal', 'powershell', 'cmd'].includes(migrated.defaultTerminalId)
      ? migrated.defaultTerminalId
      : ['windows-terminal', 'powershell', 'cmd'].includes(String(preferences?.resumeTerminal))
        ? String(preferences?.resumeTerminal)
        : 'windows-terminal'
    const resumeTerminal = normalizeResumeTerminal(requested, platform)
    return {
      resumeTerminal,
      resumeTerminalCommandTemplate: typeof preferences?.resumeTerminalCommandTemplate === 'string'
        ? preferences.resumeTerminalCommandTemplate
        : '',
      defaultTerminalId: resumeTerminal
    }
  }
  return {
    resumeTerminal: preferences?.resumeTerminal === undefined
      ? legacyTerminal
      : normalizeResumeTerminal(preferences.resumeTerminal, platform),
    resumeTerminalCommandTemplate: typeof preferences?.resumeTerminalCommandTemplate === 'string'
      ? preferences.resumeTerminalCommandTemplate
      : '',
    defaultTerminalId: migrated.defaultTerminalId
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

function terminalArgs(terminalId: string, command: string): string[] | null {
  const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/sh'
  const shellArgs = process.platform === 'win32' ? ['-NoExit', '-Command', command] : ['-lc', command]
  switch (terminalId) {
    case 'wezterm': return ['start', '--', shell, ...shellArgs]
    case 'kitty': return [shell, ...shellArgs]
    case 'alacritty': return ['-e', shell, ...shellArgs]
    case 'ghostty': return ['+new-window', '-e', shell, ...shellArgs]
    case 'windows-terminal': return ['-w', 'new', 'new-tab', shell, ...shellArgs]
    case 'gnome-terminal': return ['--window', '--', shell, ...shellArgs]
    case 'konsole': return ['--separate', '-e', shell, ...shellArgs]
    case 'foot': return [shell, ...shellArgs]
    case 'xfce4-terminal': return ['--window', '-x', shell, ...shellArgs]
    default: return null
  }
}

function openWithDetectedTerminal(
  command: string,
  terminalId: string,
  executable: string,
  deps: Partial<ResumeTerminalDeps> = {}
): boolean {
  const args = terminalArgs(terminalId, command)
  if (!args) return false
  const d = { ...defaultDeps, ...deps }
  d.execFile(executable, args, { encoding: 'utf8', timeout: 15000 }, (error, _stdout, stderr) => {
    if (error) d.logger.warn(`${terminalId} 启动失败：${stderr.trim().split('\n')[0] || error.message}`)
  })
  return true
}

export function openResumeTerminal(
  command: string,
  settings: ResumeTerminalSettings,
  deps: Partial<ResumeTerminalDeps> = {}
): OpenResumeTerminalResult {
  const terminalId = settings.defaultTerminalId || (settings.resumeTerminal === 'iterm' ? 'iterm2' : settings.resumeTerminal)
  if (terminalId === 'iterm2' || settings.resumeTerminal === 'iterm') {
    openWithITerm(command, deps)
    return { terminal: 'iterm' }
  }

  if (terminalId === 'custom' || settings.resumeTerminal === 'custom') {
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

  if (terminalId !== 'apple-terminal') {
    if (settings.terminalExecutable && openWithDetectedTerminal(
      command, terminalId, settings.terminalExecutable, deps
    )) {
      return { terminal: terminalId }
    }
    const d = { ...defaultDeps, ...deps }
    d.logger.warn(`${terminalId} 当前没有可执行入口，已改用 Terminal.app`)
    openWithTerminalApp(command, deps)
    return { terminal: 'terminal-app', fallbackReason: 'terminal-unavailable' }
  }

  openWithTerminalApp(command, deps)
  return { terminal: 'terminal-app' }
}
