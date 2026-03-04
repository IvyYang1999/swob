import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import type { UserConfig, Folder } from './types'

const CONFIG_DIR = path.join(process.env.HOME || '', '.claude-session-manager')
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')

const DEFAULT_CONFIG: UserConfig = {
  folders: [],
  sessionMeta: {},
  preferences: {
    defaultViewMode: 'compact',
    terminalApp: 'Terminal'
  }
}

export function loadConfig(): UserConfig {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return { ...DEFAULT_CONFIG }
    const data = fs.readFileSync(CONFIG_FILE, 'utf-8')
    return { ...DEFAULT_CONFIG, ...JSON.parse(data) }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function saveConfig(config: UserConfig): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true })
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8')
}

export function createFolder(config: UserConfig, name: string, color?: string): UserConfig {
  const folder: Folder = {
    id: randomUUID(),
    name,
    sessionIds: [],
    color,
    createdAt: new Date().toISOString()
  }
  config.folders.push(folder)
  saveConfig(config)
  return config
}

export function deleteFolder(config: UserConfig, folderId: string): UserConfig {
  config.folders = config.folders.filter((f) => f.id !== folderId)
  saveConfig(config)
  return config
}

export function renameFolder(config: UserConfig, folderId: string, name: string): UserConfig {
  const folder = config.folders.find((f) => f.id === folderId)
  if (folder) folder.name = name
  saveConfig(config)
  return config
}

export function addSessionToFolder(
  config: UserConfig,
  folderId: string,
  sessionId: string
): UserConfig {
  const folder = config.folders.find((f) => f.id === folderId)
  if (folder && !folder.sessionIds.includes(sessionId)) {
    folder.sessionIds.push(sessionId)
    saveConfig(config)
  }
  return config
}

export function removeSessionFromFolder(
  config: UserConfig,
  folderId: string,
  sessionId: string
): UserConfig {
  const folder = config.folders.find((f) => f.id === folderId)
  if (folder) {
    folder.sessionIds = folder.sessionIds.filter((id) => id !== sessionId)
    saveConfig(config)
  }
  return config
}

export function setSessionMeta(
  config: UserConfig,
  sessionId: string,
  meta: { customTitle?: string; notes?: string }
): UserConfig {
  config.sessionMeta[sessionId] = {
    ...config.sessionMeta[sessionId],
    ...meta
  }
  saveConfig(config)
  return config
}
