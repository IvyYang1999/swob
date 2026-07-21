import { describe, expect, it } from 'vitest'
import { detectInstalledTerminals, type TerminalDetectorDeps } from './terminal-detector'

function deps(overrides: Partial<TerminalDetectorDeps> = {}): TerminalDetectorDeps {
  return {
    platform: 'darwin',
    exists: () => false,
    findExecutable: () => null,
    findBundle: () => null,
    ...overrides
  }
}

describe('终端自动检测', () => {
  it('macOS 优先识别系统 Terminal 与 iTerm App 路径', () => {
    const found = detectInstalledTerminals(deps({
      exists: (candidate) => candidate.includes('Terminal.app') || candidate.includes('iTerm.app')
    }))

    expect(found.map((item) => item.id)).toEqual(['apple-terminal', 'iterm2'])
    expect(found.every((item) => item.canRunCommand)).toBe(true)
  })

  it('检测到 App 但没有命令入口时仍展示，禁止选为 Resume 终端', () => {
    const found = detectInstalledTerminals(deps({
      findBundle: (bundleId) => bundleId === 'org.tabby' ? '/Applications/Tabby.app' : null
    }))

    expect(found).toEqual([expect.objectContaining({
      id: 'tabby', canRunCommand: false, commandSupport: 'none', evidence: 'bundle-id'
    })])
  })

  it('Linux 只使用当前平台定义并保留解析后的 executable', () => {
    const found = detectInstalledTerminals(deps({
      platform: 'linux',
      findExecutable: (name) => name === 'wezterm' ? '/usr/bin/wezterm' : null
    }))

    expect(found).toEqual([expect.objectContaining({
      id: 'wezterm', executable: '/usr/bin/wezterm', canRunCommand: true
    })])
    expect(found.some((item) => item.id === 'apple-terminal')).toBe(false)
  })
})
