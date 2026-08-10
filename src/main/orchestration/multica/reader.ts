import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { deduplicateTranscriptSources, discoverMulticaRoots, identifyTranscriptSource, type MulticaDiscoveryOptions } from './discovery'
import { parseMulticaWorkspaceBytes } from './parser'
import type { JsonValue } from '../../../shared/provider-schema-v2.generated'
import type { MulticaMetadataCheckpoint, MulticaMetadataSnapshot, MulticaReadResult, MulticaRootCandidate, MulticaTranscriptSource } from './types'

const SUPPORTED_SCHEMA_VERSIONS = new Set(['0.4', '1'])
const ORCHESTRATION_EXPORTS = ['multica-orchestration.json', '.multica/orchestration.json']
const MARKERS: Array<[string, MulticaMetadataSnapshot['kind']]> = [
  ['.gc_meta.json', 'gc-meta'],
  ['.managed_env.json', 'managed-env'],
  ['workdir/.multica/daemon_task_context.json', 'daemon-task-context']
]

export interface MulticaReadOptions extends MulticaDiscoveryOptions { maxSourceBytes?: number }

export function mergeMulticaMetadataCheckpoint(previous: MulticaMetadataCheckpoint | undefined, current: MulticaMetadataSnapshot[], capturedAt: string): MulticaMetadataCheckpoint {
  const byPath = new Map((previous?.snapshots || []).map((entry) => [entry.sourcePath, entry]))
  for (const entry of current) byPath.set(entry.sourcePath, entry)
  return { schemaVersion: 1, capturedAt, snapshots: [...byPath.values()].sort((a, b) => a.sourcePath.localeCompare(b.sourcePath)) }
}

function safeEntries(directory: string): fs.Dirent[] {
  try { return fs.readdirSync(directory, { withFileTypes: true }) } catch { return [] }
}

function profileRoots(options: MulticaReadOptions): NonNullable<MulticaDiscoveryOptions['profileRoots']> {
  if (options.platform === 'win32') return options.profileRoots || []
  const discovered = safeEntries(options.homeDir)
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('multica_workspaces_'))
    .map((entry) => {
      const profile = entry.name.slice('multica_workspaces_'.length)
      return { profile, path: path.join(options.homeDir, entry.name), desktop: profile.startsWith('desktop-') }
    })
  return [...(options.profileRoots || []), ...discovered]
}

function contained(candidate: string, roots: string[]): boolean {
  return roots.some((root) => candidate === root || candidate.startsWith(`${root}${path.sep}`))
}

function readBytes(filePath: string, maxBytes: number): Uint8Array | null {
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile() || stat.size > maxBytes) return null
    return fs.readFileSync(filePath)
  } catch { return null }
}

function capturedAt(filePath: string): string {
  try { return fs.statSync(filePath).mtime.toISOString() } catch { return new Date(0).toISOString() }
}

function jsonValue(bytes: Uint8Array): JsonValue | null {
  try { return JSON.parse(new TextDecoder().decode(bytes)) as JsonValue } catch { return null }
}

function snapshot(filePath: string, kind: MulticaMetadataSnapshot['kind'], maxBytes: number): MulticaMetadataSnapshot | null {
  const bytes = readBytes(filePath, maxBytes)
  if (!bytes) return null
  const value = jsonValue(bytes)
  if (value === null || typeof value !== 'object') return null
  return { sourcePath: filePath, kind, sha256: createHash('sha256').update(bytes).digest('hex'), capturedAt: capturedAt(filePath), byteLength: bytes.byteLength, value }
}

function rolloutFiles(sessionRoot: string): string[] {
  const found: string[] = []
  const visit = (directory: string): void => {
    for (const entry of safeEntries(directory)) {
      const child = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(child)
      else if ((entry.isFile() || entry.isSymbolicLink()) && /^rollout-.*\.jsonl$/i.test(entry.name)) found.push(child)
    }
  }
  visit(sessionRoot)
  return found
}

function sessionIdFrom(bytes: Uint8Array, filePath: string): string | undefined {
  const prefix = new TextDecoder().decode(bytes.slice(0, Math.min(bytes.byteLength, 128 * 1024)))
  return prefix.match(/"(?:session_id|sessionId|id)"\s*:\s*"([0-9a-f-]{16,})"/i)?.[1]
    || path.basename(filePath).match(/([0-9a-f]{8}-[0-9a-f-]{20,})/i)?.[1]
}

function transcript(filePath: string, allowedRealRoots: string[], maxBytes: number, diagnostics: string[]): MulticaTranscriptSource | null {
  try {
    const realPath = fs.realpathSync.native(filePath)
    if (!contained(realPath, allowedRealRoots)) {
      diagnostics.push(`Skipped transcript alias outside allowed roots: ${filePath}`)
      return null
    }
    const bytes = readBytes(realPath, maxBytes)
    if (!bytes) {
      diagnostics.push(`Skipped unreadable or oversized transcript: ${filePath}`)
      return null
    }
    const stat = fs.statSync(realPath)
    return identifyTranscriptSource({ locator: filePath, realPath, device: stat.dev, fileId: stat.ino, logicalSessionId: sessionIdFrom(bytes, filePath), bytes })
  } catch {
    diagnostics.push(`Skipped unreadable transcript: ${filePath}`)
    return null
  }
}

function workspaceTaskRoots(root: MulticaRootCandidate): string[] {
  if (root.kind === 'session-container') return []
  return safeEntries(root.path).filter((entry) => entry.isDirectory()).flatMap((workspace) => {
    const workspacePath = path.join(root.path, workspace.name)
    return safeEntries(workspacePath).filter((entry) => entry.isDirectory()).map((entry) => path.join(workspacePath, entry.name))
  })
}

/** Native read-only adapter: fixed workspace/task levels only; never scans workdir, artifacts, node_modules, or config. */
export function readMulticaWorkspace(options: MulticaReadOptions): MulticaReadResult {
  const diagnostics: string[] = []
  const maxBytes = options.maxSourceBytes || 64 * 1024 * 1024
  const roots = discoverMulticaRoots({ ...options, profileRoots: profileRoots(options) })
  const readableRoots = roots.filter((root) => root.exists && root.readable)
  const allowedRealRoots = readableRoots.flatMap((root) => {
    try { return [fs.realpathSync.native(root.path)] } catch { return [] }
  })
  const taskRoots = readableRoots.flatMap(workspaceTaskRoots)
  const metadataSnapshots: MulticaMetadataSnapshot[] = []
  const parsed: MulticaReadResult['parsed'] = { entities: [], usages: [], diagnostics: [] }

  for (const taskRoot of taskRoots) {
    for (const [relative, kind] of MARKERS) {
      const item = snapshot(path.join(taskRoot, relative), kind, maxBytes)
      if (item) metadataSnapshots.push(item)
    }
    for (const relative of ORCHESTRATION_EXPORTS) {
      const filePath = path.join(taskRoot, relative)
      const item = snapshot(filePath, 'orchestration-export', maxBytes)
      if (!item) continue
      metadataSnapshots.push(item)
      const next = parseMulticaWorkspaceBytes(readBytes(filePath, maxBytes)!, filePath, item.capturedAt)
      parsed.schemaVersion ||= next.schemaVersion
      parsed.entities.push(...next.entities)
      parsed.usages.push(...next.usages)
      parsed.diagnostics.push(...next.diagnostics)
    }
  }
  if (parsed.schemaVersion && !SUPPORTED_SCHEMA_VERSIONS.has(parsed.schemaVersion)) {
    parsed.diagnostics.push(`Unsupported Multica schema ${parsed.schemaVersion}; unknown payloads were preserved without claiming compatibility.`)
  }
  const sessionRoots = [
    ...taskRoots.map((taskRoot) => path.join(taskRoot, 'codex-home', 'sessions')),
    ...readableRoots.filter((root) => root.kind === 'session-container').map((root) => root.path)
  ].filter((candidate) => fs.existsSync(candidate))
  const transcripts = sessionRoots.flatMap((root) => rolloutFiles(root).flatMap((filePath) => {
    const item = transcript(filePath, allowedRealRoots, maxBytes, diagnostics)
    return item ? [item] : []
  }))
  return { roots, taskRoots, transcriptSources: deduplicateTranscriptSources(transcripts), metadataSnapshots, parsed, diagnostics: [...diagnostics, ...parsed.diagnostics] }
}
