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
  async get(): Promise<string | null> { return this.value }
  async set(value: string): Promise<void> { this.value = value }
}

class MemoryProfileStore implements ProfileSecretStore {
  values = new Map<string, string>()
  deleted: string[] = []
  async get(profileId: string): Promise<string | null> { return this.values.get(profileId) || null }
  async set(profileId: string, value: string): Promise<void> { this.values.set(profileId, value) }
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
    expect(fs.readFileSync(path.join(root, '.swob-config.json'), 'utf8'))
      .not.toContain('legacy-example-9876')
  })

  it('rejects dangling feature bindings instead of persisting broken references', async () => {
    const legacyStore = new MemoryLegacyStore()
    const profileStore = new MemoryProfileStore()
    await expect(setSmartFeatureBindings({
      smartRename: '00000000-0000-4000-8000-000000000001'
    }, profileStore, legacyStore)).rejects.toMatchObject({ code: 'PROFILE_NOT_FOUND' })
  })
})
