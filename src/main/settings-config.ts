import type { UserConfig } from './types'
import { migrateSettingsPreferences } from '../shared/settings-capabilities'

export type SettingsPreferenceRecord = Record<string, unknown>

/**
 * Resolve the renderer's startup config without borrowing preferences from the
 * app-config fallback while an existing Library tree is still hydrating.
 */
export function resolveRendererConfig(
  appConfig: UserConfig,
  libraryPreferences?: SettingsPreferenceRecord,
  hydratedLibraryConfig?: UserConfig
): UserConfig {
  if (hydratedLibraryConfig) return hydratedLibraryConfig
  if (!libraryPreferences) return appConfig
  return {
    ...appConfig,
    preferences: libraryPreferences as unknown as UserConfig['preferences']
  }
}

/** Merge only the fields changed by the renderer, then normalize the result. */
export function mergeSettingsPreferencePatch(
  current: SettingsPreferenceRecord,
  patch: SettingsPreferenceRecord
): SettingsPreferenceRecord {
  return migrateSettingsPreferences({ ...current, ...patch })
}
