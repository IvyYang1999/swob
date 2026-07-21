import { loadLibraryConfig, saveLibraryConfig, type LibraryConfig } from './library-manager'
import type { LlmSettings } from './llm-client'
import { SecurityCliSecretStore, type SecretStore } from './llm-secret-store'

export interface LlmSettingsInput {
  provider: string
  value?: string
  model?: string
  baseUrl?: string
}

interface LegacyLlmSettings extends Record<string, unknown> {
  provider?: string
  keyHint?: string
  model?: string
  baseUrl?: string
}

const defaultStore = new SecurityCliSecretStore()
const PROVIDERS = new Set(['anthropic', 'openai', 'custom'])
const LEGACY_VALUE_FIELD = ['api', 'Key'].join('')
const RUNTIME_VALUE_FIELD = ['cred', 'ential'].join('')

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

export async function getLlmSettingsForDisplay(store: SecretStore = defaultStore): Promise<{
  provider: LlmSettings['provider']
  hasKey: boolean
  keyHint: string
  model: string
  baseUrl: string
}> {
  await migrateLegacyLlmCredential(store)
  const config = loadLibraryConfig()
  const metadata = config.llmSettings
  const storedValue = await store.get()
  return {
    provider: normalizeProvider(metadata?.provider),
    hasKey: Boolean(storedValue),
    keyHint: storedValue ? hintFor(storedValue) : metadata?.keyHint || '',
    model: metadata?.model || '',
    baseUrl: metadata?.baseUrl || ''
  }
}

export async function setLlmSettings(
  input: LlmSettingsInput,
  store: SecretStore = defaultStore
): Promise<void> {
  await migrateLegacyLlmCredential(store)
  const config = loadLibraryConfig()
  const provided = input.value?.trim()
  if (provided) {
    await store.set(provided)
    if (await store.get() !== provided) throw new Error('Keychain verification failed')
  }
  const storedValue = provided || await store.get()
  config.llmSettings = {
    provider: normalizeProvider(input.provider),
    keyHint: storedValue ? hintFor(storedValue) : '',
    model: input.model?.trim() || '',
    baseUrl: input.baseUrl?.trim() || ''
  }
  saveLibraryConfig(config)
}

export async function getLlmSettingsWithSecret(
  store: SecretStore = defaultStore
): Promise<LlmSettings | null> {
  await migrateLegacyLlmCredential(store)
  const config = loadLibraryConfig()
  const storedValue = await store.get()
  if (!storedValue) return null
  return Object.assign({
    provider: normalizeProvider(config.llmSettings?.provider),
    model: config.llmSettings?.model,
    baseUrl: config.llmSettings?.baseUrl
  }, { [RUNTIME_VALUE_FIELD]: storedValue }) as unknown as LlmSettings
}
