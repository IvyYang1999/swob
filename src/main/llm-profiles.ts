import { createHash, randomUUID } from 'node:crypto'
import type { LlmSettings } from './llm-client'
import {
  SecurityCliProfileSecretStore,
  SecurityCliSecretStore,
  type ProfileSecretStore,
  type SecretStore
} from './llm-secret-store'
import { migrateLegacyLlmCredential } from './llm-legacy-settings'
import { loadLibraryConfig, saveLibraryConfig, type LibraryConfig } from './library-manager'

export type LlmProvider = 'anthropic' | 'openai' | 'custom'

export interface LlmProfile {
  id: string
  name: string
  provider: LlmProvider
  model: string
  baseUrl?: string
  keyHint: string
}

export interface SmartFeatureBinding {
  insights?: string
  smartOrganize?: string
  smartRename?: string
  globalAgent?: string
}

export type SmartFeature = keyof SmartFeatureBinding

export interface SaveLlmProfileInput {
  id?: string
  name: string
  provider: LlmProvider
  model?: string
  baseUrl?: string
  credential?: string
  clearCredential?: boolean
}

export type LlmProfileErrorCode =
  | 'INVALID_PROFILE'
  | 'PROFILE_NOT_FOUND'
  | 'PROFILE_NOT_BOUND'
  | 'PROFILE_KEY_MISSING'
  | 'KEYCHAIN_WRITE_FAILED'
  | 'KEYCHAIN_UNAVAILABLE'

export class LlmProfileError extends Error {
  constructor(
    readonly code: LlmProfileErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'LlmProfileError'
  }
}

const PROVIDERS = new Set<LlmProvider>(['anthropic', 'openai', 'custom'])
const FEATURES: readonly SmartFeature[] = ['insights', 'smartOrganize', 'smartRename', 'globalAgent']
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const defaultProfileStore = new SecurityCliProfileSecretStore()
const defaultLegacyStore = new SecurityCliSecretStore()

function hintFor(value: string): string {
  return value ? `…${Array.from(value).slice(-4).join('')}` : ''
}

function profilePreferences(config: LibraryConfig): {
  profiles: LlmProfile[]
  bindings: SmartFeatureBinding
} {
  const rawProfiles = Array.isArray(config.preferences.llmProfiles)
    ? config.preferences.llmProfiles
    : []
  const profiles = rawProfiles.filter((profile): profile is LlmProfile => {
    return Boolean(
      profile &&
      typeof profile.id === 'string' &&
      typeof profile.name === 'string' &&
      PROVIDERS.has(profile.provider) &&
      typeof profile.model === 'string' &&
      typeof profile.keyHint === 'string'
    )
  }).map((profile) => ({ ...profile }))
  const rawBindings = config.preferences.smartFeatureBindings || {}
  const bindings: SmartFeatureBinding = {}
  for (const feature of FEATURES) {
    const profileId = rawBindings[feature]
    if (typeof profileId === 'string' && profileId) bindings[feature] = profileId
  }
  return { profiles, bindings }
}

function writeProfilePreferences(
  config: LibraryConfig,
  profiles: readonly LlmProfile[],
  bindings: SmartFeatureBinding
): void {
  config.preferences.llmProfiles = profiles.map((profile) => ({ ...profile }))
  config.preferences.smartFeatureBindings = { ...bindings }
}

function validateProfileId(profileId: string): void {
  if (!UUID_PATTERN.test(profileId)) {
    throw new LlmProfileError('INVALID_PROFILE', 'Profile id 必须是 UUID')
  }
}

function normalizeProfileInput(input: SaveLlmProfileInput): Omit<LlmProfile, 'id' | 'keyHint'> {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name || Array.from(name).length > 80 || !PROVIDERS.has(input.provider)) {
    throw new LlmProfileError('INVALID_PROFILE', 'Profile 名称或 provider 无效')
  }
  const model = typeof input.model === 'string' ? input.model.trim() : ''
  if (Array.from(model).length > 200) {
    throw new LlmProfileError('INVALID_PROFILE', '模型名称过长')
  }
  const baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl.trim() : ''
  if (baseUrl) {
    try {
      const parsed = new URL(baseUrl)
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('invalid protocol')
      if (parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new Error('credentials or query are not allowed')
      }
    } catch {
      throw new LlmProfileError('INVALID_PROFILE', 'Base URL 必须是无凭据、查询参数和片段的 HTTP(S) 地址')
    }
  }
  return {
    name,
    provider: input.provider,
    model,
    ...(baseUrl ? { baseUrl } : {})
  }
}

function legacyProfileId(libraryRoot: string): string {
  const hex = createHash('sha256').update(`swob-legacy-llm:${libraryRoot}`).digest('hex').slice(0, 32)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`
}

/** Move the legacy single LLM setting into a deterministic first Profile. */
export async function migrateLegacyLlmProfile(
  legacyStore: SecretStore = defaultLegacyStore,
  profileStore: ProfileSecretStore = defaultProfileStore
): Promise<boolean> {
  await migrateLegacyLlmCredential(legacyStore)
  const config = loadLibraryConfig()
  const legacy = config.llmSettings
  if (!legacy) return false

  const { profiles, bindings } = profilePreferences(config)
  const alreadyBound = bindings.insights && profiles.some((profile) => profile.id === bindings.insights)
  if (!alreadyBound) {
    const profileId = legacyProfileId(config.libraryRoot)
    const secret = await legacyStore.get()
    if (secret) {
      await profileStore.set(profileId, secret)
      if (await profileStore.get(profileId) !== secret) {
        throw new LlmProfileError('KEYCHAIN_WRITE_FAILED', 'Profile Keychain 写入校验失败')
      }
    }
    const migrated: LlmProfile = {
      id: profileId,
      name: '默认',
      provider: PROVIDERS.has(legacy.provider) ? legacy.provider : 'anthropic',
      model: legacy.model || '',
      ...(legacy.baseUrl ? { baseUrl: legacy.baseUrl } : {}),
      keyHint: secret ? hintFor(secret) : legacy.keyHint || ''
    }
    const index = profiles.findIndex((profile) => profile.id === profileId)
    if (index >= 0) profiles[index] = migrated
    else profiles.push(migrated)
    bindings.insights = profileId
  }

  writeProfilePreferences(config, profiles, bindings)
  delete config.llmSettings
  saveLibraryConfig(config)
  return true
}

export async function listLlmProfiles(
  profileStore: ProfileSecretStore = defaultProfileStore,
  legacyStore: SecretStore = defaultLegacyStore
): Promise<LlmProfile[]> {
  await migrateLegacyLlmProfile(legacyStore, profileStore)
  return profilePreferences(loadLibraryConfig()).profiles
}

export async function saveLlmProfile(
  input: SaveLlmProfileInput,
  profileStore: ProfileSecretStore = defaultProfileStore,
  legacyStore: SecretStore = defaultLegacyStore
): Promise<LlmProfile> {
  await migrateLegacyLlmProfile(legacyStore, profileStore)
  const normalized = normalizeProfileInput(input)
  const profileId = input.id || randomUUID()
  validateProfileId(profileId)

  const config = loadLibraryConfig()
  const { profiles, bindings } = profilePreferences(config)
  const existingIndex = profiles.findIndex((profile) => profile.id === profileId)
  if (input.id && existingIndex < 0) {
    throw new LlmProfileError('PROFILE_NOT_FOUND', '要更新的 Profile 不存在')
  }

  const previousSecret = await profileStore.get(profileId)
  const providedSecret = typeof input.credential === 'string' ? input.credential.trim() : ''
  let nextSecret = previousSecret
  if (input.clearCredential) {
    await profileStore.delete(profileId)
    nextSecret = null
  } else if (providedSecret) {
    await profileStore.set(profileId, providedSecret)
    if (await profileStore.get(profileId) !== providedSecret) {
      throw new LlmProfileError('KEYCHAIN_WRITE_FAILED', 'Profile Keychain 写入校验失败')
    }
    nextSecret = providedSecret
  }

  const profile: LlmProfile = {
    id: profileId,
    ...normalized,
    keyHint: nextSecret ? hintFor(nextSecret) : ''
  }
  if (existingIndex >= 0) profiles[existingIndex] = profile
  else profiles.push(profile)
  writeProfilePreferences(config, profiles, bindings)

  try {
    saveLibraryConfig(config)
  } catch (error) {
    try {
      if (previousSecret) await profileStore.set(profileId, previousSecret)
      else await profileStore.delete(profileId)
    } catch { /* keep the original persistence error */ }
    throw error
  }
  return profile
}

export async function deleteLlmProfile(
  profileId: string,
  profileStore: ProfileSecretStore = defaultProfileStore,
  legacyStore: SecretStore = defaultLegacyStore
): Promise<boolean> {
  validateProfileId(profileId)
  await migrateLegacyLlmProfile(legacyStore, profileStore)
  const config = loadLibraryConfig()
  const { profiles, bindings } = profilePreferences(config)
  if (!profiles.some((profile) => profile.id === profileId)) return false

  const previousSecret = await profileStore.get(profileId)
  await profileStore.delete(profileId)
  const nextProfiles = profiles.filter((profile) => profile.id !== profileId)
  for (const feature of FEATURES) {
    if (bindings[feature] === profileId) delete bindings[feature]
  }
  writeProfilePreferences(config, nextProfiles, bindings)
  try {
    saveLibraryConfig(config)
  } catch (error) {
    if (previousSecret) {
      try { await profileStore.set(profileId, previousSecret) } catch { /* preserve original error */ }
    }
    throw error
  }
  return true
}

export async function getSmartFeatureBindings(
  profileStore: ProfileSecretStore = defaultProfileStore,
  legacyStore: SecretStore = defaultLegacyStore
): Promise<SmartFeatureBinding> {
  await migrateLegacyLlmProfile(legacyStore, profileStore)
  return profilePreferences(loadLibraryConfig()).bindings
}

export async function setSmartFeatureBindings(
  input: SmartFeatureBinding,
  profileStore: ProfileSecretStore = defaultProfileStore,
  legacyStore: SecretStore = defaultLegacyStore
): Promise<SmartFeatureBinding> {
  await migrateLegacyLlmProfile(legacyStore, profileStore)
  const config = loadLibraryConfig()
  const { profiles } = profilePreferences(config)
  const profileIds = new Set(profiles.map((profile) => profile.id))
  const bindings: SmartFeatureBinding = {}
  for (const feature of FEATURES) {
    const profileId = input?.[feature]
    if (profileId === undefined || profileId === null || profileId === '') continue
    if (typeof profileId !== 'string' || !profileIds.has(profileId)) {
      throw new LlmProfileError('PROFILE_NOT_FOUND', `${feature} 绑定的 Profile 不存在`)
    }
    bindings[feature] = profileId
  }
  writeProfilePreferences(config, profiles, bindings)
  saveLibraryConfig(config)
  return bindings
}

export async function getLlmProfileForFeature(
  feature: SmartFeature,
  profileStore: ProfileSecretStore = defaultProfileStore,
  legacyStore: SecretStore = defaultLegacyStore
): Promise<LlmProfile | null> {
  if (!FEATURES.includes(feature)) {
    throw new LlmProfileError('INVALID_PROFILE', '未知智能功能')
  }
  await migrateLegacyLlmProfile(legacyStore, profileStore)
  const { profiles, bindings } = profilePreferences(loadLibraryConfig())
  const profileId = bindings[feature]
  return profileId ? profiles.find((profile) => profile.id === profileId) || null : null
}

/** Main-process only. Never expose this return value through preload/renderer IPC. */
export async function resolveProfileForFeature(
  feature: SmartFeature,
  profileStore: ProfileSecretStore = defaultProfileStore,
  legacyStore: SecretStore = defaultLegacyStore
): Promise<LlmSettings> {
  const profile = await getLlmProfileForFeature(feature, profileStore, legacyStore)
  if (!profile) {
    const bindings = await getSmartFeatureBindings(profileStore, legacyStore)
    throw new LlmProfileError(
      bindings[feature] ? 'PROFILE_NOT_FOUND' : 'PROFILE_NOT_BOUND',
      bindings[feature] ? '绑定的 Profile 不存在' : '尚未绑定 LLM Profile'
    )
  }
  let credential: string | null
  try {
    credential = await profileStore.get(profile.id)
  } catch {
    throw new LlmProfileError('KEYCHAIN_UNAVAILABLE', '无法读取系统 Keychain')
  }
  if (!credential) {
    throw new LlmProfileError('PROFILE_KEY_MISSING', `Profile「${profile.name}」缺少 API Key`)
  }
  return {
    provider: profile.provider,
    credential,
    model: profile.model || undefined,
    baseUrl: profile.baseUrl
  }
}

export async function getSmartFeatureAvailability(
  feature: SmartFeature,
  profileStore: ProfileSecretStore = defaultProfileStore,
  legacyStore: SecretStore = defaultLegacyStore
): Promise<{ enabled: boolean; reason?: string; code?: LlmProfileErrorCode }> {
  try {
    await resolveProfileForFeature(feature, profileStore, legacyStore)
    return { enabled: true }
  } catch (error) {
    if (error instanceof LlmProfileError) {
      return { enabled: false, reason: error.message, code: error.code }
    }
    return { enabled: false, reason: '无法读取 LLM Profile', code: 'KEYCHAIN_UNAVAILABLE' }
  }
}
