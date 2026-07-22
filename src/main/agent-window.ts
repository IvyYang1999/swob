import { BrowserWindow, globalShortcut, ipcMain, screen } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import {
  getAgentEngineStatus,
  runAgentTurn,
  type AgentStreamEvent,
  type RunningTurn
} from './agent-runner'

/**
 * Floating global agent window (t111 MVP). Frameless, bottom-right,
 * toggled by ⌘⇧A or the main-window toolbar button.
 */

let agentWindow: BrowserWindow | null = null
let currentTurn: RunningTurn | null = null
let agentSessionId: string | null = null

const WIDTH = 360
const HEIGHT = 540

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
    alwaysOnTop: true,
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

export function registerAgentIpc(options: {
  getLibraryRoot: () => string | null
  archiveAgentSession: (sessionId: string) => void
  showMainWindow: () => void
}): void {
  ipcMain.handle('agent:openHistory', () => {
    agentWindow?.hide()
    options.showMainWindow()
    return true
  })

  ipcMain.handle('agent:getStatus', async () => {
    const status = await getAgentEngineStatus()
    return { ...status, sessionId: agentSessionId, busy: currentTurn !== null }
  })

  ipcMain.handle('agent:toggleWindow', () => { toggleAgentWindow() })

  ipcMain.handle('agent:newConversation', () => {
    agentSessionId = null
    return true
  })

  ipcMain.handle('agent:send', async (_event, prompt: string) => {
    if (typeof prompt !== 'string' || !prompt.trim()) return { ok: false, error: '空消息' }
    if (currentTurn) return { ok: false, error: '上一轮还在进行中' }

    const turn = await runAgentTurn({
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

  ipcMain.handle('agent:cancel', () => {
    currentTurn?.cancel()
    return true
  })

  ipcMain.handle('agent:hideWindow', () => {
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
}
