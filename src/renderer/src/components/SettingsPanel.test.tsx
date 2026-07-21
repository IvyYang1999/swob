/**
 * @vitest-environment jsdom
 */
/// <reference types="@testing-library/jest-dom" />
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

const savePreferences = vi.fn()

const mockStore: any = {
  settingsOpen: true,
  toggleSettings: vi.fn(),
  locale: 'zh-CN',
  setLocale: vi.fn(),
  themeMode: 'system',
  setThemeMode: vi.fn(),
  config: {
    folders: [],
    sessionMeta: {},
    preferences: {
      defaultViewMode: 'compact' as const,
      terminalApp: 'Terminal' as const
    }
  },
  savePreferences,
  sshConfig: null,
  setSshConfig: vi.fn()
}

vi.mock('../store', () => ({
  useStore: () => mockStore
}))

vi.mock('../i18n', () => ({
  useT: () => (key: string) => {
    const labels: Record<string, string> = {
      'settings.title': '设置',
      'settings.theme': '外观',
      'settings.theme_light': '浅色',
      'settings.theme_dark': '深色',
      'settings.theme_system': '跟随系统',
      'settings.language': '语言',
      'settings.spotlight_shortcut': '全局跳转快捷键',
      'settings.spotlight_shortcut_hint': '按下新的快捷键组合来更改',
      'settings.spotlight_shortcut_recording': '正在录制…',
      'settings.reset_shortcut': '重置',
      'settings.resume_terminal': 'Resume 终端',
      'settings.resume_terminal_terminal_app': 'Terminal.app',
      'settings.resume_terminal_iterm': 'iTerm',
      'settings.resume_terminal_custom': '自定义模板',
      'settings.resume_terminal_custom_hint': '模板必须包含 {{command}}',
      'settings.resume_terminal_custom_invalid': '模板无效',
      'settings.experimental_claude_desktop': '实验：导入到 Claude Desktop',
      'settings.experimental_claude_desktop_warning': '导入可能修改原始 transcript',
      'settings.ssh': 'SSH 远程',
      'settings.ssh_host': '主机',
      'settings.ssh_user': '用户名',
      'settings.ssh_remote_path': '远程路径（可选）',
      'settings.ssh_save': '保存',
      'settings.ssh_clear': '清除',
      'settings.project_view': '项目视图',
      'settings.project_view_folders': '按整理的文件夹',
      'settings.project_view_paths': '按实际项目路径',
      'settings.update': '软件更新',
      'settings.check_for_updates': '检查更新',
      'settings.checking_update': '正在检查更新…'
    }
    return labels[key] || key
  }
}))

import { SettingsPanel } from './SettingsPanelV2'

describe('SettingsPanel 七 Tab 设置', () => {
  beforeEach(() => {
    savePreferences.mockClear()
    mockStore.config = {
      folders: [],
      sessionMeta: {},
      preferences: {
        defaultViewMode: 'compact' as const,
        terminalApp: 'Terminal' as const
      }
    }
    ;(window as any).api = {
      cliGetStatus: vi.fn().mockResolvedValue({
        cliInstalled: true,
        symlinkInstalled: true,
        skillInstalled: true,
        cliPath: '/Applications/Swob.app/Contents/Resources/app.asar/out/main/cli.js',
        commandPath: '/usr/local/bin/swob',
        skillPath: '/tmp/.claude/skills/swob/SKILL.md'
      }),
      cliInstall: vi.fn(),
      getCleanupDays: vi.fn().mockResolvedValue(30),
      setCleanupDays: vi.fn().mockResolvedValue(true),
      getLlmSettings: vi.fn().mockResolvedValue({ provider: 'anthropic', hasKey: false, keyHint: '', model: '', baseUrl: '' }),
      setLlmSettings: vi.fn().mockResolvedValue(true),
      checkForUpdates: vi.fn().mockResolvedValue(undefined),
      getAppInfo: vi.fn().mockResolvedValue({ version: '1.2.0', platform: 'darwin' }),
      getDetectedTerminals: vi.fn().mockResolvedValue([
        { id: 'apple-terminal', name: 'Terminal', path: '/System/Applications/Utilities/Terminal.app', commandSupport: 'stable', canRunCommand: true, evidence: 'system-path' },
        { id: 'iterm2', name: 'iTerm2', path: '/Applications/iTerm.app', commandSupport: 'stable', canRunCommand: true, evidence: 'app-path' },
        { id: 'tabby', name: 'Tabby', path: '/Applications/Tabby.app', commandSupport: 'none', canRunCommand: false, limitation: '没有稳定入口', evidence: 'app-path' }
      ]),
      networkGetInfo: vi.fn().mockResolvedValue({
        localIps: [],
        tailscaleIp: null,
        publicIp: null,
        hostname: 'test-host',
        sshEnabled: true
      })
    }
  })

  afterEach(() => cleanup())

  it('顶部严格显示 7 个独立 Tab，通用不再叫外观', () => {
    render(<SettingsPanel />)

    expect(screen.getAllByRole('tab')).toHaveLength(7)
    expect(screen.getByRole('tab', { name: '通用' })).not.toBeNull()
    expect(screen.queryByRole('tab', { name: '外观' })).toBeNull()
  })

  it('终端 Tab 展示检测结果，禁用无命令入口的 App', async () => {
    render(<SettingsPanel />)
    fireEvent.click(screen.getByRole('tab', { name: '终端' }))

    expect(await screen.findByRole('button', { name: /iTerm2/ })).not.toBeNull()
    expect((screen.getByRole('button', { name: /Tabby/ }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: /iTerm2/ }))

    expect(savePreferences).toHaveBeenCalledWith({ defaultTerminalId: 'iterm2', resumeTerminal: 'iterm' })
  })

  it('自定义模板会从配置读出并保存修改', () => {
    mockStore.config = {
      folders: [],
      sessionMeta: {},
      preferences: {
        defaultViewMode: 'compact' as const,
        terminalApp: 'Terminal' as const,
        defaultTerminalId: 'custom',
        resumeTerminal: 'custom' as const,
        resumeTerminalCommandTemplate: 'otty {{command}}'
      }
    }

    render(<SettingsPanel />)

    fireEvent.click(screen.getByRole('tab', { name: '终端' }))

    const input = screen.getByPlaceholderText('otty {{command}}') as HTMLTextAreaElement
    expect(input.value).toBe('otty {{command}}')

    fireEvent.change(input, { target: { value: 'wezterm start -- {{command}}' } })

    expect(savePreferences).toHaveBeenCalledWith({
      resumeTerminalCommandTemplate: 'wezterm start -- {{command}}'
    })
  })

  it('Claude Desktop 实验开关默认关闭，并保存显式启用', () => {
    render(<SettingsPanel />)

    fireEvent.click(screen.getByRole('tab', { name: 'Resume' }))

    const toggle = screen.getByRole('checkbox', { name: '实验：导入到 Claude Desktop' })
    expect((toggle as HTMLInputElement).checked).toBe(false)

    fireEvent.click(toggle)

    expect(savePreferences).toHaveBeenCalledWith(expect.objectContaining({
      experimentalClaudeDesktopImport: true
    }))
  })

  it('提供手动检查更新入口', async () => {
    render(<SettingsPanel />)

    fireEvent.click(screen.getByRole('tab', { name: '更新' }))

    fireEvent.click(screen.getByRole('button', { name: '检查更新' }))

    expect((window as any).api.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('Resume Tab 按 harness 过滤方式，ZCode 终端选项明确禁用', () => {
    render(<SettingsPanel />)
    fireEvent.click(screen.getByRole('tab', { name: 'Resume' }))

    const zcode = screen.getByRole('combobox', { name: /ZCode 默认方式/ }) as HTMLSelectElement
    expect(zcode.value).toBe('zcode-desktop')
    const terminalOption = Array.from(zcode.options).find((option) => option.value === 'terminal')
    expect(terminalOption?.disabled).toBe(true)
    expect(terminalOption?.textContent).toContain('没有公开 CLI Resume')
  })

  it('SSH Tab 提供三段折叠教程，且不再出现手机文案', () => {
    render(<SettingsPanel />)
    fireEvent.click(screen.getByRole('tab', { name: 'SSH' }))

    expect(screen.getByText('查找远程机器地址')).not.toBeNull()
    expect(screen.getByText('配置 SSH key')).not.toBeNull()
    expect(screen.getByText('测试连接')).not.toBeNull()
    expect(screen.queryByText(/手机/)).toBeNull()
  })

  it('视图 Tab 能保存默认排序', () => {
    render(<SettingsPanel />)
    fireEvent.click(screen.getByRole('tab', { name: '视图' }))
    fireEvent.click(screen.getByRole('button', { name: '轮数' }))

    expect(savePreferences).toHaveBeenCalledWith({ defaultSort: 'turns' })
  })
})
