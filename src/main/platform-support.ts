import type { SessionSource } from './types'
import {
  BUILTIN_PROVIDER_DEFINITIONS,
  type BuiltinProviderTier
} from '../shared/provider-capabilities'
import type { ProviderCapabilities } from '../shared/provider-schema.generated'

const WINDOWS_ALPHA_SOURCES = new Set<SessionSource>(['claude-code', 'codex'])

const SOURCE_LABELS = new Map(BUILTIN_PROVIDER_DEFINITIONS.map((entry) => [
  entry.sourceId,
  entry.manifest.displayName
]))

export interface PlatformProviderCapabilities {
  sourceId: SessionSource
  providerId: string
  displayName: string
  tier: BuiltinProviderTier
  discoverableOnPlatform: boolean
  capabilities: ProviderCapabilities
}

export interface PlatformCapabilities {
  platform: NodeJS.Platform
  windowsNativeAlpha: boolean
  /** Sources whose discovery path is implemented on this platform. */
  discoverableSources: SessionSource[]
  undiscoverableSources: SessionSource[]
  providers: PlatformProviderCapabilities[]
  /** @deprecated This means platform discovery, not full transcript support. */
  supportedSources: SessionSource[]
  /** @deprecated Use undiscoverableSources. */
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

export function isSessionSourceDiscoverable(
  source: SessionSource,
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform !== 'win32' || WINDOWS_ALPHA_SOURCES.has(source)
}

/** @deprecated This checks platform discovery only, not parser capabilities. */
export const isSessionSourceSupported = isSessionSourceDiscoverable

export function alphaUnsupportedReason(
  source: SessionSource,
  platform: NodeJS.Platform = process.platform
): string | undefined {
  if (isSessionSourceDiscoverable(source, platform)) return undefined
  return `Windows Alpha 暂不支持 ${SOURCE_LABELS.get(source) || source}`
}

export function getPlatformProviderCapabilities(
  platform: NodeJS.Platform = process.platform
): PlatformProviderCapabilities[] {
  return BUILTIN_PROVIDER_DEFINITIONS.map((entry) => ({
    sourceId: entry.sourceId,
    providerId: entry.manifest.providerId,
    displayName: entry.manifest.displayName,
    tier: entry.tier,
    discoverableOnPlatform: isSessionSourceDiscoverable(entry.sourceId, platform),
    capabilities: entry.manifest.capabilities
  }))
}

export function getPlatformCapabilities(
  platform: NodeJS.Platform = process.platform
): PlatformCapabilities {
  const providers = getPlatformProviderCapabilities(platform)
  const discoverableSources = providers
    .filter((provider) => provider.discoverableOnPlatform)
    .map((provider) => provider.sourceId)
  const undiscoverableSources = providers
    .filter((provider) => !provider.discoverableOnPlatform)
    .map((provider) => provider.sourceId)
  if (platform !== 'win32') {
    return {
      platform,
      windowsNativeAlpha: false,
      discoverableSources,
      undiscoverableSources,
      providers,
      supportedSources: [...discoverableSources],
      unsupportedSources: [...undiscoverableSources],
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
    discoverableSources,
    undiscoverableSources,
    providers,
    supportedSources: [...discoverableSources],
    unsupportedSources: [...undiscoverableSources],
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
