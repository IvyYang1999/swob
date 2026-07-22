import type { SessionSource } from './types'

const ALL_SOURCES: SessionSource[] = [
  'claude-code', 'codex', 'cursor', 'opencode', 'zcode',
  'cc-mirror', 'antigravity', 'grok', 'pi', 'kimi', 'hermes'
]

const WINDOWS_ALPHA_SOURCES = new Set<SessionSource>(['claude-code', 'codex'])

const SOURCE_LABELS: Record<SessionSource, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  zcode: 'ZCode',
  'cc-mirror': 'CC-Mirror',
  antigravity: 'Antigravity',
  grok: 'Grok',
  pi: 'Pi',
  kimi: 'Kimi',
  hermes: 'Hermes'
}

export interface PlatformCapabilities {
  platform: NodeJS.Platform
  windowsNativeAlpha: boolean
  supportedSources: SessionSource[]
  unsupportedSources: SessionSource[]
  features: {
    wsl: boolean
    cloudPlaceholders: boolean
    cliInstall: boolean
    arm64: boolean
    autoUpdate: boolean
    codeSigning: boolean
  }
}

export function isSessionSourceSupported(
  source: SessionSource,
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform !== 'win32' || WINDOWS_ALPHA_SOURCES.has(source)
}

export function alphaUnsupportedReason(
  source: SessionSource,
  platform: NodeJS.Platform = process.platform
): string | undefined {
  if (isSessionSourceSupported(source, platform)) return undefined
  return `Windows Alpha 暂不支持 ${SOURCE_LABELS[source]}`
}

export function getPlatformCapabilities(
  platform: NodeJS.Platform = process.platform
): PlatformCapabilities {
  if (platform !== 'win32') {
    return {
      platform,
      windowsNativeAlpha: false,
      supportedSources: [...ALL_SOURCES],
      unsupportedSources: [],
      features: {
        wsl: false,
        cloudPlaceholders: platform === 'darwin',
        cliInstall: platform === 'darwin',
        arm64: true,
        autoUpdate: true,
        codeSigning: true
      }
    }
  }

  return {
    platform,
    windowsNativeAlpha: true,
    supportedSources: ALL_SOURCES.filter((source) => WINDOWS_ALPHA_SOURCES.has(source)),
    unsupportedSources: ALL_SOURCES.filter((source) => !WINDOWS_ALPHA_SOURCES.has(source)),
    // t107 Alpha intentionally fails closed for every unimplemented surface.
    features: {
      wsl: false,
      cloudPlaceholders: false,
      cliInstall: false,
      arm64: false,
      autoUpdate: false,
      codeSigning: false
    }
  }
}
