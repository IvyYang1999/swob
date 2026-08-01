import type { UserConfig } from './types'
import {
  isUnifiedProviderSource,
  type UnifiedProviderSource
} from '../shared/seven-source-contract-v2'

export type ProviderAdapterMode = 'unified-v2' | 'legacy'

export interface ProviderAdapterModeDecision {
  mode: ProviderAdapterMode
  reason: 'default' | 'global-config' | 'source-config' | 'environment'
}

function configuredLegacySources(config?: Pick<UserConfig, 'preferences'>): Set<string> {
  return new Set(config?.preferences.legacyProviderSources || [])
}

/** Global and per-source migration kill switches; omitted means unified-v2. */
export function providerAdapterMode(
  source: string,
  config?: Pick<UserConfig, 'preferences'>,
  environment: NodeJS.ProcessEnv = process.env
): ProviderAdapterModeDecision {
  if (!isUnifiedProviderSource(source)) return { mode: 'legacy', reason: 'default' }
  if (environment.SWOB_PROVIDER_ADAPTER_MODE === 'legacy') {
    return { mode: 'legacy', reason: 'environment' }
  }
  if (config?.preferences.providerAdapterMode === 'legacy') {
    return { mode: 'legacy', reason: 'global-config' }
  }
  if (configuredLegacySources(config).has(source)) {
    return { mode: 'legacy', reason: 'source-config' }
  }
  return { mode: 'unified-v2', reason: 'default' }
}

export function legacyProviderSources(config?: Pick<UserConfig, 'preferences'>): UnifiedProviderSource[] {
  return [...configuredLegacySources(config)].filter(isUnifiedProviderSource)
}
