import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  globalShortcut: { register: vi.fn() },
  ipcMain: { handle: vi.fn() },
  screen: {
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 800 } })
  }
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))

import { registerAgentIpc, shutdownAgentRuntime } from './agent-window'

type Handler = (event?: unknown, ...args: any[]) => any

function harness(overrides: Record<string, unknown> = {}) {
  const handlers = new Map<string, Handler>()
  let alwaysOnTop = true
  const persistAlwaysOnTop = vi.fn(async (flag: boolean) => { alwaysOnTop = flag })
  registerAgentIpc({
    getLibraryRoot: () => null,
    archiveAgentSession: vi.fn(),
    showMainWindow: vi.fn(),
    listAgentHistory: async () => [{ id: 'agent-1', title: 'First', updatedAt: '2026-07-22', turnCount: 3 }],
    getAgentAlwaysOnTop: () => alwaysOnTop,
    persistAgentAlwaysOnTop: persistAlwaysOnTop,
    getEngineStatus: async () => ({ available: true, binaryPath: '/bin/claude' }),
    ipcMain: { handle: (channel, handler) => { handlers.set(channel, handler) } },
    ...overrides
  })
  return { handlers, persistAlwaysOnTop }
}

beforeEach(async () => {
  await shutdownAgentRuntime()
})

describe('agent companion IPC', () => {
  it('lists assistant history and switches the current resumable session', async () => {
    const { handlers } = harness()
    expect(await handlers.get('agent:listHistory')?.()).toEqual({
      ok: true,
      value: [{ id: 'agent-1', title: 'First', updatedAt: '2026-07-22', turnCount: 3 }]
    })
    expect(await handlers.get('agent:resumeSession')?.(undefined, 'agent-1')).toEqual({
      ok: true,
      value: {
        id: 'agent-1', title: 'First', updatedAt: '2026-07-22', turnCount: 3,
        canResume: true
      }
    })
    expect(await handlers.get('agent:getStatus')?.()).toMatchObject({ sessionId: 'agent-1', busy: false })
  })

  it('rejects an unknown session without mutating the current session', async () => {
    const { handlers } = harness()
    expect(await handlers.get('agent:resumeSession')?.(undefined, 'missing'))
      .toMatchObject({ ok: false, error: { code: 'SESSION_NOT_FOUND' } })
    expect(await handlers.get('agent:getStatus')?.()).toMatchObject({ sessionId: null })
  })

  it('refuses to switch sessions while a turn is running', async () => {
    let finish!: () => void
    const done = new Promise<void>((resolve) => { finish = resolve })
    const { handlers } = harness({
      runTurn: vi.fn(async () => ({ cancel: vi.fn(), shutdown: vi.fn(), done }))
    })
    expect(await handlers.get('agent:send')?.(undefined, 'hello')).toEqual({ ok: true })
    expect(await handlers.get('agent:resumeSession')?.(undefined, 'agent-1'))
      .toMatchObject({ ok: false, error: { code: 'BUSY' } })
    finish()
    await done
  })

  it('reads and persists the always-on-top preference', async () => {
    const { handlers, persistAlwaysOnTop } = harness()
    expect(await handlers.get('agent:getAlwaysOnTop')?.()).toEqual({
      ok: true, value: { alwaysOnTop: true, windowOpen: false }
    })
    expect(await handlers.get('agent:setAlwaysOnTop')?.(undefined, false)).toEqual({
      ok: true, value: { alwaysOnTop: false, windowOpen: false }
    })
    expect(persistAlwaysOnTop).toHaveBeenCalledWith(false)
  })
})
