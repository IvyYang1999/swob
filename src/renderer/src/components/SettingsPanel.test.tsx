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

import { SettingsPanel } from './SettingsPanel'

describe('SettingsPanel Resume 终端设置', () => {
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
        skillInstalled: true
      }),
      cliInstall: vi.fn(),
      getCleanupDays: vi.fn().mockResolvedValue(30),
      setCleanupDays: vi.fn().mockResolvedValue(true),
      getLlmSettings: vi.fn().mockResolvedValue({ provider: 'anthropic', hasKey: false, keyHint: '', model: '', baseUrl: '' }),
      setLlmSettings: vi.fn().mockResolvedValue(true),
      checkForUpdates: vi.fn().mockResolvedValue(undefined),
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

  it('点击 iTerm 会写入 Resume 终端偏好', () => {
    render(<SettingsPanel />)

    // Navigate to Terminal category in new split-pane layout
    const terminalTab = screen.queryByText('Terminal') || screen.queryByText('终端与 Resume')
    if (terminalTab) fireEvent.click(terminalTab)

    fireEvent.click(screen.getByText('iTerm'))

    expect(savePreferences).toHaveBeenCalledWith({ resumeTerminal: 'iterm' })
  })

  it('自定义模板会从配置读出并保存修改', () => {
    mockStore.config = {
      folders: [],
      sessionMeta: {},
      preferences: {
        defaultViewMode: 'compact' as const,
        terminalApp: 'Terminal' as const,
        resumeTerminal: 'custom' as const,
        resumeTerminalCommandTemplate: 'otty {{command}}'
      }
    }

    render(<SettingsPanel />)

    const terminalTab = screen.queryByText('Terminal') || screen.queryByText('终端与 Resume')
    if (terminalTab) fireEvent.click(terminalTab)

    const input = screen.getByPlaceholderText('otty {{command}}') as HTMLTextAreaElement
    expect(input.value).toBe('otty {{command}}')

    fireEvent.change(input, { target: { value: 'wezterm start -- {{command}}' } })

    expect(savePreferences).toHaveBeenCalledWith({
      resumeTerminalCommandTemplate: 'wezterm start -- {{command}}'
    })
  })

  it('提供手动检查更新入口', async () => {
    render(<SettingsPanel />)

    const updatesTab = screen.queryByText('Updates & CLI') || screen.queryByText('更新与 CLI')
    if (updatesTab) fireEvent.click(updatesTab)

    fireEvent.click(screen.getByRole('button', { name: '检查更新' }))

    expect((window as any).api.checkForUpdates).toHaveBeenCalledTimes(1)
  })
})
