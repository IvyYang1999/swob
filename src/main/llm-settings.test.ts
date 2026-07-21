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
  getLlmSettingsForDisplay,
  getLlmSettingsWithSecret,
  migrateLegacyLlmCredential,
  setLlmSettings
} from './llm-settings'
import type { ProfileSecretStore, SecretStore } from './llm-secret-store'

class MemoryStore implements SecretStore {
  stored: string | null = null
  failVerification = false

  async get(): Promise<string | null> {
    return this.failVerification ? 'different' : this.stored
  }

  async set(value: string): Promise<void> {
    this.stored = value
  }
}

class MemoryProfileStore implements ProfileSecretStore {
  stored = new Map<string, string>()

  async get(profileId: string): Promise<string | null> {
    return this.stored.get(profileId) || null
  }

  async set(profileId: string, value: string): Promise<void> {
    this.stored.set(profileId, value)
  }

  async delete(profileId: string): Promise<void> {
    this.stored.delete(profileId)
  }
}

const LEGACY_FIELD = ['api', 'Key'].join('')
let root = ''

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-llm-settings-'))
  initLibrary(root)
  invalidateLibraryConfigCache()
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function writeLegacy(value: string): void {
  const config = loadLibraryConfig()
  config.llmSettings = {
    provider: 'anthropic',
    keyHint: '',
    [LEGACY_FIELD]: value,
    model: 'fixture-model',
    baseUrl: ''
  }
  saveLibraryConfig(config)
}

describe('LLM Keychain settings', () => {
  it('migrates plaintext only after a verified store write', async () => {
    writeLegacy('legacy-example-1234')
    const store = new MemoryStore()

    await expect(migrateLegacyLlmCredential(store)).resolves.toBe(true)
    const configPath = path.join(root, '.swob-config.json')
    const disk = fs.readFileSync(configPath, 'utf-8')
    expect(disk).not.toContain('legacy-example-1234')
    expect(JSON.parse(disk).llmSettings).toEqual({
      provider: 'anthropic', keyHint: '…1234', model: 'fixture-model', baseUrl: ''
    })
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600)
  })

  it('keeps plaintext untouched if store verification fails', async () => {
    writeLegacy('legacy-example-5678')
    const store = new MemoryStore()
    store.failVerification = true

    await expect(migrateLegacyLlmCredential(store)).rejects.toThrow(/verification/)
    expect(fs.readFileSync(path.join(root, '.swob-config.json'), 'utf-8'))
      .toContain('legacy-example-5678')
  })

  it('stores only metadata in Library and resolves the value at use time', async () => {
    const store = new MemoryStore()
    const profileStore = new MemoryProfileStore()
    await setLlmSettings({
      provider: 'custom',
      value: 'runtime-example-abcd',
      model: 'fixture-model',
      baseUrl: 'https://example.test'
    }, store, profileStore)

    expect(await getLlmSettingsForDisplay(store, profileStore)).toEqual({
      provider: 'custom',
      hasKey: true,
      keyHint: '…abcd',
      model: 'fixture-model',
      baseUrl: 'https://example.test'
    })
    expect(await getLlmSettingsWithSecret(store, profileStore)).toMatchObject({
      provider: 'custom',
      credential: 'runtime-example-abcd',
      model: 'fixture-model',
      baseUrl: 'https://example.test'
    })
    expect(JSON.stringify(loadLibraryConfig())).not.toContain('runtime-example-abcd')
    expect(loadLibraryConfig().llmSettings).toBeUndefined()
    expect(loadLibraryConfig().preferences.llmProfiles).toHaveLength(1)
  })
})
