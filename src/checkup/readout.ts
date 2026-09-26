/**
 * Swob-side readout: the only module of the checkup that calls the kernel.
 *
 * Allowed kernel entries (task C1a, red line; C1c adds the two per-file reads
 * with stats): `loadAllSessions({ readOnly: true, quiet: true })`,
 * `parseSessionFileWithStats(filePath)`, `parseCodexFileWithStats(filePath)`
 * and pure discovery functions. Everything else — writable loads, lineage,
 * details, resume audit, library/canonical/search/usage writers — is forbidden
 * and guarded by an architecture test.
 *
 * The kernel captures HOME when its modules load and then reuses any summary
 * cache under `$HOME/.claude-session-manager`. Therefore the readout runs only
 * when that directory is inside the caller's one-shot stateDir (or, under
 * Vitest, inside the per-file sandbox) and HOME has not changed since the
 * kernel was loaded. Otherwise it is `undetermined` (readout.not-isolated) and
 * no kernel entry is called at all.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { findClaudeSessionFiles, loadAllSessions, parseSessionFileWithStats } from '../main/session-loader'
import { findCodexSessionFiles, parseCodexFileWithStats } from '../main/codex-loader'
import type { JsonlReadStats } from '../main/jsonl-lines'
import { runtimeHome } from '../main/runtime-home'
import type { SessionSummary } from '../main/types'
import type { ReasonCode } from './contract'

/** HOME as the kernel saw it when this module (evaluated right after the kernel) loaded. */
const KERNEL_HOME_AT_LOAD = runtimeHome()

export const CLAUDE_PARSE_TIMEOUT_MS = 30_000
const PARSE_TIMEOUT_MARGIN_MS = 250

export interface ReadoutSession {
  source: string
  /** Internal only (never reported). */
  sessionId: string
  primaryPath: string | null
  paths: string[]
  subagentPaths: string[]
  subagentIds: string[]
  compactCount: number
  /** Intra-file branch views share their parent's files and are not physical sessions. */
  virtual: boolean
}

export interface ClaudeParseResult { records: number; elapsedMs: number; partial: boolean }

/**
 * Per-file Codex read (C1c). `records` is the kernel's recordsRead; null when the read threw (the
 * kernel reads a Codex file completely or throws, so there is no partial result).
 */
export interface CodexParseResult { records: number | null; elapsedMs: number }

export interface SwobReadout {
  status: 'ok' | 'undetermined'
  reason?: ReasonCode
  sessions: ReadoutSession[]
  /** parseSessionFileWithStats record counts by real path (Claude main and subagent files). */
  claudeParsed: Map<string, ClaudeParseResult>
  /**
   * C1c: parseCodexFileWithStats record counts by real path, for the census Codex files the kernel's own
   * discovery lists (the rollouts it reads). Absent when the readout carries no Codex read counts.
   */
  codexParsed?: Map<string, CodexParseResult>
  discovered: { claudeMain: Set<string>; codex: Set<string> }
  /** Codex child session ids whose usage events carry their own auditSourceId inside a merged parent. */
  attributedChildIds: Set<string>
  consoleLines: number
  timingsMs: Record<string, number>
}

export interface IsolationCheck { isolated: boolean; reason?: 'readout.not-isolated' }

function realpathOrNull(target: string): string | null {
  try {
    return fs.realpathSync.native(target)
  } catch {
    return null
  }
}

/** Real path of `target` even when its tail does not exist yet (nearest existing ancestor resolved). */
export function realpathOfPossiblyMissing(target: string): string | null {
  const resolved = path.resolve(target)
  const tail: string[] = []
  let current = resolved
  for (;;) {
    const real = realpathOrNull(current)
    if (real) return path.join(real, ...tail.reverse())
    const parent = path.dirname(current)
    if (parent === current) return null
    tail.push(path.basename(current))
    current = parent
  }
}

function isStrictlyInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child)
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
}

/** Pure isolation decision (exported for tests). */
export function checkKernelIsolation(input: {
  kernelHome: string
  kernelHomeAtLoad: string
  stateDir: string
  env: NodeJS.ProcessEnv
  realUserHome: string
}): IsolationCheck {
  const notIsolated: IsolationCheck = { isolated: false, reason: 'readout.not-isolated' }
  if (path.resolve(input.kernelHome) !== path.resolve(input.kernelHomeAtLoad)) return notIsolated
  const cacheDir = realpathOfPossiblyMissing(path.join(input.kernelHome, '.claude-session-manager'))
  const realCache = realpathOfPossiblyMissing(path.join(input.realUserHome, '.claude-session-manager'))
  if (!cacheDir || !realCache || cacheDir === realCache) return notIsolated
  const stateDir = realpathOrNull(input.stateDir)
  if (stateDir && isStrictlyInside(cacheDir, stateDir)) return { isolated: true }
  const sandboxRoot = input.env.VITEST && input.env.NODE_ENV === 'test' && input.env.SWOB_E2E_SANDBOX_ROOT
    ? realpathOrNull(input.env.SWOB_E2E_SANDBOX_ROOT)
    : null
  if (sandboxRoot && isStrictlyInside(cacheDir, sandboxRoot)) return { isolated: true }
  return notIsolated
}

export function currentKernelIsolation(stateDir: string): IsolationCheck {
  return checkKernelIsolation({
    kernelHome: runtimeHome(),
    kernelHomeAtLoad: KERNEL_HOME_AT_LOAD,
    stateDir,
    env: process.env,
    realUserHome: os.userInfo().homedir
  })
}

/** HOME the kernel reads (default census home when the caller gives none). */
export function kernelHome(): string {
  return runtimeHome()
}

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const

/** Run kernel code with console output swallowed; only the number of calls is kept. */
async function withCapturedConsole<T>(counter: { lines: number }, run: () => Promise<T>): Promise<T> {
  const saved = CONSOLE_METHODS.map((method) => console[method])
  for (const method of CONSOLE_METHODS) {
    console[method] = () => { counter.lines++ }
  }
  try {
    return await run()
  } finally {
    CONSOLE_METHODS.forEach((method, index) => { console[method] = saved[index] })
  }
}

function realOrResolved(filePath: string): string {
  return realpathOrNull(filePath) ?? path.resolve(filePath)
}

function projectSession(summary: SessionSummary): ReadoutSession {
  const primary = typeof summary.filePath === 'string' && summary.filePath ? summary.filePath : null
  const paths = new Set<string>()
  if (primary) paths.add(realOrResolved(primary))
  for (const filePath of summary.allFilePaths ?? []) if (filePath) paths.add(realOrResolved(filePath))
  const subagents = summary.subagents ?? []
  return {
    source: summary.source || 'claude-code',
    sessionId: summary.sessionId,
    primaryPath: primary ? realOrResolved(primary) : null,
    paths: [...paths],
    subagentPaths: subagents.map((subagent) => realOrResolved(subagent.filePath)),
    subagentIds: subagents.map((subagent) => subagent.sessionId),
    compactCount: typeof summary.compactCount === 'number' ? summary.compactCount : 0,
    virtual: !!summary.branchLeafUuid
  }
}

function emptyReadout(reason: ReasonCode, consoleLines = 0): SwobReadout {
  return {
    status: 'undetermined',
    reason,
    sessions: [],
    claudeParsed: new Map(),
    codexParsed: new Map(),
    discovered: { claudeMain: new Set(), codex: new Set() },
    attributedChildIds: new Set(),
    consoleLines,
    timingsMs: {}
  }
}

async function loadAndProject(): Promise<{ sessions: ReadoutSession[]; attributedChildIds: Set<string> }> {
  const summaries = await loadAllSessions({ readOnly: true, quiet: true })
  const sessions: ReadoutSession[] = []
  const attributedChildIds = new Set<string>()
  for (const summary of summaries) {
    const session = projectSession(summary)
    sessions.push(session)
    if (session.source !== 'codex') continue
    for (const event of summary.tokenAccounting?.usageEvents ?? []) {
      if (event.auditSourceId && event.auditSourceId !== summary.sessionId) attributedChildIds.add(event.auditSourceId)
    }
  }
  return { sessions, attributedChildIds }
}

const elapsedSince = (started: number): number => Math.round(performance.now() - started)

/**
 * Claude per-file result from the kernel's read stats (C1c): partial when the kernel says the read was
 * cut short (truncated: its 30 s timeout fired or the stream failed, and only what was read came back),
 * or when it took the kernel's timeout. Exported for tests.
 */
export function claudeParseResult(stats: Pick<JsonlReadStats, 'recordsRead' | 'truncated'>, elapsedMs: number): ClaudeParseResult {
  return { records: stats.recordsRead, elapsedMs, partial: stats.truncated || elapsedMs >= CLAUDE_PARSE_TIMEOUT_MS - PARSE_TIMEOUT_MARGIN_MS }
}

async function timedParse(filePath: string): Promise<ClaudeParseResult> {
  const started = performance.now()
  const stats = await parseSessionFileWithStats(filePath)
  return claudeParseResult(stats, elapsedSince(started))
}

/**
 * Codex per-file result (C1c): parseCodexFileWithStats sets no timeout and throws on a stream error, so
 * a returned read is complete (never partial by time) and a throw leaves the file without a read count.
 * Only the counts are kept: the records the kernel returns are dropped right here. Exported for tests.
 */
export async function codexParseResult(read: () => Promise<Pick<JsonlReadStats, 'recordsRead'>>): Promise<CodexParseResult> {
  const started = performance.now()
  try {
    const { recordsRead } = await read()
    return { records: recordsRead, elapsedMs: elapsedSince(started) }
  } catch {
    return { records: null, elapsedMs: elapsedSince(started) }
  }
}

export async function readSwobReadout(options: {
  stateDir: string
  claudeMainFiles: readonly string[]
  /**
   * Claude subagent files. The kernel reads them with the same parseSessionFile
   * (session-loader.ts loadRelatedClaudeSubagentMessages), so their per-file
   * read count is measured the same way as a main file's.
   */
  claudeSubagentFiles?: readonly string[]
  /**
   * C1c: census Codex files (readable ones). Only those the kernel's own discovery lists are read — the
   * rollouts it parses; a non-rollout .jsonl is never read by the kernel. Read one at a time after
   * loadAllSessions, which has already parsed each of them once.
   */
  codexFiles?: readonly string[]
  signal?: AbortSignal
  concurrency?: number
}): Promise<SwobReadout> {
  if (!currentKernelIsolation(options.stateDir).isolated) return emptyReadout('readout.not-isolated')
  const counter = { lines: 0 }
  const timingsMs: Record<string, number> = {}
  try {
    return await withCapturedConsole(counter, async () => {
      let started = performance.now()
      const claudeMain = new Set(findClaudeSessionFiles().map(realOrResolved))
      const codex = new Set(findCodexSessionFiles().map(realOrResolved))
      timingsMs.discovery = Math.round(performance.now() - started)

      started = performance.now()
      // Summaries (with their usage ledgers) stay inside loadAndProject so they can be collected
      // before the per-file parse phase below.
      const { sessions, attributedChildIds } = await loadAndProject()
      timingsMs.loadAllSessions = Math.round(performance.now() - started)

      started = performance.now()
      const claudeParsed = new Map<string, ClaudeParseResult>()
      const queue = [...options.claudeMainFiles, ...(options.claudeSubagentFiles ?? [])]
      const workers = Array.from({ length: Math.max(1, options.concurrency ?? 1) }, async () => {
        for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
          if (options.signal?.aborted) return
          try {
            claudeParsed.set(next, await timedParse(next))
          } catch {
            claudeParsed.set(next, { records: 0, elapsedMs: 0, partial: true })
          }
        }
      })
      await Promise.all(workers)
      timingsMs.parseSessionFile = Math.round(performance.now() - started)

      started = performance.now()
      const codexParsed = new Map<string, CodexParseResult>()
      for (const filePath of options.codexFiles ?? []) {
        if (options.signal?.aborted) break
        if (!codex.has(filePath) || codexParsed.has(filePath)) continue
        codexParsed.set(filePath, await codexParseResult(() => parseCodexFileWithStats(filePath)))
      }
      timingsMs.parseCodexFile = Math.round(performance.now() - started)
      if (options.signal?.aborted) {
        const error = new Error('checkup aborted')
        error.name = 'AbortError'
        throw error
      }
      return {
        status: 'ok' as const,
        sessions,
        claudeParsed,
        codexParsed,
        discovered: { claudeMain, codex },
        attributedChildIds,
        consoleLines: counter.lines,
        timingsMs
      }
    })
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error
    return emptyReadout('readout.kernel-error', counter.lines)
  }
}
