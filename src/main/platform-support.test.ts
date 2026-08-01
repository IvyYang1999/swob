import { describe, expect, it } from 'vitest'
import {
  alphaUnsupportedReason,
  getPlatformCapabilities,
  getPlatformProviderCapabilities,
  isSessionSourceDiscoverable,
  isSessionSourceSupported
} from './platform-support'

describe('Windows Native Alpha capabilities', () => {
  it('Windows Alpha 只启用 Claude Code 和 Codex', () => {
    expect(isSessionSourceSupported('claude-code', 'win32')).toBe(true)
    expect(isSessionSourceSupported('codex', 'win32')).toBe(true)
    expect(isSessionSourceSupported('cursor', 'win32')).toBe(false)
    expect(isSessionSourceSupported('opencode', 'win32')).toBe(false)
    expect(isSessionSourceSupported('zcode', 'win32')).toBe(false)
    expect(alphaUnsupportedReason('opencode', 'win32')).toBe('Windows Alpha 暂不支持 OpenCode')
  })

  it('macOS 现有来源与能力保持不变', () => {
    expect(isSessionSourceSupported('opencode', 'darwin')).toBe(true)
    expect(isSessionSourceSupported('zcode', 'darwin')).toBe(true)
    const capabilities = getPlatformCapabilities('darwin')
    expect(capabilities.undiscoverableSources).toEqual([])
    expect(capabilities.supportedSources).toEqual(capabilities.discoverableSources)
    expect(capabilities.providers).toHaveLength(12)
    expect(capabilities.providers.find((provider) => provider.sourceId === 'hermes')).toMatchObject({
      tier: 'native',
      discoverableOnPlatform: true,
      capabilities: {
        transcript: { status: 'available' },
        usage: { status: 'experimental' }
      }
    })
  })

  it('platform discovery projects the audited Hermes transcript support', () => {
    expect(isSessionSourceDiscoverable('hermes', 'darwin')).toBe(true)
    const hermes = getPlatformProviderCapabilities('darwin')
      .find((provider) => provider.sourceId === 'hermes')!
    expect(hermes.capabilities.discover.status).toBe('available')
    expect(hermes.capabilities.transcript.status).toBe('available')
  })

  it('Windows Alpha 显式声明不做的边界', () => {
    expect(getPlatformCapabilities('win32')).toMatchObject({
      platform: 'win32',
      windowsNativeAlpha: true,
      discoverableSources: ['claude-code', 'codex'],
      supportedSources: ['claude-code', 'codex'],
      unsupportedSources: expect.arrayContaining(['cursor', 'opencode', 'zcode']),
      features: {
        wsl: false,
        cloudPlaceholders: false,
        cliInstall: false,
        arm64: false,
        autoUpdate: false,
        codeSigning: false
      }
    })
  })
})
