/**
 * @vitest-environment jsdom
 */
/// <reference types="@testing-library/jest-dom" />
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const savePreferences = vi.fn()

const mockStore: any = {
  settingsOpen: true,
  toggleSettings: vi.fn(),
  openSettingsAt: vi.fn(),
  consumePendingSettingsCategory: vi.fn().mockReturnValue(null),
  locale: 'zh-CN',
  setLocale: vi.fn(),
  themeMode: 'system',
  setThemeMode: vi.fn(),
  colorScheme: 'default',
  setColorScheme: vi.fn(),
  config: {
    folders: [],
    sessionMeta: {},
    preferences: {
      defaultViewMode: 'compact' as const,
      terminalApp: 'Terminal' as const
    }
  },
  savePreferences,
  toggleLens: vi.fn(),
  reorderLenses: vi.fn(),
  sshConfig: null,
  setSshConfig: vi.fn()
}

vi.mock('../store', () => ({
  useStore: (selector?: (state: typeof mockStore) => unknown) => selector ? selector(mockStore) : mockStore
}))

vi.mock('../i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../i18n')>()
  return {
    ...actual,
    useT: () => (key: string, params?: Record<string, string | number>) =>
      actual.translate('zh-CN', key, params)
  }
})

import { SettingsPanel } from './settings/SettingsPanel'

function navButton(name: string): HTMLElement {
  return within(screen.getByRole('navigation')).getByRole('button', { name })
}

describe('SettingsPanel 纵向导航设置', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    })
    savePreferences.mockClear()
    mockStore.toggleLens.mockClear()
    mockStore.reorderLenses.mockClear()
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
      llmListProfiles: vi.fn().mockResolvedValue([]),
      llmGetBindings: vi.fn().mockResolvedValue({}),
      llmSetBindings: vi.fn().mockResolvedValue({}),
      llmSaveProfile: vi.fn().mockResolvedValue(true),
      llmDeleteProfile: vi.fn().mockResolvedValue(true),
      listModels: vi.fn().mockResolvedValue([]),
      agentGetStatus: vi.fn().mockResolvedValue({ available: true, binaryPath: '/usr/local/bin/claude' }),
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
        hostname: 'test-host',
        sshEnabled: true
      }),
      networkQueryPublicIp: vi.fn().mockResolvedValue({
        ok: true,
        ip: '203.0.113.10'
      }),
      platformGetCapabilities: vi.fn().mockResolvedValue({
        platform: 'darwin',
        windowsNativeAlpha: false,
        supportedSources: ['claude-code', 'codex', 'cursor', 'opencode', 'zcode'],
        unsupportedSources: [],
        features: { wsl: false, cloudPlaceholders: true, cliInstall: true, arm64: true, autoUpdate: true, codeSigning: true }
      })
    }
  })

  afterEach(() => cleanup())

  it('左侧纵向导航显示 10 个分类(含 AI 智能、Lens 和助手),通用不再叫外观,无横向 Tab', () => {
    render(<SettingsPanel />)

    const nav = screen.getByRole('navigation')
    expect(within(nav).getAllByRole('button')).toHaveLength(10)
    expect(within(nav).getByRole('button', { name: 'AI 智能' })).not.toBeNull()
    expect(within(nav).getByRole('button', { name: 'Lens' })).not.toBeNull()
    expect(within(nav).getByRole('button', { name: '通用' })).not.toBeNull()
    expect(within(nav).queryByRole('button', { name: '外观' })).toBeNull()
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
    expect(within(nav).getByRole('button', { name: '通用' }).getAttribute('aria-current')).toBe('page')
  })

  it('终端分类展示检测结果，禁用无命令入口的 App', async () => {
    render(<SettingsPanel />)
    fireEvent.click(navButton('终端'))

    expect(await screen.findByRole('button', { name: /iTerm2/ })).not.toBeNull()
    expect((screen.getByRole('button', { name: /Tabby/ }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: /iTerm2/ }))

    expect(savePreferences).toHaveBeenCalledWith({ defaultTerminalId: 'iterm2', resumeTerminal: 'iterm' })
  })

  it('Lens 管理页的开关与排序按钮调用持久化动作', () => {
    render(<SettingsPanel />)
    fireEvent.click(navButton('Lens'))

    const switches = screen.getAllByRole('switch')
    expect(switches).toHaveLength(7)
    fireEvent.click(screen.getByRole('switch', { name: '金句划线' }))
    expect(mockStore.toggleLens).toHaveBeenCalledWith('highlights')

    fireEvent.click(screen.getByRole('button', { name: '图片索引 ↑' }))
    expect(mockStore.reorderLenses).toHaveBeenCalledWith([
      'image-index', 'highlights', 'outputs', 'token-insights', 'galaxy', 'audit', 'share-templates'
    ])
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

    fireEvent.click(navButton('终端'))

    const input = screen.getByPlaceholderText('otty {{command}}') as HTMLTextAreaElement
    expect(input.value).toBe('otty {{command}}')

    fireEvent.change(input, { target: { value: 'wezterm start -- {{command}}' } })

    expect(savePreferences).toHaveBeenCalledWith({
      resumeTerminalCommandTemplate: 'wezterm start -- {{command}}'
    })
  })

  it('Claude Desktop 实验开关默认关闭，并保存显式启用', () => {
    render(<SettingsPanel />)

    fireEvent.click(navButton('继续'))

    const toggle = screen.getByRole('checkbox', { name: '实验：导入到 Claude Desktop' })
    expect((toggle as HTMLInputElement).checked).toBe(false)

    fireEvent.click(toggle)

    expect(savePreferences).toHaveBeenCalledWith(expect.objectContaining({
      experimentalClaudeDesktopImport: true
    }))
  })

  it('提供手动检查更新入口', async () => {
    render(<SettingsPanel />)

    fireEvent.click(navButton('更新'))

    fireEvent.click(screen.getByRole('button', { name: '检查更新' }))

    expect((window as any).api.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('Resume 分类按 harness 过滤方式，不可用入口明确禁用', () => {
    render(<SettingsPanel />)
    fireEvent.click(navButton('继续'))

    const zcode = screen.getByRole('combobox', { name: /ZCode 默认方式/ }) as HTMLSelectElement
    expect(zcode.value).toBe('zcode-desktop')
    const terminalOption = Array.from(zcode.options).find((option) => option.value === 'terminal')
    expect(terminalOption?.disabled).toBe(true)
    expect(terminalOption?.textContent).toContain('没有公开 CLI Resume')

    const trae = screen.getByRole('combobox', { name: /Trae 默认方式/ }) as HTMLSelectElement
    expect(trae.disabled).toBe(true)
    expect(trae.options[0].disabled).toBe(true)
    expect(trae.options[0].textContent).toContain('No verified Trae per-session CLI resume command')
  })

  it('【曾经的 bug】SSH 分类挂载和刷新只读取本地信息，点击后才查询公网 IP', async () => {
    render(<SettingsPanel />)
    fireEvent.click(navButton('SSH'))

    expect(screen.getByText('查找远程机器地址')).not.toBeNull()
    expect(screen.getByText('配置 SSH key')).not.toBeNull()
    expect(screen.getByText('测试连接')).not.toBeNull()
    expect(screen.queryByText(/手机/)).toBeNull()

    await waitFor(() => expect((window as any).api.networkGetInfo).toHaveBeenCalledTimes(1))
    expect((window as any).api.networkQueryPublicIp).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTitle('刷新'))
    await waitFor(() => expect((window as any).api.networkGetInfo).toHaveBeenCalledTimes(2))
    expect((window as any).api.networkQueryPublicIp).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '查询公网 IP' }))
    await waitFor(() => expect((window as any).api.networkQueryPublicIp).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('203.0.113.10')).not.toBeNull()
  })

  it('SSH 公网 IP 查询超时显示可重试错误', async () => {
    ;(window as any).api.networkQueryPublicIp.mockResolvedValue({
      ok: false,
      error: 'timeout'
    })
    render(<SettingsPanel />)
    fireEvent.click(navButton('SSH'))

    fireEvent.click(await screen.findByRole('button', { name: '查询公网 IP' }))

    expect((await screen.findByRole('status')).textContent).toBe('公网 IP 查询超时，请稍后重试。')
    expect((screen.getByRole('button', { name: '查询公网 IP' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('视图分类能保存默认排序', () => {
    render(<SettingsPanel />)
    fireEvent.click(navButton('视图'))
    fireEvent.click(screen.getByRole('button', { name: '轮数' }))

    expect(savePreferences).toHaveBeenCalledWith({ defaultSort: 'turns' })
  })

  it('Windows Alpha 显式告知来源与发布边界，不显示 macOS 终端', async () => {
    ;(window as any).api.platformGetCapabilities.mockResolvedValue({
      platform: 'win32',
      windowsNativeAlpha: true,
      supportedSources: ['claude-code', 'codex'],
      unsupportedSources: ['cursor', 'opencode', 'zcode', 'cc-mirror', 'antigravity', 'grok', 'pi', 'kimi', 'hermes', 'qoder', 'trae'],
      features: { wsl: false, cloudPlaceholders: false, cliInstall: false, arm64: false, autoUpdate: false, codeSigning: false }
    })

    render(<SettingsPanel />)
    expect(await screen.findByText('Windows Native Alpha')).toBeTruthy()
    fireEvent.click(navButton('终端'))

    expect(await screen.findByText('Windows Terminal')).toBeTruthy()
    expect(screen.getByText('PowerShell')).toBeTruthy()
    expect(screen.getByText('cmd')).toBeTruthy()
    expect(screen.queryByText('iTerm2')).toBeNull()
    expect(screen.getByText(/Cursor、OpenCode、ZCode/)).toBeTruthy()
    expect(within(screen.getByRole('navigation')).queryByRole('button', { name: 'SSH' })).toBeNull()
    expect(within(screen.getByRole('navigation')).queryByRole('button', { name: 'CLI' })).toBeNull()
  })
})
