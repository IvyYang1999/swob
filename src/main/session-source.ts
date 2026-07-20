import * as fs from 'fs'
import * as path from 'path'
import type { SessionSource } from './types'

export function detectSessionSourceFromPath(filePath?: string): SessionSource | null {
  if (!filePath) return null
  const normalized = filePath.split(path.sep).join('/')
  if (normalized.includes('/.codex/sessions/')) return 'codex'
  if (normalized.includes('/.cursor/projects/')) return 'cursor'
  if (normalized.includes('/.local/share/opencode/opencode.db')) return 'opencode'
  if (normalized.includes('/.zcode/')) return 'zcode'
  if (normalized.includes('/.cc-mirror/')) return 'cc-mirror'
  if (normalized.includes('/.gemini/antigravity')) return 'antigravity'
  if (normalized.includes('/.grok/sessions/') || normalized.includes('/.factory/sessions/')) return 'grok'
  if (normalized.includes('/.pi/agent/sessions/')) return 'pi'
  if (normalized.includes('/.kimi-code/sessions/')) return 'kimi'
  if (normalized.includes('/.hermes/sessions/')) return 'hermes'
  if (normalized.includes('/.claude/projects/') || normalized.includes('/.claude-window/')) return 'claude-code'
  return null
}

function readFirstJsonlObject(filePath: string): Record<string, unknown> | null {
  let fd: number | null = null
  try {
    fd = fs.openSync(filePath, 'r')
    const buffer = Buffer.alloc(8192)
    let pending = ''
    let position = 0

    while (position < 1024 * 1024) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position)
      if (bytesRead === 0) break
      position += bytesRead
      pending += buffer.toString('utf-8', 0, bytesRead)
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() || ''
      for (const line of lines) {
        if (!line.trim()) continue
        return JSON.parse(line)
      }
    }

    if (pending.trim()) return JSON.parse(pending)
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd) } catch { /* ignore */ }
    }
  }
  return null
}

export function sniffSessionSourceFromJsonl(filePath: string): SessionSource | null {
  const first = readFirstJsonlObject(filePath)
  if (!first) return null
  if (Object.prototype.hasOwnProperty.call(first, 'payload')) return 'codex'
  if (
    Object.prototype.hasOwnProperty.call(first, 'role') &&
    Object.prototype.hasOwnProperty.call(first, 'message') &&
    !Object.prototype.hasOwnProperty.call(first, 'type')
  ) return 'cursor'
  return 'claude-code'
}

type DetectSessionSourceOptions = {
  preferSourcePaths?: boolean
}

function detectFirstSourcePath(sourceFilePaths: string[]): SessionSource | null {
  for (const sourceFilePath of sourceFilePaths) {
    const source = detectSessionSourceFromPath(sourceFilePath)
    if (source) return source
  }
  return null
}

/**
 * Detect a JSONL transcript source with an explicit caller contract.
 *
 * Transcript generation keeps historical behavior: trust meta.sourceFilePaths[0]
 * before looking at the local backup file. Backup/detail loading should keep the
 * default content-first behavior because backup.jsonl paths carry no source hint.
 */
export function detectSessionSourceForJsonl(
  filePath: string,
  sourceFilePaths: string[] = [],
  options: DetectSessionSourceOptions = {}
): SessionSource {
  if (options.preferSourcePaths) {
    return detectSessionSourceFromPath(sourceFilePaths[0]) ||
      detectSessionSourceFromPath(filePath) ||
      sniffSessionSourceFromJsonl(filePath) ||
      'claude-code'
  }

  return detectSessionSourceFromPath(filePath) ||
    sniffSessionSourceFromJsonl(filePath) ||
    detectFirstSourcePath(sourceFilePaths) ||
    'claude-code'
}
