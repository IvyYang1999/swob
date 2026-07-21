import type { LlmSettings } from './llm-client'
import { loadLibraryConfig, saveLibraryConfig, type LibraryConfig } from './library-manager'
import { SecurityCliSecretStore, type SecretStore } from './llm-secret-store'

interface LegacyLlmSettings extends Record<string, unknown> {
  provider?: string
  keyHint?: string
  model?: string
  baseUrl?: string
}

const defaultStore = new SecurityCliSecretStore()
const PROVIDERS = new Set(['anthropic', 'openai', 'custom'])
const LEGACY_VALUE_FIELD = ['api', 'Key'].join('')

function normalizeProvider(provider?: string): LlmSettings['provider'] {
  return PROVIDERS.has(provider || '') ? provider as LlmSettings['provider'] : 'anthropic'
}

function hintFor(value: string): string {
  return value ? `…${Array.from(value).slice(-4).join('')}` : ''
}

function legacySettings(config: LibraryConfig): LegacyLlmSettings | undefined {
  return (config as LibraryConfig & { llmSettings?: LegacyLlmSettings }).llmSettings
}

function plaintextFrom(settings?: LegacyLlmSettings): string {
  const value = settings?.[LEGACY_VALUE_FIELD]
  return typeof value === 'string' ? value.trim() : ''
}

/** Move a pre-t099 plaintext credential into the legacy Keychain account. */
export async function migrateLegacyLlmCredential(store: SecretStore = defaultStore): Promise<boolean> {
  const config = loadLibraryConfig()
  const legacy = legacySettings(config)
  const plaintext = plaintextFrom(legacy)
  if (!plaintext) return false

  await store.set(plaintext)
  const verified = await store.get()
  if (verified !== plaintext) throw new Error('Keychain verification failed; Library config was left unchanged')

  config.llmSettings = {
    provider: normalizeProvider(legacy?.provider),
    keyHint: hintFor(plaintext),
    model: legacy?.model?.trim() || '',
    baseUrl: legacy?.baseUrl?.trim() || ''
  }
  saveLibraryConfig(config)
  return true
}
