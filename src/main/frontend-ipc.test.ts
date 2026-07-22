import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from './types'
import {
  buildAgentHistory,
  copyPngToClipboard,
  getUserIdentity,
  registerFrontendIpc,
  savePng,
  setAlwaysOnTopPreference,
  setNativeShadowPreference,
  setUserIdentity
} from './frontend-ipc'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const tempDirs: string[] = []

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function summary(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    id: 'id', sessionId: 'session', slug: '', createdAt: '', updatedAt: '',
    messageCount: 0, turnCount: 0, compactCount: 0, cwds: [], version: '',
    firstUserMessage: '', toolUsage: {}, skillInvocations: [], projectPath: '',
    filePath: '', fileSizeBytes: 0, userImages: [], pastedImageCount: 0,
    tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    referencedFiles: [], configFiles: [],
    ...overrides
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('agent history and window preferences', () => {
  it('lists only sessions whose exact cwd is the agent workspace and sorts newest first', () => {
    const workspace = tempDir('swob-agent-workspace-')
    const items = buildAgentHistory([
      summary({ sessionId: 'old', cwds: [workspace], firstUserMessage: ' Old title ', updatedAt: '2026-01-01', turnCount: 2 }),
      summary({ sessionId: 'other', cwds: [`${workspace}-evil`], updatedAt: '2026-03-01' }),
      summary({ sessionId: 'new', resumeCwd: workspace, firstUserMessage: '', updatedAt: '2026-02-01', turnCount: 4 })
    ], workspace, (session) => session.sessionId === 'new' ? 'Pinned title' : undefined)

    expect(items).toEqual([
      { id: 'new', title: 'Pinned title', updatedAt: '2026-02-01', turnCount: 4 },
      { id: 'old', title: 'Old title', updatedAt: '2026-01-01', turnCount: 2 }
    ])
  })

  it('applies always-on-top live, persists it, and rolls the live state back on persistence failure', async () => {
    const win = { isDestroyed: () => false, setAlwaysOnTop: vi.fn() }
    const persist = vi.fn().mockRejectedValue(new Error('disk full'))
    const result = await setAlwaysOnTopPreference(false, {
      previousValue: true,
      getWindow: () => win,
      persist
    })

    expect(result).toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } })
    expect(win.setAlwaysOnTop.mock.calls).toEqual([[false], [true]])
  })

  it('toggles native shadow only on macOS and reports a closed window without changing the default', () => {
    const win = { isDestroyed: () => false, setHasShadow: vi.fn() }
    expect(setNativeShadowPreference(true, { platform: 'darwin', getWindow: () => win }))
      .toEqual({ ok: true, value: { nativeShadow: true, supported: true, applied: true } })
    expect(win.setHasShadow).toHaveBeenCalledWith(true)

    expect(setNativeShadowPreference(true, { platform: 'win32', getWindow: () => win }))
      .toEqual({ ok: true, value: { nativeShadow: true, supported: false, applied: false } })
    expect(setNativeShadowPreference(false, { platform: 'darwin', getWindow: () => null }))
      .toEqual({ ok: true, value: { nativeShadow: false, supported: true, applied: false } })
  })
})

describe('user identity', () => {
  function profileHarness() {
    const libraryRoot = tempDir('swob-profile-library-')
    let preferences: Record<string, unknown> = {}
    return {
      libraryRoot,
      getLibraryRoot: () => libraryRoot,
      getPreferences: () => preferences,
      updatePreferences: vi.fn(async (patch: Record<string, unknown>) => { preferences = { ...preferences, ...patch } })
    }
  }

  it('copies a valid avatar into Library/.swob/assets and persists only a relative path', async () => {
    const harness = profileHarness()
    const source = path.join(tempDir('swob-profile-source-'), 'face.png')
    fs.writeFileSync(source, PNG)

    const result = await setUserIdentity({ displayName: ' Ivy ', avatarRelPath: source }, harness)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.displayName).toBe('Ivy')
    expect(result.value.avatarRelPath).toMatch(/^\.swob\/assets\/avatar-[a-f0-9]{16}\.png$/)
    expect(path.isAbsolute(result.value.avatarRelPath!)).toBe(false)
    expect(fs.readFileSync(path.join(harness.libraryRoot, result.value.avatarRelPath!))).toEqual(PNG)
    expect(harness.updatePreferences).toHaveBeenCalledWith({
      userIdentity: { displayName: 'Ivy', avatarRelPath: result.value.avatarRelPath }
    })
  })

  it('rejects traversal, spoofed images, and files larger than 2 MiB', async () => {
    const harness = profileHarness()
    const outside = path.join(tempDir('swob-profile-outside-'), 'face.png')
    fs.writeFileSync(outside, PNG)
    expect(await setUserIdentity({ displayName: 'Ivy', avatarRelPath: '../face.png' }, harness))
      .toMatchObject({ ok: false, error: { code: 'INVALID_AVATAR_PATH' } })

    const spoofed = path.join(tempDir('swob-profile-spoof-'), 'face.png')
    fs.writeFileSync(spoofed, 'not png')
    expect(await setUserIdentity({ displayName: 'Ivy', avatarRelPath: spoofed }, harness))
      .toMatchObject({ ok: false, error: { code: 'INVALID_IMAGE_FORMAT' } })

    const huge = path.join(tempDir('swob-profile-huge-'), 'face.png')
    fs.writeFileSync(huge, Buffer.alloc(2 * 1024 * 1024 + 1))
    expect(await setUserIdentity({ displayName: 'Ivy', avatarRelPath: huge }, harness))
      .toMatchObject({ ok: false, error: { code: 'FILE_TOO_LARGE' } })
  })

  it('falls back to the default avatar contract when a persisted managed file is missing', async () => {
    const harness = profileHarness()
    harness.updatePreferences.mockImplementationOnce(async () => undefined)
    const result = await getUserIdentity({
      ...harness,
      getPreferences: () => ({ userIdentity: { displayName: 'Ivy', avatarRelPath: '.swob/assets/missing.png' } })
    })
    expect(result).toEqual({ ok: true, value: { displayName: 'Ivy', avatarAvailable: false } })
  })

  it('does not perpetuate a missing avatar when only the display name changes', async () => {
    const harness = profileHarness()
    const result = await setUserIdentity({ displayName: 'New name' }, {
      ...harness,
      getPreferences: () => ({ userIdentity: { displayName: 'Old', avatarRelPath: '.swob/assets/missing.png' } })
    })
    expect(result).toEqual({ ok: true, value: { displayName: 'New name', avatarAvailable: false } })
    expect(harness.updatePreferences).toHaveBeenCalledWith({ userIdentity: { displayName: 'New name' } })
  })

  it('rejects a managed asset directory that escapes Library through a symlink', async () => {
    const harness = profileHarness()
    const outside = tempDir('swob-profile-symlink-outside-')
    fs.symlinkSync(outside, path.join(harness.libraryRoot, '.swob'))
    const source = path.join(tempDir('swob-profile-symlink-source-'), 'face.png')
    fs.writeFileSync(source, PNG)

    expect(await setUserIdentity({ displayName: 'Ivy', avatarRelPath: source }, harness))
      .toMatchObject({ ok: false, error: { code: 'INVALID_AVATAR_PATH' } })
    expect(fs.readdirSync(outside)).toEqual([])
  })
})

describe('PNG sharing and registration', () => {
  it('saves a verified PNG through the dialog and sanitizes the suggested filename', async () => {
    const targetDir = tempDir('swob-share-')
    const writeFile = vi.fn(async () => undefined)
    const result = await savePng(PNG.toString('base64'), '../unsafe:name', {
      showSaveDialog: vi.fn(async (options) => {
        expect(options.defaultPath).toBe('unsafe-name.png')
        return { canceled: false, filePath: path.join(targetDir, 'chosen') }
      }),
      writeFile
    })
    expect(result).toEqual({ ok: true, value: { canceled: false, filePath: path.join(targetDir, 'chosen.png') } })
    expect(writeFile).toHaveBeenCalledWith(path.join(targetDir, 'chosen.png'), PNG, { mode: 0o600 })
  })

  it('rejects invalid image bytes and reports clipboard failures structurally', async () => {
    expect(await savePng(Buffer.from('hello').toString('base64'), 'x', {
      showSaveDialog: vi.fn(), writeFile: vi.fn()
    })).toMatchObject({ ok: false, error: { code: 'INVALID_IMAGE_FORMAT' } })

    expect(copyPngToClipboard(PNG.toString('base64'), {
      createImage: () => ({ isEmpty: () => false }),
      writeImage: () => { throw new Error('clipboard denied') }
    })).toMatchObject({ ok: false, error: { code: 'CLIPBOARD_FAILED' } })
  })

  it('registers all non-agent frontend IPC channels', () => {
    const channels: string[] = []
    registerFrontendIpc({
      ipcMain: { handle: (channel) => { channels.push(channel) } },
      profile: { getLibraryRoot: () => '/tmp', getPreferences: () => ({}), updatePreferences: vi.fn() },
      spotlight: { platform: 'darwin', getWindow: () => null, setPreference: vi.fn() },
      share: { showSaveDialog: vi.fn(), writeFile: vi.fn(), createImage: vi.fn(), writeImage: vi.fn() }
    })
    expect(channels).toEqual([
      'spotlight:setNativeShadow',
      'profile:getUserIdentity',
      'profile:setUserIdentity',
      'share:savePng',
      'share:copyPngToClipboard'
    ])
  })
})
