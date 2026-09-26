import {
  isUnifiedProviderSource,
  type UnifiedProviderSource
} from '../shared/seven-source-contract-v2'

export type ProviderAdapterMode = 'unified-v2' | 'legacy'

export interface ProviderAdapterModeDecision {
  mode: ProviderAdapterMode
  reason: 'default' | 'global-config' | 'source-config' | 'environment'
}

/** The only preferences this module reads. A full host UserConfig is structurally
 * assignable, so the adapter switch does not depend on the host config type. */
export interface ProviderAdapterPreferences {
  preferences: {
    providerAdapterMode?: 'unified-v2' | 'legacy'
    legacyProviderSources?: UnifiedProviderSource[]
  }
}

function configuredLegacySources(config?: ProviderAdapterPreferences): Set<string> {
  return new Set(config?.preferences.legacyProviderSources || [])
}

/** Global and per-source migration kill switches; omitted means unified-v2. */
export function providerAdapterMode(
  source: string,
  config?: ProviderAdapterPreferences,
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

export function legacyProviderSources(config?: ProviderAdapterPreferences): UnifiedProviderSource[] {
  return [...configuredLegacySources(config)].filter(isUnifiedProviderSource)
}
