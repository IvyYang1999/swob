import { BrowserWindow, globalShortcut, ipcMain, screen } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import {
  getAgentEngineStatus,
  runAgentTurn,
  type AgentEngineStatus,
  type AgentStreamEvent,
  type RunningTurn
} from './agent-runner'
import { setAlwaysOnTopPreference } from './frontend-ipc'
import type {
  AgentHistoryItem,
  AgentResumeState,
  FrontendIpcErrorCode,
  FrontendIpcResult
} from '../shared/frontend-ipc-contract'

/**
 * Floating global agent window (t111 MVP). Frameless, bottom-right,
 * toggled by ⌘⇧A or the main-window toolbar button.
 */

let agentWindow: BrowserWindow | null = null
let currentTurn: RunningTurn | null = null
let agentSessionId: string | null = null
let registeredOptions: AgentIpcOptions | null = null

const WIDTH = 360
const HEIGHT = 540

function configuredAlwaysOnTop(): boolean {
  try { return registeredOptions?.getAgentAlwaysOnTop() ?? true } catch { return true }
}

function createAgentWindow(): BrowserWindow {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const { x, y, width, height } = display.workArea

  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    x: x + width - WIDTH - 24,
    y: y + height - HEIGHT - 24,
    frame: false,
    resizable: true,
    movable: true,
    alwaysOnTop: configuredAlwaysOnTop(),
    skipTaskbar: true,
    show: false,
    minWidth: 300,
    minHeight: 380,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  win.on('closed', () => { agentWindow = null })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'] + '#agent')
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'agent' })
  }
  return win
}

export function toggleAgentWindow(): void {
  if (agentWindow && !agentWindow.isDestroyed()) {
    if (agentWindow.isVisible() && agentWindow.isFocused()) {
      agentWindow.hide()
    } else {
      agentWindow.show()
      agentWindow.focus()
    }
    return
  }
  agentWindow = createAgentWindow()
  agentWindow.once('ready-to-show', () => agentWindow?.show())
}

function emitToAgentWindow(event: AgentStreamEvent): void {
  if (agentWindow && !agentWindow.isDestroyed()) {
    agentWindow.webContents.send('agent:event', event)
  }
}

interface IpcHandleRegistrar {
  handle(channel: string, handler: (event: unknown, ...args: any[]) => unknown): void
}

export interface AgentIpcOptions {
  getLibraryRoot: () => string | null
  archiveAgentSession: (sessionId: string) => void
  showMainWindow: () => void
  listAgentHistory: () => AgentHistoryItem[] | Promise<AgentHistoryItem[]>
  getAgentAlwaysOnTop: () => boolean
  persistAgentAlwaysOnTop: (flag: boolean) => void | Promise<void>
  ipcMain?: IpcHandleRegistrar
  getEngineStatus?: () => Promise<AgentEngineStatus>
  runTurn?: typeof runAgentTurn
}

function agentFailure<T>(code: FrontendIpcErrorCode, message: string): FrontendIpcResult<T> {
  return { ok: false, error: { code, message } }
}

export function registerAgentIpc(options: AgentIpcOptions): void {
  registeredOptions = options
  const ipc = options.ipcMain || ipcMain
  const engineStatus = options.getEngineStatus || getAgentEngineStatus
  const startTurn = options.runTurn || runAgentTurn

  ipc.handle('agent:openHistory', () => {
    agentWindow?.hide()
    options.showMainWindow()
    return true
  })

  ipc.handle('agent:getStatus', async () => {
    const status = await engineStatus()
    return { ...status, sessionId: agentSessionId, busy: currentTurn !== null }
  })

  ipc.handle('agent:listHistory', async (): Promise<FrontendIpcResult<AgentHistoryItem[]>> => {
    try {
      return { ok: true, value: await options.listAgentHistory() }
    } catch (error) {
      return agentFailure('OPERATION_FAILED', error instanceof Error ? error.message : 'Failed to list agent history')
    }
  })

  ipc.handle('agent:resumeSession', async (_event, sessionId: unknown): Promise<FrontendIpcResult<AgentResumeState>> => {
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      return agentFailure('INVALID_INPUT', 'sessionId must be a non-empty string')
    }
    if (currentTurn) return agentFailure('BUSY', 'Cannot switch sessions while a turn is running')
    try {
      const item = (await options.listAgentHistory()).find((candidate) => candidate.id === sessionId)
      if (!item) return agentFailure('SESSION_NOT_FOUND', 'Agent session was not found')
      const status = await engineStatus()
      agentSessionId = item.id
      return {
        ok: true,
        value: {
          ...item,
          canResume: status.available,
          ...(status.available ? {} : { reason: status.reason || 'Agent engine is unavailable' })
        }
      }
    } catch (error) {
      return agentFailure('OPERATION_FAILED', error instanceof Error ? error.message : 'Failed to resume agent session')
    }
  })

  ipc.handle('agent:getAlwaysOnTop', (): FrontendIpcResult<{
    alwaysOnTop: boolean
    windowOpen: boolean
  }> => {
    try {
      return {
        ok: true,
        value: {
          alwaysOnTop: options.getAgentAlwaysOnTop(),
          windowOpen: Boolean(agentWindow && !agentWindow.isDestroyed())
        }
      }
    } catch (error) {
      return agentFailure('OPERATION_FAILED', error instanceof Error ? error.message : 'Failed to read window preference')
    }
  })

  ipc.handle('agent:setAlwaysOnTop', (_event, flag: unknown) => {
    try {
      return setAlwaysOnTopPreference(flag, {
        previousValue: options.getAgentAlwaysOnTop(),
        getWindow: () => agentWindow,
        persist: options.persistAgentAlwaysOnTop
      })
    } catch (error) {
      return agentFailure('OPERATION_FAILED', error instanceof Error ? error.message : 'Failed to update window preference')
    }
  })

  ipc.handle('agent:toggleWindow', () => { toggleAgentWindow() })

  ipc.handle('agent:newConversation', () => {
    agentSessionId = null
    return true
  })

  ipc.handle('agent:send', async (_event, prompt: string) => {
    if (typeof prompt !== 'string' || !prompt.trim()) return { ok: false, error: '空消息' }
    if (currentTurn) return { ok: false, error: '上一轮还在进行中' }

    const turn = await startTurn({
      prompt: prompt.trim().slice(0, 8000),
      resumeSessionId: agentSessionId || undefined,
      libraryRoot: options.getLibraryRoot(),
      onEvent: (event) => {
        if (event.type === 'init') {
          const isNewSession = agentSessionId !== event.sessionId
          agentSessionId = event.sessionId
          if (isNewSession) options.archiveAgentSession(event.sessionId)
        }
        emitToAgentWindow(event)
      }
    })
    if ('error' in turn) return { ok: false, error: turn.error }

    currentTurn = turn
    void turn.done.finally(() => { currentTurn = null })
    return { ok: true }
  })

  ipc.handle('agent:cancel', () => {
    currentTurn?.cancel()
    return true
  })

  ipc.handle('agent:hideWindow', () => {
    agentWindow?.hide()
    return true
  })
}

export function registerAgentShortcut(): void {
  try {
    globalShortcut.register('CommandOrControl+Shift+A', () => toggleAgentWindow())
  } catch {
    console.warn('[agent] failed to register global shortcut')
  }
}

export async function shutdownAgentRuntime(): Promise<void> {
  const turn = currentTurn
  currentTurn = null
  if (turn) await turn.shutdown()
  if (agentWindow && !agentWindow.isDestroyed()) agentWindow.destroy()
  agentWindow = null
  agentSessionId = null
}
