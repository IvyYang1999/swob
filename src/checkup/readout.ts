/**
 * Swob-side readout: the only module of the checkup that calls the kernel.
 *
 * Allowed kernel entries (task C1a, red line; C1c adds the two per-file reads
 * with stats; C2c adds the ⑥ resume command-layer factory and the L3 anchor
 * classifier, both pure): `loadAllSessions({ readOnly: true, quiet: true })`,
 * `parseSessionFileWithStats(filePath)`, `parseCodexFileWithStats(filePath)`,
 * `buildResumeCommand` (session-actions.ts) and `classifyResumeL3` /
 * `anchorsFromMessages` (resume-verifier.ts), plus pure discovery functions.
 * Everything else — writable loads, lineage, details, resume audit,
 * library/canonical/search/usage writers, guarded resume (buildGuardedResumeCommand) — is forbidden and
 * guarded by an architecture test.
 *
 * The kernel captures HOME when its modules load and then reuses any summary
 * cache under `$HOME/.claude-session-manager`. Therefore the readout runs only
 * when that directory is inside the caller's one-shot stateDir (or, under
 * Vitest, inside the per-file sandbox) and HOME has not changed since the
 * kernel was loaded. Otherwise it is `undetermined` (readout.not-isolated) and
 * no kernel entry is called at all.
 */
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { findClaudeSessionFiles, loadAllSessions, parseSessionFileWithStats } from '../main/session-loader'
import { findCodexSessionFiles, parseCodexFileWithStats, type CodexLine } from '../main/codex-loader'
import type { JsonlReadStats } from '../main/jsonl-lines'
import { runtimeHome } from '../main/runtime-home'
import type { RawJsonlMessage, SessionSummary } from '../main/types'
import type { TokenAccounting, UsageEvent } from '../main/token-accounting'
import { buildResumeCommand } from '../main/session-actions'
import {
  anchorsFromMessages,
  classifyResumeL3,
  type ResumeAnchorMessage,
  type ResumeAnchors,
  type ResumeL3TargetData
} from '../main/resume-verifier'
import type { ReasonCode, ResumeProbe, ResumeProbeInput } from './contract'

/** HOME as the kernel saw it when this module (evaluated right after the kernel) loaded. */
const KERNEL_HOME_AT_LOAD = runtimeHome()

export const CLAUDE_PARSE_TIMEOUT_MS = 30_000
const PARSE_TIMEOUT_MARGIN_MS = 250

/**
 * ⑤ Token: one session's Swob-side four components + billing total (C2a), independent of the census
 * oracle. `provenance` mirrors `TokenAccounting.provenance`; `unavailable` (no components/billingTotal)
 * happens when the kernel itself has no authoritative usage for this session (e.g. Cursor).
 */
export interface ReadoutSessionTokens {
  provenance: 'reported' | 'derived' | 'estimated' | 'unavailable'
  components: { nonCachedInput: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number } | null
  billingTotal: number | null
  /**
   * Sum of |raw cache-write aggregate − Swob's own cache-write total| over billed Claude events where the
   * two disagree (token-accounting.ts:554-568's registered cache-write calibration difference: a request
   * with a 5m/1h breakdown uses the breakdown for billing, but `rawCacheWriteTokens` keeps the aggregate).
   * A ccusage-style oracle that reads the raw aggregate differs from Swob by up to this much for a known,
   * already-warned reason, not a defect (design §四 4.5). Always 0 for a non-Claude session.
   */
  cacheWriteCalibrationDeltaTokens: number
}

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
  // —— C2b (④ lineage) additions: ids only, never the session's content ——
  /** SessionSummary.id (internal composite id; used to resolve branchParentId/branchChildIds below). */
  id?: string
  /** The `.id` of the session this one was resumed/forked from (session-loader.ts linkCrossSessionBranches / forkedFrom / Codex forked_from_id). */
  branchParentId?: string
  /** The `.id`s of sessions resumed/forked from this one. */
  branchChildIds?: string[]
  /** uuid at which a cross-session branch/fork point was detected. */
  branchPointUuid?: string
  /** Other physical sessionIds merged into this logical session (same sessionId, multiple files). */
  continuationSessionIds?: string[]
  /** Direct subagents of this session, each with the parent it was actually recorded under (may be a nested ancestor, not always this session's own id). */
  subagents?: Array<{ sessionId: string; parentSessionId: string | null }>
  /**
   * ⑤ Token (C2a). Optional so every existing fixture/self-test session (①②③, none of which need token
   * data) keeps compiling unchanged; absent is equivalent to `unavailableReadoutTokens()`
   * (`checks/tokens.ts` reads it through that default, never `.tokens!`).
   */
  tokens?: ReadoutSessionTokens
  // —— C2c (⑥ resume) additions: same fields ResumeProbeInput needs, never message content ——
  /** Working directory the resume command would `cd` into (SessionSummary.resumeCwd). */
  resumeCwd?: string
  permissionMode?: string
  /** Non-default Claude config dir, e.g. ~/.claude-window/<id> (SessionSummary.claudeConfigDir). */
  claudeConfigDir?: string
  /** Compatibility field: mirrors SessionSummary.canResumeLocal (absent when the kernel never set it). */
  canResumeLocal?: boolean
  resumeUnavailableReason?: string
  /** SessionSummary.messageCount (H1: sampling by 7-day activity uses this, never a new count). */
  messageCount?: number
  /** SessionSummary.updatedAt (ISO); used only to decide the 7-day sampling window. */
  updatedAt?: string
}

/** The `tokens` value of a session with no usable ledger (absent `ReadoutSession.tokens`, or a real unavailable one). */
export function unavailableReadoutTokens(): ReadoutSessionTokens {
  return { provenance: 'unavailable', components: null, billingTotal: null, cacheWriteCalibrationDeltaTokens: 0 }
}

/**
 * Hashed anchor pair (⑥ L3, C2c): the normalized last user / last assistant text of one physical file,
 * reduced to sha256(text).slice(0,8) — never the text itself (design red line: "锚点只留哈希/布尔"). `null`
 * when that role has no anchor text in the file (e.g. an assistant-only or empty file).
 *
 * `lastTimestamp` (C2c-3): the file's own record timestamp of its last non-sidechain user/assistant record
 * (whichever role that is), kept only to (a) let checks/resume.ts pick which of a session's several files
 * the merged UI would show last — an approximation, not a replica of session-loader.ts's uuid-deduped
 * cross-file merge — and (b) flag a cached summary that has not caught up to a fresher on-disk file (design
 * doc's own errata: `loadAllSessions({readOnly:true})` may reuse a `summary-cache.sqlite` entry older than
 * this run's own fresh per-file read). A timestamp, never raw text (still within the red line). Optional so
 * every pre-C2c-3 fixture/older readout keeps compiling; absent is equivalent to null (no ranking signal).
 */
export interface ResumeAnchorHashes { lastUser: string | null; lastAssistant: string | null; lastTimestamp?: string | null }

export interface ClaudeParseResult { records: number; elapsedMs: number; partial: boolean; resumeAnchors?: ResumeAnchorHashes }

/**
 * Per-file Codex read (C1c). `records` is the kernel's recordsRead; null when the read threw (the
 * kernel reads a Codex file completely or throws, so there is no partial result).
 */
export interface CodexParseResult { records: number | null; elapsedMs: number; resumeAnchors?: ResumeAnchorHashes }

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

/** Real path of `filePath`, falling back to a plain resolve when it does not (yet) exist. Exported (C2c-3)
 * so checks/resume.ts can normalize a path read from outside this module (Codex state db `rollout_path`)
 * the same way every path already inside a `ReadoutSession`/`claudeParsed`/`codexParsed` key was. */
export function realOrResolved(filePath: string): string {
  return realpathOrNull(filePath) ?? path.resolve(filePath)
}

/**
 * ⑤ Token (C2a, package decision 1): equivalent rewrite of `token-accounting.ts#uniqueBillingEvents` — one
 * event per billing fact key (`billingFactKey || dedupKey`), a `scope: 'main'` event winning a collision.
 * Independent of the kernel export (guarded by `readout.test.ts`'s equivalence test against the same
 * events), so the ⑤ check never merely reads back a number the kernel already computed for itself.
 * F1m: an `'inherited'` copy never wins either — the kernel's load counted its billing fact in another
 * session (the copy stays in `usageEvents` as an audit row), so summing it here would count that call twice.
 */
function dedupeBillingEvents(events: readonly UsageEvent[]): UsageEvent[] {
  const selected = new Map<string, UsageEvent>()
  for (const event of events) {
    if (event.scope === 'inherited') continue
    const key = event.billingFactKey || event.dedupKey
    const current = selected.get(key)
    if (!current || (current.scope !== 'main' && event.scope === 'main')) selected.set(key, event)
  }
  return [...selected.values()]
}

function addComponents(
  totals: NonNullable<ReadoutSessionTokens['components']>,
  components: UsageEvent['components']
): void {
  totals.nonCachedInput += components.nonCachedInputTokens
  totals.cacheRead += components.cacheReadTokens
  totals.cacheWrite += components.cacheWriteTokens + components.cacheWrite5mTokens + components.cacheWrite1hTokens
  totals.output += components.outputTokens
  totals.reasoning += components.reasoningTokens ?? 0
}

/** The registered Claude cache-write calibration difference (token-accounting.ts:554-568), if this event has it. */
function cacheWriteCalibrationDelta(event: UsageEvent): number {
  if (event.provider !== 'claude-code' && event.provider !== 'cc-mirror') return 0
  const raw = event.rawCacheWriteTokens
  if (raw === undefined) return 0
  const billed = event.components.cacheWriteTokens + event.components.cacheWrite5mTokens + event.components.cacheWrite1hTokens
  return raw === billed ? 0 : Math.abs(raw - billed)
}

function sumReadoutComponents(events: readonly UsageEvent[]): { components: NonNullable<ReadoutSessionTokens['components']>; cacheWriteCalibrationDeltaTokens: number } {
  const components = { nonCachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 }
  let cacheWriteCalibrationDeltaTokens = 0
  for (const event of events) {
    addComponents(components, event.components)
    cacheWriteCalibrationDeltaTokens += cacheWriteCalibrationDelta(event)
  }
  return { components, cacheWriteCalibrationDeltaTokens }
}

function billingTotalOf(components: NonNullable<ReadoutSessionTokens['components']>): number {
  return components.nonCachedInput + components.cacheRead + components.cacheWrite + components.output
}

/** ⑤ Token (C2a): `ReadoutSession.tokens` from the kernel's own per-session ledger. Exported for tests. */
export function readoutTokensFromAccounting(accounting: TokenAccounting | null | undefined): ReadoutSessionTokens {
  if (!accounting || accounting.provenance === 'unavailable' || !accounting.components || accounting.billingTotal === null) {
    return unavailableReadoutTokens()
  }
  if (accounting.usageEventsOmitted) {
    // Defensive fallback, not expected under checkup's readOnly load (task book: omitCachedUsageEvents is
    // never passed, so usageEvents stay complete) — without the per-event ledger there is nothing to
    // redo the dedup from, so the kernel's own aggregate is used as-is.
    const components = { nonCachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 }
    addComponents(components, accounting.components)
    return { provenance: accounting.provenance, components, billingTotal: accounting.billingTotal, cacheWriteCalibrationDeltaTokens: 0 }
  }
  const { components, cacheWriteCalibrationDeltaTokens } = sumReadoutComponents(dedupeBillingEvents(accounting.usageEvents))
  return { provenance: accounting.provenance, components, billingTotal: billingTotalOf(components), cacheWriteCalibrationDeltaTokens }
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
    virtual: !!summary.branchLeafUuid,
    id: summary.id,
    ...(summary.branchParentId ? { branchParentId: summary.branchParentId } : {}),
    ...(summary.branchChildIds && summary.branchChildIds.length > 0 ? { branchChildIds: [...summary.branchChildIds] } : {}),
    ...(summary.branchPointUuid ? { branchPointUuid: summary.branchPointUuid } : {}),
    ...(summary.continuationSessionIds && summary.continuationSessionIds.length > 0 ? { continuationSessionIds: [...summary.continuationSessionIds] } : {}),
    ...(subagents.length > 0 ? { subagents: subagents.map((subagent) => ({ sessionId: subagent.sessionId, parentSessionId: subagent.parentSessionId ?? null })) } : {}),
    tokens: readoutTokensFromAccounting(summary.tokenAccounting),
    ...(summary.resumeCwd ? { resumeCwd: summary.resumeCwd } : {}),
    ...(summary.permissionMode ? { permissionMode: summary.permissionMode } : {}),
    ...(summary.claudeConfigDir ? { claudeConfigDir: summary.claudeConfigDir } : {}),
    ...(summary.canResumeLocal !== undefined ? { canResumeLocal: summary.canResumeLocal } : {}),
    ...(summary.resumeUnavailableReason ? { resumeUnavailableReason: summary.resumeUnavailableReason } : {}),
    ...(typeof summary.messageCount === 'number' ? { messageCount: summary.messageCount } : {}),
    ...(summary.updatedAt ? { updatedAt: summary.updatedAt } : {})
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

/** sha256(text.trim()).slice(0,8), or null when there is nothing to anchor on (⑥, design red line: no raw text leaves this file). */
function hashAnchor(text: string): string | null {
  const trimmed = text.trim()
  return trimmed ? createHash('sha256').update(trimmed).digest('hex').slice(0, 8) : null
}

/** Same shape resume-verifier.ts's own `extractRawText` reads (message.content: string, or text parts joined). */
function claudeMessageText(message: RawJsonlMessage): string {
  const content = message.message?.content
  if (!content) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((part) => part.type === 'text' && part.text).map((part) => part.text!).join('\n')
}

/**
 * Last default-chain user/assistant anchor of one Claude file (⑥ C2c, design §四 4.6): non-sidechain
 * user/assistant records, reduced with the whitelisted `anchorsFromMessages` (resume-verifier.ts) and
 * hashed immediately. Intra-file branch selection is not replicated here (`selectClaudeDefaultChain` is
 * not on the kernel-gateway whitelist); "last non-sidechain record of each role in file order" is used
 * instead — a reasonable v1 simplification (task book: comparison is non-independent / [D] already).
 */
/** Latest parseable timestamp seen so far (file order is not trusted to already be chronological); `null` when nothing parsed yet. */
function laterTimestamp(current: string | null, currentMs: number, candidate: string): { value: string | null; ms: number } {
  const ms = Date.parse(candidate)
  if (!Number.isFinite(ms) || ms < currentMs) return { value: current, ms: currentMs }
  return { value: candidate, ms }
}

function claudeResumeAnchors(messages: readonly RawJsonlMessage[]): ResumeAnchorHashes {
  const candidates: ResumeAnchorMessage[] = []
  let lastTimestamp: string | null = null
  let lastMs = -Infinity
  for (const message of messages) {
    if (message.isSidechain) continue
    if (message.type === 'user') candidates.push({ role: 'user', text: claudeMessageText(message) })
    else if (message.type === 'assistant') candidates.push({ role: 'assistant', text: claudeMessageText(message) })
    else continue
    ;({ value: lastTimestamp, ms: lastMs } = laterTimestamp(lastTimestamp, lastMs, message.timestamp))
  }
  const anchors = anchorsFromMessages(candidates)
  return { lastUser: hashAnchor(anchors.user), lastAssistant: hashAnchor(anchors.assistant), lastTimestamp }
}

/** One response_item.message row's anchor candidate, or null when it is not a user/assistant message. */
function codexAnchorCandidate(line: Pick<CodexLine, 'type' | 'payload'>): ResumeAnchorMessage | null {
  if (line.type !== 'response_item') return null
  const payload = line.payload
  const role = payload?.type === 'message' ? payload.role : undefined
  if (role !== 'user' && role !== 'assistant') return null
  const parts = Array.isArray(payload.content) ? payload.content as Array<{ type?: unknown; text?: unknown }> : []
  const wanted = role === 'user' ? 'input_text' : 'output_text'
  const text = parts.filter((part) => part?.type === wanted && typeof part.text === 'string').map((part) => part.text as string).join('\n')
  return { role, text }
}

/** Last user/assistant anchor of one Codex rollout file (⑥ C2c): same reduction as the Claude side. */
function codexResumeAnchors(lines: readonly CodexLine[]): ResumeAnchorHashes {
  const candidates: ResumeAnchorMessage[] = []
  let lastTimestamp: string | null = null
  let lastMs = -Infinity
  for (const line of lines) {
    const candidate = codexAnchorCandidate(line)
    if (!candidate) continue
    candidates.push(candidate)
    ;({ value: lastTimestamp, ms: lastMs } = laterTimestamp(lastTimestamp, lastMs, line.timestamp))
  }
  const anchors = anchorsFromMessages(candidates)
  return { lastUser: hashAnchor(anchors.user), lastAssistant: hashAnchor(anchors.assistant), lastTimestamp }
}

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
  // ⑥ C2c: the full message array is already in hand (stats.messages) before it is dropped below —
  // extract the anchor here, once, in the same read ② already pays for.
  const resumeAnchors = claudeResumeAnchors(stats.messages)
  return { ...claudeParseResult(stats, elapsedSince(started)), resumeAnchors }
}

/**
 * Codex per-file result (C1c/C2c): parseCodexFileWithStats sets no timeout and throws on a stream error,
 * so a returned read is complete (never partial by time) and a throw leaves the file without a read
 * count. The record counts are kept as before; C2c additionally widens `read()`'s return type to include
 * `lines` (previously narrowed to `Pick<JsonlReadStats,'recordsRead'>`, which dropped them before this
 * function ever saw them) so the ⑥ resume anchor can be extracted here, once, before `lines` is dropped —
 * same pattern as the Claude side, not a second file read. Exported for tests.
 */
export async function codexParseResult(read: () => Promise<Pick<JsonlReadStats, 'recordsRead'> & { lines: readonly CodexLine[] }>): Promise<CodexParseResult> {
  const started = performance.now()
  try {
    const { recordsRead, lines } = await read()
    return { records: recordsRead, elapsedMs: elapsedSince(started), resumeAnchors: codexResumeAnchors(lines) }
  } catch {
    return { records: null, elapsedMs: elapsedSince(started) }
  }
}

export type ResumeAnchorMatchStatus = 'match' | 'mismatch' | 'would-404' | 'skipped'

/**
 * ⑥ L3 (C2c, design §四 4.6): compares two already-hashed anchor pairs by delegating to the whitelisted
 * `classifyResumeL3` (resume-verifier.ts) — the hashes stand in for the real text it compares by `===`,
 * so this is the one place that decision function runs; no anchor text ever leaves this module (non-
 * independent oracle, [D] — an independent implementation is deferred to C2d per the task book).
 */
export function classifyResumeAnchors(input: { expected: ResumeAnchorHashes; target: ResumeAnchorHashes | 'missing' | 'unparseable' }): ResumeAnchorMatchStatus {
  const expected: ResumeAnchors = { user: input.expected.lastUser ?? '', assistant: input.expected.lastAssistant ?? '' }
  if (input.target === 'missing' || input.target === 'unparseable') {
    const target: ResumeL3TargetData = { status: input.target, defaultMessages: [], allMessages: [] }
    return classifyResumeL3(expected, target).status
  }
  const messages: ResumeAnchorMessage[] = []
  if (input.target.lastUser) messages.push({ role: 'user', text: input.target.lastUser })
  if (input.target.lastAssistant) messages.push({ role: 'assistant', text: input.target.lastAssistant })
  const target: ResumeL3TargetData = { status: messages.length > 0 ? 'found' : 'empty', defaultMessages: messages, allMessages: messages }
  return classifyResumeL3(expected, target).status
}

/**
 * ⑥ command layer (C2c): the CLI worker's own factory (task book — `ResumeProbe.build()` must be
 * constructed inside the process that runs the checkup, never passed across the worker's process
 * boundary as a function value). `buildResumeCommand` is a pure command-string builder (only
 * `fs.existsSync(cwd)`; never `buildGuardedResumeCommand`, which may write and spawn).
 */
export function defaultResumeProbe(pathEnv: string): ResumeProbe {
  return {
    pathEnv,
    build(input: ResumeProbeInput) {
      if (input.canResumeLocal === false) return { refused: input.resumeUnavailableReason ?? 'resume-unavailable' }
      try {
        return { command: buildResumeCommand(input.sessionId, input.permissionMode, input.resumeCwd, input.source, input.claudeConfigDir) }
      } catch (error) {
        return { refused: error instanceof Error ? error.message : 'resume-command-build-failed' }
      }
    }
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
