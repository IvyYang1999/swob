/**
 * Where each source keeps its data (documented tool layouts), used to decide
 * "no data on this machine" (not applicable) versus "present but not checked".
 * Presence is metadata only: no file content is read here.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { SourceId } from '../contract'
import { isDirectory } from './files'

/** Fixed roots per source; `*` stands for one directory level. */
export const SOURCE_ROOTS: Readonly<Record<SourceId, readonly string[]>> = {
  'claude-code': ['~/.claude/projects', '~/.claude-window/*/projects'],
  codex: ['~/.codex/sessions', '~/.codex/archived_sessions'],
  cursor: ['~/.cursor/projects'],
  opencode: ['~/.local/share/opencode'],
  zcode: ['~/.zcode/cli/db'],
  'cc-mirror': ['~/.cc-mirror/*/projects'],
  antigravity: ['~/.gemini/antigravity', '~/.gemini/antigravity-cli', '~/.gemini/antigravity-ide'],
  grok: ['~/.grok/sessions', '~/.factory/sessions'],
  pi: ['~/.pi/agent/sessions'],
  kimi: ['~/.kimi-code/sessions'],
  hermes: ['~/.hermes/sessions'],
  qoder: ['~/.qoder/projects', '~/.qoderwork/projects'],
  trae: [
    '~/Library/Application Support/Trae/User',
    '~/Library/Application Support/Trae CN/User',
    '~/Library/Application Support/TRAE SOLO CN/User'
  ],
  gemini: ['~/.gemini/tmp']
}

/** Data files that must exist inside a root for the source to count as present. */
const REQUIRED_FILES: Partial<Record<SourceId, string>> = {
  opencode: 'opencode.db',
  zcode: 'db.sqlite'
}

export interface SourcePresence {
  source: SourceId
  roots: Array<{ fixedRoot: string; present: boolean }>
  present: boolean
}

function expandRoot(homeDir: string, fixedRoot: string): string[] {
  const segments = fixedRoot.replace(/^~\//, '').split('/')
  let current = [homeDir]
  for (const segment of segments) {
    if (segment !== '*') {
      current = current.map((dir) => path.join(dir, segment))
      continue
    }
    const next: string[] = []
    for (const dir of current) {
      let entries: fs.Dirent[] = []
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { entries = [] }
      for (const entry of entries) if (entry.isDirectory()) next.push(path.join(dir, entry.name))
    }
    current = next
  }
  return current
}

export function probeSourcePresence(homeDir: string): SourcePresence[] {
  return (Object.keys(SOURCE_ROOTS) as SourceId[]).map((source) => {
    const required = REQUIRED_FILES[source]
    const roots = SOURCE_ROOTS[source].map((fixedRoot) => ({
      fixedRoot,
      present: expandRoot(homeDir, fixedRoot).some((dir) => isDirectory(dir) &&
        (!required || fs.existsSync(path.join(dir, required))))
    }))
    return { source, roots, present: roots.some((root) => root.present) }
  })
}

/** Absolute source directories to check for SQLite sidecar side effects (main db path per source). */
export function sqliteSourceFiles(homeDir: string): Array<{ source: SourceId; file: string }> {
  return [
    { source: 'opencode' as const, file: path.join(homeDir, '.local', 'share', 'opencode', 'opencode.db') },
    { source: 'zcode' as const, file: path.join(homeDir, '.zcode', 'cli', 'db', 'db.sqlite') }
  ]
}
