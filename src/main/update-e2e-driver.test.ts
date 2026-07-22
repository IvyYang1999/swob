import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startPackagedUpdateE2E, UPDATE_E2E_STATE_FILE } from './update-e2e-driver'

type Listener = (...args: any[]) => void
const temporaryDirectories: string[] = []

function temporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

function createHarness(version = '1.3.0') {
  const listeners = new Map<string, Listener>()
  const userData = temporaryDirectory('swob-update-e2e-user-')
  const resultDir = temporaryDirectory('swob-update-e2e-result-')
  const app = {
    isPackaged: true,
    getVersion: vi.fn(() => version),
    getPath: vi.fn(() => userData),
    quit: vi.fn()
  }
  const updater = {
    channel: null as string | null,
    allowDowngrade: true,
    on: vi.fn((event: string, listener: Listener) => {
      listeners.set(event, listener)
      return updater
    }),
    checkForUpdates: vi.fn().mockResolvedValue(null),
    downloadUpdate: vi.fn().mockResolvedValue([]),
    quitAndInstall: vi.fn()
  }
  return {
    app,
    updater,
    userData,
    resultFile: path.join(resultDir, 'result.json'),
    emit: (event: string, ...args: any[]) => listeners.get(event)?.(...args)
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('packaged update E2E driver', () => {
  it('uses only the canary channel and drives check, download and install', async () => {
    const harness = createHarness()
    const handled = startPackagedUpdateE2E({
      app: harness.app,
      updater: harness.updater as any,
      env: {
        SWOB_UPDATE_E2E: '1',
        SWOB_UPDATE_E2E_TARGET_VERSION: '1.3.1',
        SWOB_UPDATE_E2E_CHANNEL: 'swob-canary',
        SWOB_UPDATE_E2E_RESULT_FILE: harness.resultFile
      },
      now: () => new Date('2026-07-22T00:00:00.000Z')
    })

    expect(handled).toBe(true)
    expect(harness.updater.channel).toBe('swob-canary')
    expect(harness.updater.allowDowngrade).toBe(false)
    expect(harness.updater.checkForUpdates).toHaveBeenCalledTimes(1)

    harness.emit('update-available', { version: '1.3.1' })
    await vi.waitFor(() => expect(harness.updater.downloadUpdate).toHaveBeenCalledTimes(1))
    harness.emit('update-downloaded', { version: '1.3.1' })

    expect(harness.updater.quitAndInstall).toHaveBeenCalledTimes(1)
    const state = JSON.parse(fs.readFileSync(path.join(harness.userData, UPDATE_E2E_STATE_FILE), 'utf8'))
    expect(state.phase).toBe('installing')
    harness.emit('error', new Error('late native updater event'))
    expect(fs.existsSync(harness.resultFile)).toBe(false)
  })

  it('writes a pass result only after the relaunched app reports the target version', () => {
    const harness = createHarness('1.3.1')
    fs.writeFileSync(path.join(harness.userData, UPDATE_E2E_STATE_FILE), JSON.stringify({
      createdAt: '2026-07-22T00:00:00.000Z',
      phase: 'installing',
      fromVersion: '1.3.0',
      targetVersion: '1.3.1',
      resultFile: harness.resultFile
    }))

    const handled = startPackagedUpdateE2E({
      app: harness.app,
      updater: harness.updater as any,
      env: {},
      now: () => new Date('2026-07-22T00:01:00.000Z')
    })

    expect(handled).toBe(true)
    expect(harness.app.quit).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fs.readFileSync(harness.resultFile, 'utf8'))).toMatchObject({
      result: 'passed',
      fromVersion: '1.3.0',
      targetVersion: '1.3.1',
      installedVersion: '1.3.1'
    })
    expect(fs.existsSync(path.join(harness.userData, UPDATE_E2E_STATE_FILE))).toBe(false)
  })

  it('fails closed when the feed offers a different version', () => {
    const harness = createHarness()
    startPackagedUpdateE2E({
      app: harness.app,
      updater: harness.updater as any,
      env: {
        SWOB_UPDATE_E2E: '1',
        SWOB_UPDATE_E2E_TARGET_VERSION: '1.3.1',
        SWOB_UPDATE_E2E_CHANNEL: 'swob-canary',
        SWOB_UPDATE_E2E_RESULT_FILE: harness.resultFile
      }
    })

    harness.emit('update-available', { version: '1.3.2' })
    const result = JSON.parse(fs.readFileSync(harness.resultFile, 'utf8'))
    expect(result.result).toBe('failed')
    expect(result.error).toContain('feed offered 1.3.2')
    expect(harness.updater.downloadUpdate).not.toHaveBeenCalled()
    expect(harness.app.quit).toHaveBeenCalledTimes(1)
  })

  it('does nothing in development or with an arbitrary channel/result path', () => {
    const harness = createHarness()
    harness.app.isPackaged = false
    expect(startPackagedUpdateE2E({
      app: harness.app,
      updater: harness.updater as any,
      env: { SWOB_UPDATE_E2E: '1' }
    })).toBe(false)

    harness.app.isPackaged = true
    expect(startPackagedUpdateE2E({
      app: harness.app,
      updater: harness.updater as any,
      env: {
        SWOB_UPDATE_E2E: '1',
        SWOB_UPDATE_E2E_TARGET_VERSION: '1.3.1',
        SWOB_UPDATE_E2E_CHANNEL: 'attacker-channel',
        SWOB_UPDATE_E2E_RESULT_FILE: '/etc/swob-result.json'
      }
    })).toBe(false)
    expect(harness.updater.checkForUpdates).not.toHaveBeenCalled()
  })
})
