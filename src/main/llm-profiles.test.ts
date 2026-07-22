import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  initLibrary,
  invalidateLibraryConfigCache,
  loadLibraryConfig,
  saveLibraryConfig
} from './library-manager'
import {
  deleteLlmProfile,
  getSmartFeatureBindings,
  listLlmProfiles,
  migrateLegacyLlmProfile,
  resolveProfileForFeature,
  saveLlmProfile,
  setSmartFeatureBindings
} from './llm-profiles'
import type { ProfileSecretStore, SecretStore } from './llm-secret-store'

class MemoryLegacyStore implements SecretStore {
  value: string | null = null
  deleteCalls = 0
  deleteFailuresRemaining = 0
  async get(): Promise<string | null> { return this.value }
  async set(value: string): Promise<void> { this.value = value }
  async delete(): Promise<void> {
    this.deleteCalls++
    if (this.deleteFailuresRemaining > 0) {
      this.deleteFailuresRemaining--
      throw new Error('fixture cleanup failure')
    }
    this.value = null
  }
}

class MemoryProfileStore implements ProfileSecretStore {
  values = new Map<string, string>()
  deleted: string[] = []
  setCalls = 0
  failVerification = false
  async get(profileId: string): Promise<string | null> { return this.values.get(profileId) || null }
  async set(profileId: string, value: string): Promise<void> {
    this.setCalls++
    this.values.set(profileId, this.failVerification ? 'mismatch' : value)
  }
  async delete(profileId: string): Promise<void> {
    this.deleted.push(profileId)
    this.values.delete(profileId)
  }
}

const LEGACY_FIELD = ['api', 'Key'].join('')
let root = ''

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-llm-profiles-'))
  initLibrary(root)
  invalidateLibraryConfigCache()
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('LLM Profiles', () => {
  it('creates, updates, binds and deletes a Profile while keeping the key out of Library config', async () => {
    const legacyStore = new MemoryLegacyStore()
    const profileStore = new MemoryProfileStore()
    const created = await saveLlmProfile({
      name: '日常分析',
      provider: 'openai',
      model: 'test-model',
      credential: 'profile-example-1234'
    }, profileStore, legacyStore)

    expect(created.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(created.keyHint).toBe('…1234')
    expect(await listLlmProfiles(profileStore, legacyStore)).toEqual([created])
    await setSmartFeatureBindings({ insights: created.id, smartRename: created.id }, profileStore, legacyStore)
    expect((await resolveProfileForFeature('smartRename', profileStore, legacyStore)).credential)
      .toBe('profile-example-1234')
    expect(fs.readFileSync(path.join(root, '.swob-config.json'), 'utf8'))
      .not.toContain('profile-example-1234')

    const updated = await saveLlmProfile({
      id: created.id,
      name: '日常分析新版',
      provider: 'openai',
      model: 'test-model-2'
    }, profileStore, legacyStore)
    expect(updated.keyHint).toBe('…1234')

    await expect(deleteLlmProfile(created.id, profileStore, legacyStore)).resolves.toBe(true)
    expect(profileStore.deleted).toContain(created.id)
    expect(await listLlmProfiles(profileStore, legacyStore)).toEqual([])
    expect(await getSmartFeatureBindings(profileStore, legacyStore)).toEqual({})
  })

  it('migrates the legacy single setting once and keeps Insights on the new Profile path', async () => {
    const config = loadLibraryConfig()
    config.llmSettings = {
      provider: 'anthropic',
      keyHint: '',
      model: 'fixture-model',
      baseUrl: '',
      [LEGACY_FIELD]: 'legacy-example-9876'
    }
    saveLibraryConfig(config)
    const legacyStore = new MemoryLegacyStore()
    const profileStore = new MemoryProfileStore()

    await expect(migrateLegacyLlmProfile(legacyStore, profileStore)).resolves.toBe(true)
    await expect(migrateLegacyLlmProfile(legacyStore, profileStore)).resolves.toBe(false)

    const profiles = await listLlmProfiles(profileStore, legacyStore)
    const bindings = await getSmartFeatureBindings(profileStore, legacyStore)
    expect(profiles).toHaveLength(1)
    expect(profiles[0]).toMatchObject({ name: '默认', provider: 'anthropic', keyHint: '…9876' })
    expect(bindings.insights).toBe(profiles[0].id)
    expect((await resolveProfileForFeature('insights', profileStore, legacyStore)).credential)
      .toBe('legacy-example-9876')
    expect(loadLibraryConfig().llmSettings).toBeUndefined()
    expect(legacyStore.value).toBeNull()
    expect(legacyStore.deleteCalls).toBe(1)
    expect(fs.readFileSync(path.join(root, '.swob-config.json'), 'utf8'))
      .not.toContain('legacy-example-9876')
  })

  it('single-flights concurrent Profile migration and retries cleanly after verification failure', async () => {
    const config = loadLibraryConfig()
    config.llmSettings = {
      provider: 'anthropic',
      keyHint: '',
      model: 'fixture-model',
      baseUrl: '',
      [LEGACY_FIELD]: 'legacy-retry-1357'
    }
    saveLibraryConfig(config)
    const legacyStore = new MemoryLegacyStore()
    const profileStore = new MemoryProfileStore()
    profileStore.failVerification = true

    await expect(Promise.all([
      migrateLegacyLlmProfile(legacyStore, profileStore),
      migrateLegacyLlmProfile(legacyStore, profileStore),
      migrateLegacyLlmProfile(legacyStore, profileStore)
    ])).rejects.toMatchObject({ code: 'KEYCHAIN_WRITE_FAILED' })
    expect(profileStore.setCalls).toBe(1)
    expect(loadLibraryConfig().llmSettings).toBeDefined()
    expect(legacyStore.deleteCalls).toBe(0)

    profileStore.failVerification = false
    await expect(migrateLegacyLlmProfile(legacyStore, profileStore)).resolves.toBe(true)
    expect(profileStore.setCalls).toBe(2)
    expect(legacyStore.deleteCalls).toBe(1)
    expect(loadLibraryConfig().llmSettings).toBeUndefined()
  })

  it('keeps an explicit Profile save available while legacy cleanup waits for retry', async () => {
    const config = loadLibraryConfig()
    config.llmSettings = {
      provider: 'anthropic',
      keyHint: '',
      model: 'fixture-model',
      baseUrl: '',
      [LEGACY_FIELD]: 'legacy-cleanup-8642'
    }
    saveLibraryConfig(config)
    const legacyStore = new MemoryLegacyStore()
    legacyStore.deleteFailuresRemaining = 1
    const profileStore = new MemoryProfileStore()

    const created = await saveLlmProfile({
      name: '新配置',
      provider: 'openai',
      model: 'new-model',
      credential: 'new-profile-4321'
    }, profileStore, legacyStore)

    expect(created.keyHint).toBe('…4321')
    expect(loadLibraryConfig().preferences.llmProfiles).toContainEqual(created)
    expect(loadLibraryConfig().llmSettings).toBeDefined()

    await expect(migrateLegacyLlmProfile(legacyStore, profileStore)).resolves.toBe(true)
    expect(loadLibraryConfig().llmSettings).toBeUndefined()
    expect(legacyStore.value).toBeNull()
  })

  it('does not delete the old entry until an already-bound Profile is readable', async () => {
    const boundId = '00000000-0000-4000-8000-000000000001'
    const config = loadLibraryConfig()
    config.llmSettings = {
      provider: 'anthropic',
      keyHint: '',
      model: 'fixture-model',
      baseUrl: '',
      [LEGACY_FIELD]: 'legacy-bound-9753'
    }
    config.preferences.llmProfiles = [{
      id: boundId,
      name: '已绑定',
      provider: 'anthropic',
      model: 'bound-model',
      keyHint: '…9753'
    }]
    config.preferences.smartFeatureBindings = { insights: boundId }
    saveLibraryConfig(config)
    const legacyStore = new MemoryLegacyStore()
    const profileStore = new MemoryProfileStore()

    await expect(migrateLegacyLlmProfile(legacyStore, profileStore))
      .rejects.toMatchObject({ code: 'KEYCHAIN_WRITE_FAILED' })
    expect(legacyStore.deleteCalls).toBe(0)
    expect(legacyStore.value).toBe('legacy-bound-9753')
    expect(loadLibraryConfig().llmSettings).toBeDefined()

    profileStore.values.set(boundId, 'bound-profile-value')
    await expect(migrateLegacyLlmProfile(legacyStore, profileStore)).resolves.toBe(true)
    expect(legacyStore.value).toBeNull()
    expect(loadLibraryConfig().llmSettings).toBeUndefined()
  })

  it('rejects dangling feature bindings instead of persisting broken references', async () => {
    const legacyStore = new MemoryLegacyStore()
    const profileStore = new MemoryProfileStore()
    await expect(setSmartFeatureBindings({
      smartRename: '00000000-0000-4000-8000-000000000001'
    }, profileStore, legacyStore)).rejects.toMatchObject({ code: 'PROFILE_NOT_FOUND' })
  })
})
