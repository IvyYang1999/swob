import * as fs from 'fs'
import { describe, expect, it } from 'vitest'
import {
  normalizeResumeTerminalSettings,
  openResumeTerminal,
  buildWindowsTerminalInvocation,
  powershellQuote,
  renderPowerShellLaunchCommand,
  renderCustomResumeTerminalCommand,
  shellQuote
} from './resume-terminal'

function fakeDeps() {
  const writes: Array<{ filePath: string; content: string }> = []
  const chmods: Array<{ filePath: string; mode: number }> = []
  const execs: string[] = []
  const execFiles: Array<{ file: string; args: string[] }> = []
  const warnings: string[] = []

  return {
    writes,
    chmods,
    execs,
    execFiles,
    warnings,
    deps: {
      fs: {
        writeFileSync: (...args: Parameters<typeof fs.writeFileSync>): ReturnType<typeof fs.writeFileSync> => {
          const [filePath, content] = args
          writes.push({ filePath: String(filePath), content: String(content) })
        },
        chmodSync: (...args: Parameters<typeof fs.chmodSync>): ReturnType<typeof fs.chmodSync> => {
          const [filePath, mode] = args
          chmods.push({ filePath: String(filePath), mode: Number(mode) })
        }
      },
      exec: (command: string) => {
        execs.push(command)
      },
      execFile: (
        file: string,
        args: string[],
        _options: { encoding: BufferEncoding; timeout: number },
        callback: (error: Error | null, stdout: string, stderr: string) => void
      ) => {
        execFiles.push({ file, args })
        callback(null, '', '')
      },
      now: () => 123456789,
      random: () => 0.123456,
      tmpDir: '/tmp',
      logger: { warn: (message: string) => warnings.push(message) }
    }
  }
}

describe('Resume 终端打开方式', () => {
  it('PowerShell 引号规则使用单引号翻倍，不复用 POSIX shellQuote', () => {
    expect(powershellQuote("C:\\Users\\O'Brien\\中文项目"))
      .toBe("'C:\\Users\\O''Brien\\中文项目'")
    expect(renderPowerShellLaunchCommand({
      executable: 'claude',
      args: ['--resume', "abc'def"],
      target: 'native',
      keepOpen: true
    })).toBe("& 'claude' '--resume' 'abc''def'")
  })

  it('Windows Terminal 可用时优先新建 tab，并将 cwd 作为独立 argv', () => {
    const invocation = buildWindowsTerminalInvocation({
      executable: 'claude',
      args: ['--resume', 'abc'],
      cwd: 'C:\\Users\\Alice\\My Project',
      target: 'native',
      keepOpen: true
    }, () => true)

    expect(invocation.terminal).toBe('windows-terminal')
    expect(invocation.executable).toBe('wt.exe')
    expect(invocation.args.slice(0, 7)).toEqual([
      '-w', 'new', 'new-tab', '-d', 'C:\\Users\\Alice\\My Project', 'powershell.exe', '-NoExit'
    ])
    expect(invocation.args.at(-1)).toBe("& 'claude' '--resume' 'abc'")
  })

  it('Windows Terminal 缺失时按 PowerShell 再 cmd 降级', () => {
    const spec = { executable: 'codex', args: ['resume', 'thread-1'], target: 'native' as const, keepOpen: true }
    const powershell = buildWindowsTerminalInvocation(spec, (name) => name === 'pwsh.exe')
    expect(powershell).toMatchObject({ terminal: 'powershell', executable: 'pwsh.exe' })

    const cmd = buildWindowsTerminalInvocation(spec, () => false)
    expect(cmd).toMatchObject({ terminal: 'cmd', executable: 'cmd.exe', args: ['/D', '/K', expect.any(String)] })
  })

  it('Windows 优先使用新设置层的 defaultTerminalId', () => {
    expect(normalizeResumeTerminalSettings({ defaultTerminalId: 'powershell' }, 'win32'))
      .toMatchObject({ resumeTerminal: 'powershell', defaultTerminalId: 'powershell' })
    expect(normalizeResumeTerminalSettings(undefined, 'win32'))
      .toMatchObject({ resumeTerminal: 'windows-terminal', defaultTerminalId: 'windows-terminal' })
  })

  it('默认没有设置时仍然写 .command 文件并用 Terminal.app 打开', () => {
    const f = fakeDeps()
    const settings = normalizeResumeTerminalSettings(undefined)

    const result = openResumeTerminal('claude --resume abc', settings, f.deps)

    expect(result).toEqual({ terminal: 'terminal-app' })
    expect(f.writes).toHaveLength(1)
    expect(f.writes[0].filePath).toMatch(/^\/tmp\/csm-123456789-[a-z0-9]{4}\.command$/)
    expect(f.writes[0].content).toBe(`#!/bin/bash\nclaude --resume abc\nrm -f "${f.writes[0].filePath}"\n`)
    expect(f.chmods).toEqual([{ filePath: f.writes[0].filePath, mode: 0o755 }])
    expect(f.execs).toEqual([`open "${f.writes[0].filePath}"`])
  })

  it('选择检测到的 WezTerm 时用 argv 启动，不拼接 shell executable', () => {
    const f = fakeDeps()
    const settings = normalizeResumeTerminalSettings({ defaultTerminalId: 'wezterm' })
    settings.terminalExecutable = '/opt/homebrew/bin/wezterm'

    const result = openResumeTerminal('claude --resume abc', settings, f.deps)

    expect(result).toEqual({ terminal: 'wezterm' })
    expect(f.execFiles[0]).toEqual({
      file: '/opt/homebrew/bin/wezterm',
      args: ['start', '--', '/bin/sh', '-lc', 'claude --resume abc']
    })
  })

  it('新终端配置缺少 executable 时明确降级 Terminal.app', () => {
    const f = fakeDeps()
    const settings = normalizeResumeTerminalSettings({ defaultTerminalId: 'wezterm' })

    const result = openResumeTerminal('claude --resume abc', settings, f.deps)

    expect(result).toEqual({ terminal: 'terminal-app', fallbackReason: 'terminal-unavailable' })
    expect(f.warnings[0]).toContain('已改用 Terminal.app')
  })

  it('选择 iTerm 时用 osascript 新建窗口并写入原始 resume 命令', () => {
    const f = fakeDeps()

    const result = openResumeTerminal(
      'cd /tmp && claude --resume abc',
      normalizeResumeTerminalSettings({ resumeTerminal: 'iterm' }),
      f.deps
    )

    expect(result).toEqual({ terminal: 'iterm' })
    expect(f.execFiles).toHaveLength(1)
    expect(f.execFiles[0].file).toBe('osascript')
    expect(f.execFiles[0].args).toContain('tell application "iTerm"')
    expect(f.execFiles[0].args.some((arg) => arg.includes('create window with default profile'))).toBe(true)
    expect(f.execFiles[0].args.at(-1)).toBe('cd /tmp && claude --resume abc')
  })

  it('自定义模板会把完整 resume 命令 shell-quote 后替换 {{command}}', () => {
    const command = "cd '/tmp/a b' && claude --resume abc"

    expect(renderCustomResumeTerminalCommand('otty {{command}}', command))
      .toBe(`otty ${shellQuote(command)}`)
  })

  it('自定义模板有效时执行替换后的命令', () => {
    const f = fakeDeps()
    const command = "cd '/tmp/a b' && claude --resume abc"

    const result = openResumeTerminal(
      command,
      normalizeResumeTerminalSettings({
        resumeTerminal: 'custom',
        resumeTerminalCommandTemplate: 'otty {{command}}'
      }),
      f.deps
    )

    expect(result).toEqual({ terminal: 'custom' })
    expect(f.execs).toEqual([`otty ${shellQuote(command)}`])
    expect(f.writes).toEqual([])
  })

  it.each(['', 'otty --no-placeholder'])('自定义模板无效时降级 Terminal.app：%s', (template) => {
    const f = fakeDeps()

    const result = openResumeTerminal(
      'claude --resume abc',
      normalizeResumeTerminalSettings({
        resumeTerminal: 'custom',
        resumeTerminalCommandTemplate: template
      }),
      f.deps
    )

    expect(result).toEqual({ terminal: 'terminal-app', fallbackReason: 'invalid-custom-template' })
    expect(f.warnings[0]).toContain('已改用 Terminal.app')
    expect(f.writes).toHaveLength(1)
    expect(f.execs).toEqual([`open "${f.writes[0].filePath}"`])
  })
})
