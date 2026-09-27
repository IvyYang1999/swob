/**
 * ⑥ Resume (dry run) (C2c, design §四 4.6). Only checks, never starts anything: no resume command is ever
 * executed, no `claude`/`codex`/`cursor`/… process is ever spawned. `zsh -n -c` is a syntax check only
 * (the `-n` flag reads but never executes).
 *
 * Two layers, both against every non-virtual Claude/Codex session (design "对全部会话干跑"):
 * - Data layer (kernel-independent, pure fs metadata): four buckets — recoverable / missing file /
 *   missing directory / unsupported source (`session.canResumeLocal === false`, e.g. an intra-file branch
 *   view or a remote-only session; never inferred, mirrors the kernel's own field).
 * - L3 content anchor (C2c-3 口径修正: F1o 诊断 + 三轮派单人决定): readout.ts already extracted and hashed
 *   the last user/assistant anchor of every file it read, each now carrying its own timestamp
 *   (`resumeAnchors`); this check asks resume-verifier.ts's own classifier (via `classifyResumeAnchors`,
 *   whitelisted, unchanged) whether "恢复侧" (the file the tool's own default resume command would actually
 *   open — Claude: `session.primaryPath`, structurally the `sessionId`-named file; Codex: the file Codex's
 *   own state db `rollout_path` currently names, falling back to `primaryPath` when there is no row) still
 *   reads the same content as "展示侧" (the `session.paths` member whose own anchor is freshest — an
 *   approximation of what the merged UI actually shows last). Labelled [D], "非独立来源" (design/task book):
 *   v1 has no second, independently-implemented anchor extraction to diff against — both sides come from
 *   the same readout pass. This deliberately no longer compares "Swob's primary file" against "any other
 *   file the same session happens to group" (the pre-C2c-3 v1): a multi-file session's other file is
 *   routinely, by design, different content (a Claude continuation shard, a Codex thread's second rollout),
 *   so that comparison's "mismatch" never meant anything a user could act on — see `classifyAnchorComparison`
 *   below for the full reasoning and the `cache-lag`/`cannot-verify` tiers this revision adds. An
 *   independent implementation is still deferred to C2d (task book).
 *
 * The command layer (program lookup + `zsh -n`) is sampled, not run on every session (design §四 4.6):
 * per source, `resumeSample.perSource` sessions chosen by a seeded, reproducible order (H1: seed = local
 * date by default), plus up to 5 more sessions most active in the last 7 days (H1: ranked by
 * `messageCount`, ties by `updatedAt`) — a fixed constant, not a CheckupOptions knob. `ctx.resumeProbe`
 * is null for a shell that does not own resume (the AI diary, design §3.4): the command layer then reads
 * unavailable and never grades the source (only the data layer + anchor comparison do).
 *
 * Only Claude Code and Codex are evaluated (task book: "Claude、Codex 有结论"). Cursor is forced
 * not-applicable here even though its own `terminal-resume` capability is declared 'available' elsewhere
 * in the app (provider-capabilities.ts) — this check's data-layer/anchor infrastructure only covers the
 * two sources readout.ts's per-file re-read already parses; OpenCode/ZCode are left to the generic
 * capability-table path (`remainingSources`), per task book "OpenCode/ZCode 按能力表".
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Finding, ResumeProbeInput, Verdict } from '../contract'
import { classifyResumeAnchors, realOrResolved, type ReadoutSession, type ResumeAnchorHashes } from '../readout'
import type { CodexStateDb } from '../census/codex-state-db'
import {
  applicability,
  applicabilityEntry,
  assembleCheck,
  derived,
  hasClaudeData,
  hasCodexData,
  localDateAndOffset,
  makeFinding,
  percentMeasure,
  remainingSources,
  reported,
  sampleIds,
  sourceVerdict,
  unavailable,
  type CheckContext,
  type SourceEntry
} from './common'

type ResumeSource = 'claude-code' | 'codex'
type Bucket = 'recoverable' | 'missing-file' | 'missing-directory' | 'unsupported'

/** The program each source's resume command would invoke (mirrors session-actions.ts's own per-source branch, not re-imported). */
const RESUME_PROGRAM: Record<ResumeSource, string> = { 'claude-code': 'claude', codex: 'codex' }

function existsNow(target: string | null | undefined): boolean {
  if (!target) return false
  try {
    fs.statSync(target)
    return true
  } catch {
    return false
  }
}

function classifyBucket(session: ReadoutSession): Bucket {
  if (session.canResumeLocal === false) return 'unsupported'
  if (!existsNow(session.primaryPath)) return 'missing-file'
  if (session.resumeCwd && !existsNow(session.resumeCwd)) return 'missing-directory'
  return 'recoverable'
}

// —— command layer (sampled): program lookup + zsh syntax check, never execution ——

export type ProgramLookupStatus = 'found' | 'broken-symlink' | 'missing'

/**
 * ⑥ command layer (design §四 4.6): `lstat` → `realpath` → `X_OK`, replacing `resume-audit.ts`'s
 * `isBinaryAvailable` (`accessSync(X_OK)` only, which reports a broken symlink as plain "missing" and
 * cannot say why — design's own real-machine finding: the local `claude` shortcut points at a deleted
 * version). Written here rather than imported (not on the kernel-gateway whitelist; this small
 * lookup — lstat/realpath/access are read-only metadata calls, no exec — does not need to be). Only
 * reads filesystem metadata; the resolved target path itself is never returned or reported (privacy: no
 * real paths in the report), only the enum below.
 */
export function locateProgram(program: string, pathEnv: string): ProgramLookupStatus {
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, program)
    try {
      fs.lstatSync(candidate)
    } catch {
      continue // nothing named `program` in this PATH entry
    }
    let real: string
    try {
      real = fs.realpathSync.native(candidate)
    } catch {
      return 'broken-symlink' // an entry exists, but following it (through however many symlinks) fails
    }
    try {
      fs.accessSync(real, fs.constants.X_OK)
      return 'found'
    } catch {
      continue // exists but not executable; a login shell would keep searching PATH
    }
  }
  return 'missing'
}

/** `zsh -n -c "<command>"`: parses but never executes (task red line). Never spawns the resume program itself. */
function zshSyntaxOk(command: string): boolean {
  const result = spawnSync('zsh', ['-n', '-c', command], { timeout: 5_000, stdio: 'ignore' })
  return result.status === 0
}

// —— sampling (design §四 4.6, task book H1/H2) ——

/** Deterministic pseudo-score in [0,1) from (seed, key) — FNV-1a-like, reproducible for a fixed seed. */
function seededScore(seed: string, key: string): number {
  let hash = 0x811c9dc5
  const input = `${seed}\u0000${key}`
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) / 0x100000000
}

/** `resumeSample.perSource` sessions in a seeded, reproducible order (same seed + session set -> same pick). */
function seededSample(sessions: readonly ReadoutSession[], seed: string, count: number): ReadoutSession[] {
  return [...sessions].sort((left, right) => seededScore(seed, left.sessionId) - seededScore(seed, right.sessionId)).slice(0, count)
}

const MOST_ACTIVE_COUNT = 5
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

/** Up to 5 more sessions active in the last 7 days, ranked by messageCount then updatedAt (task book H1). */
function mostActiveRecently(sessions: readonly ReadoutSession[], nowMs: number): ReadoutSession[] {
  return sessions
    .filter((session) => {
      const at = session.updatedAt ? Date.parse(session.updatedAt) : NaN
      return Number.isFinite(at) && nowMs - at <= SEVEN_DAYS_MS
    })
    .sort((left, right) => (right.messageCount ?? 0) - (left.messageCount ?? 0) ||
      Date.parse(right.updatedAt ?? '') - Date.parse(left.updatedAt ?? ''))
    .slice(0, MOST_ACTIVE_COUNT)
}

function chooseSample(sessions: readonly ReadoutSession[], seed: string, perSource: number, nowMs: number): ReadoutSession[] {
  const chosen = new Map<string, ReadoutSession>()
  for (const session of seededSample(sessions, seed, perSource)) chosen.set(session.sessionId, session)
  for (const session of mostActiveRecently(sessions, nowMs)) chosen.set(session.sessionId, session)
  return [...chosen.values()]
}

// —— L3 content anchor (design §四 4.6; [D], non-independent — see file header) ——
//
// C2c-3 (F1o 诊断 + 三轮派单人决定): the original v1 compared Swob's own primaryPath against *any other*
// file the same session's `paths` happened to group under it — but a multi-file session's other file is
// routinely, *by design*, different content (a Claude continuation shard, a Codex thread's second rollout),
// so that comparison's "mismatch" never meant anything a user could act on (F1o real-HOME: the only 3
// sessions where a genuine cross-file comparison was even possible were 3/3 "mismatches", all a same-session
// grouping artifact, not stale/wrong content). The comparison is redefined around the one question a user
// actually has: is the file the tool's own resume command would open (恢复侧) the same content Swob is
// showing them right now (展示侧)? Same underlying hash-equality primitive (classifyResumeAnchors /
// resume-verifier.ts#classifyResumeL3, untouched, still [D]) — only which two files feed it has changed.

interface ParsedEntry { resumeAnchors?: ResumeAnchorHashes; records?: number | null }

type AnchorLookup = ResumeAnchorHashes | 'unparseable' | null

/**
 * `entry.records === null` only ever happens for a Codex entry whose read genuinely threw
 * (`codexParseResult`'s catch branch; a Claude `ClaudeParseResult.records` is always a real number) — a
 * real "would resume to 404/unparseable" signal, distinct from `!entry.resumeAnchors` (no anchor data
 * recorded for this entry at all, e.g. an older fixture/readout that predates this field), which is
 * excluded from the tally rather than counted as a failure (null).
 */
function anchorLookup(filePath: string | null, parsed: ReadonlyMap<string, ParsedEntry> | undefined): AnchorLookup {
  if (!filePath) return null
  const entry = parsed?.get(filePath)
  if (!entry) return null // this file was outside this run's read queue — excluded from the tally, not a failure
  if (entry.records === null) return 'unparseable'
  return entry.resumeAnchors ?? null
}

type AnchorComparisonStatus = 'not-comparable' | 'would-404' | 'match' | 'mismatch' | 'cache-lag' | 'cannot-verify'

/** Which physical file's anchor to use as the "恢复侧" (the file the tool's own default resume command would actually open), or why none is available. */
type RecoverySide =
  | { kind: 'ok'; anchors: ResumeAnchorHashes }
  | { kind: 'would-404' } // the file this session *would* resume to exists as a path, but did not read cleanly this run
  | { kind: 'cannot-verify' } // Codex only: state db names a file, but this run has no anchor data for it at all
  | { kind: 'not-comparable' } // no anchor data and no reason to believe there ever would be (excluded, not a failure)

/**
 * Claude: `buildResumeCommand`/`buildTerminalResumeCommand` (session-actions.ts) only ever take `sessionId`
 * — `claude --resume <sessionId>` — never a file path; the CLI finds the file itself by that name. Swob's
 * own `session.primaryPath` is structurally that same file (task book Q1: `resolvePhysicalSessionId` names
 * a continuation cluster's root by its own filename, and `buildLogicalSessionClusters` keeps the root's
 * path first), so it stands in for "恢复侧" directly — no state db, no lookup needed.
 */
function claudeRecoverySide(session: ReadoutSession, parsed: ReadonlyMap<string, ParsedEntry> | undefined): RecoverySide {
  const entry = anchorLookup(session.primaryPath, parsed)
  if (entry === null) return { kind: 'not-comparable' }
  if (entry === 'unparseable') return { kind: 'would-404' }
  return { kind: 'ok', anchors: entry }
}

/**
 * Codex: `codex resume <id>` looks the thread up by id in its own state db, not by Swob's chosen file — the
 * actual recovery target is whatever `threads.rollout_path` currently says (census's own `readCodexStateDb`,
 * unmodified: no `?immutable=1`, Codex may still be writing its WAL). No row for this session — db entirely
 * unavailable, or this session id genuinely absent — falls back to `primaryPath`, same as the Claude side
 * (F1p not yet landed: this is the common case today). A row whose path this run never actually read (path
 * resolution failed, or the file was simply outside this run's read queue) is deliberately *not* a silent
 * fallback to primaryPath: the db is telling us it trusts a different file, so comparing against primaryPath
 * instead could paper over a real divergence with a false "match" — `cannot-verify` says plainly that this
 * one could not be checked either way (task book: "路径未读到 → 判「注意·无法核对」").
 */
function codexRecoverySide(
  session: ReadoutSession,
  parsed: ReadonlyMap<string, ParsedEntry> | undefined,
  db: CodexStateDb | null
): RecoverySide {
  const thread = db?.available ? db.threads.find((candidate) => candidate.id === session.sessionId) : undefined
  if (!thread || !thread.rolloutPath) return claudeRecoverySide(session, parsed) // "db 无行" → 退回 Swob 主文件
  const entry = anchorLookup(realOrResolved(thread.rolloutPath), parsed)
  if (entry === null) return { kind: 'cannot-verify' }
  if (entry === 'unparseable') return { kind: 'would-404' }
  return { kind: 'ok', anchors: entry }
}

/**
 * "展示侧": the `session.paths` member (continuation shards, compaction copies, Codex's second rollout, …)
 * whose own last-message timestamp is the *latest* — an approximation of what the merged UI actually shows
 * last (task book M1/S2), not a replica of session-loader.ts's uuid-deduped cross-file raw merge (that
 * function is private to session-loader.ts and out of this package's write domain either way). A file with
 * no anchor data this run (unread or unparseable) is not a candidate: there is no timestamp to rank it by,
 * and no content to compare either.
 */
function resolveDisplaySide(session: ReadoutSession, parsed: ReadonlyMap<string, ParsedEntry> | undefined): ResumeAnchorHashes | null {
  let best: ResumeAnchorHashes | null = null
  let bestMs = -Infinity
  for (const filePath of session.paths) {
    const entry = anchorLookup(filePath, parsed)
    if (entry === null || entry === 'unparseable') continue
    const parsedMs = entry.lastTimestamp ? Date.parse(entry.lastTimestamp) : NaN
    const effectiveMs = Number.isFinite(parsedMs) ? parsedMs : -Infinity
    if (!best || effectiveMs > bestMs) { best = entry; bestMs = effectiveMs }
  }
  return best
}

/**
 * ⑥ L3 (C2c-3): 恢复侧 (the file the tool's own default resume command would actually open) vs 展示侧 (the
 * `session.paths` member whose own anchor is freshest, see `resolveDisplaySide`). Both sides read, both
 * non-empty, genuinely different content → `mismatch`: this is the one case that means something a user
 * can act on ("what opens on resume ≠ what you're looking at"). A mismatch is downgraded to `cache-lag`
 * when even Swob's own summary (`session.updatedAt`, the field `loadAllSessions` computed for this session)
 * has not caught up to the fresh anchor re-read 展示侧 picked — i.e. Swob's own bookkeeping already looks
 * behind what this run just read off disk, so a stale grouping/cache is more likely than two genuinely
 * unrelated files sharing a session (task book S2; design doc's own errata notes `loadAllSessions
 * ({readOnly:true})` may reuse a `summary-cache.sqlite` entry). Single-file sessions (`session.paths.length
 * === 1`, the overwhelming majority — C2c 独立验收: 58/59 Claude, 526/528 Codex) structurally always
 * degenerate to comparing a file against itself here (both sides resolve to the same physical file), so
 * this is a "does primaryPath / the db-pointed file still read cleanly" existence check for them, not a
 * genuine independent-content check — expected and unavoidable in a single-file world, not special-cased.
 */
function classifyAnchorComparison(
  session: ReadoutSession,
  source: ResumeSource,
  parsed: ReadonlyMap<string, ParsedEntry> | undefined,
  db: CodexStateDb | null
): { status: AnchorComparisonStatus } {
  const recovery = source === 'codex' ? codexRecoverySide(session, parsed, db) : claudeRecoverySide(session, parsed)
  if (recovery.kind === 'not-comparable') return { status: 'not-comparable' }
  if (recovery.kind === 'would-404') return { status: 'would-404' }
  if (recovery.kind === 'cannot-verify') return { status: 'cannot-verify' }
  const display = resolveDisplaySide(session, parsed)
  if (!display) return { status: 'not-comparable' } // 恢复侧 read fine, but nothing in session.paths could stand in for 展示侧
  const base = classifyResumeAnchors({ expected: recovery.anchors, target: display })
  if (base === 'match' || base === 'skipped') return { status: 'match' }
  const updatedAtMs = session.updatedAt ? Date.parse(session.updatedAt) : NaN
  const displayMs = display.lastTimestamp ? Date.parse(display.lastTimestamp) : NaN
  const cacheLag = Number.isFinite(updatedAtMs) && Number.isFinite(displayMs) && displayMs > updatedAtMs
  return { status: cacheLag ? 'cache-lag' : 'mismatch' }
}

// —— per-source tally ——

interface ResumeTally {
  total: number
  recoverable: number
  missingFile: number
  missingFilePaths: string[]
  missingDirectory: number
  missingDirectoryPaths: string[]
  unsupported: number
  commandSampled: number
  commandFound: number
  commandBrokenSymlink: number
  commandBrokenSymlinkIds: string[]
  commandMissing: number
  commandMissingIds: string[]
  commandSyntaxInvalid: number
  commandSyntaxInvalidIds: string[]
  anchorCompared: number
  anchorMatch: number
  anchorMismatch: number
  anchorMismatchIds: string[]
  anchorWould404: number
  anchorWould404Ids: string[]
  // C2c-3
  anchorCacheLag: number
  anchorCacheLagIds: string[]
  anchorCannotVerify: number
  anchorCannotVerifyIds: string[]
  /** Every session the seeded/most-active pick actually chose this run (task book H1; C2c 独立验收 P2-1 — reported so the sampling seed's "same day -> same batch" claim is checkable), independent of whether a command-layer probe was injected to act on it. */
  sampledSessionIds: string[]
}

function emptyTally(): ResumeTally {
  return {
    total: 0, recoverable: 0, missingFile: 0, missingFilePaths: [], missingDirectory: 0, missingDirectoryPaths: [],
    unsupported: 0, commandSampled: 0, commandFound: 0, commandBrokenSymlink: 0, commandBrokenSymlinkIds: [],
    commandMissing: 0, commandMissingIds: [], commandSyntaxInvalid: 0, commandSyntaxInvalidIds: [],
    anchorCompared: 0, anchorMatch: 0, anchorMismatch: 0, anchorMismatchIds: [], anchorWould404: 0, anchorWould404Ids: [],
    anchorCacheLag: 0, anchorCacheLagIds: [], anchorCannotVerify: 0, anchorCannotVerifyIds: [], sampledSessionIds: []
  }
}

function probeInput(session: ReadoutSession, source: ResumeSource): ResumeProbeInput {
  return {
    sessionId: session.sessionId,
    source,
    resumeCwd: session.resumeCwd,
    permissionMode: session.permissionMode,
    claudeConfigDir: session.claudeConfigDir,
    filePath: session.primaryPath ?? '',
    allFilePaths: session.paths,
    canResumeLocal: session.canResumeLocal,
    resumeUnavailableReason: session.resumeUnavailableReason
  }
}

function tallyResumeSource(input: {
  ctx: CheckContext
  source: ResumeSource
  sessions: readonly ReadoutSession[]
  parsed: ReadonlyMap<string, ParsedEntry> | undefined
  nowMs: number
}): ResumeTally {
  const { ctx, source, sessions, parsed, nowMs } = input
  const tally = emptyTally()
  const graded = sessions.filter((session) => !session.virtual)
  tally.total = graded.length
  const evaluable: ReadoutSession[] = []
  for (const session of graded) {
    const bucket = classifyBucket(session)
    if (bucket === 'unsupported') { tally.unsupported++; continue }
    evaluable.push(session)
    if (bucket === 'missing-file') { tally.missingFile++; tally.missingFilePaths.push(session.sessionId); continue }
    if (bucket === 'missing-directory') { tally.missingDirectory++; tally.missingDirectoryPaths.push(session.sessionId) }
    else tally.recoverable++
    // L3 anchor: only for sessions whose primary file exists (a missing file is already the finding above;
    // re-deriving 'would-404' from the very same fresh existsNow() check would just repeat it).
    const { status } = classifyAnchorComparison(session, source, parsed, ctx.codexDb)
    if (status === 'not-comparable') continue
    tally.anchorCompared++
    if (status === 'match') tally.anchorMatch++
    else if (status === 'would-404') { tally.anchorWould404++; tally.anchorWould404Ids.push(session.sessionId) }
    else if (status === 'cache-lag') { tally.anchorCacheLag++; tally.anchorCacheLagIds.push(session.sessionId) }
    else if (status === 'cannot-verify') { tally.anchorCannotVerify++; tally.anchorCannotVerifyIds.push(session.sessionId) }
    else { tally.anchorMismatch++; tally.anchorMismatchIds.push(session.sessionId) }
  }
  // Sampling (task book H1) is independent of whether a command-layer probe is injected: the *choice* of
  // sample must be reproducible and reportable (resumeSampling below) even for a shell that owns no resume
  // command at all (design §3.4, e.g. the AI diary) — only *acting* on the sample needs a probe.
  const sample = chooseSample(evaluable, ctx.resumeSample.seed, ctx.resumeSample.perSource, nowMs)
  tally.sampledSessionIds = sample.map((session) => session.sessionId)
  if (!ctx.resumeProbe) return tally
  const probe = ctx.resumeProbe
  const program = RESUME_PROGRAM[source]
  for (const session of sample) {
    const built = probe.build(probeInput(session, source))
    if ('refused' in built) continue // canResumeLocal===false is already 'unsupported' above; nothing else refuses claude/codex
    tally.commandSampled++
    const status = locateProgram(program, probe.pathEnv)
    if (status === 'found') tally.commandFound++
    else if (status === 'broken-symlink') { tally.commandBrokenSymlink++; tally.commandBrokenSymlinkIds.push(session.sessionId) }
    else { tally.commandMissing++; tally.commandMissingIds.push(session.sessionId) }
    if (!zshSyntaxOk(built.command)) { tally.commandSyntaxInvalid++; tally.commandSyntaxInvalidIds.push(session.sessionId) }
  }
  return tally
}

function buildSourceEntry(ctx: CheckContext, source: ResumeSource, tally: ResumeTally, findings: Finding[]): SourceEntry {
  const evaluated = tally.total - tally.unsupported
  const sourceFindings: Finding[] = []
  if (tally.missingFile > 0) {
    sourceFindings.push(makeFinding({
      code: 'resume.file-missing', verdict: 'fail', source,
      count: derived(tally.missingFile, 'sessions'), samples: sampleIds(ctx.salt, tally.missingFilePaths)
    }))
  }
  if (tally.missingDirectory > 0) {
    sourceFindings.push(makeFinding({
      code: 'resume.directory-missing', verdict: 'warn', source,
      count: derived(tally.missingDirectory, 'sessions'), samples: sampleIds(ctx.salt, tally.missingDirectoryPaths)
    }))
  }
  if (tally.anchorMismatch > 0) {
    sourceFindings.push(makeFinding({
      code: 'resume.anchor-mismatch', verdict: 'fail', source,
      count: derived(tally.anchorMismatch, 'sessions'), samples: sampleIds(ctx.salt, tally.anchorMismatchIds)
    }))
  }
  if (tally.anchorWould404 > 0) {
    sourceFindings.push(makeFinding({
      code: 'resume.file-missing', verdict: 'fail', source,
      count: derived(tally.anchorWould404, 'sessions'), samples: sampleIds(ctx.salt, tally.anchorWould404Ids)
    }))
  }
  if (tally.anchorCacheLag > 0) {
    sourceFindings.push(makeFinding({
      code: 'resume.anchor-cache-lag', verdict: 'warn', source,
      count: derived(tally.anchorCacheLag, 'sessions'), samples: sampleIds(ctx.salt, tally.anchorCacheLagIds)
    }))
  }
  if (tally.anchorCannotVerify > 0) {
    sourceFindings.push(makeFinding({
      code: 'resume.anchor-cannot-verify', verdict: 'warn', source,
      count: derived(tally.anchorCannotVerify, 'sessions'), samples: sampleIds(ctx.salt, tally.anchorCannotVerifyIds)
    }))
  }
  if (tally.commandBrokenSymlink > 0) {
    sourceFindings.push(makeFinding({
      code: 'resume.program-broken-symlink', verdict: 'warn', source,
      count: derived(tally.commandBrokenSymlink, 'sessions'), samples: sampleIds(ctx.salt, tally.commandBrokenSymlinkIds)
    }))
  }
  if (tally.commandMissing > 0) {
    sourceFindings.push(makeFinding({
      code: 'resume.program-not-found', verdict: 'warn', source,
      count: derived(tally.commandMissing, 'sessions'), samples: sampleIds(ctx.salt, tally.commandMissingIds)
    }))
  }
  if (tally.commandSyntaxInvalid > 0) {
    sourceFindings.push(makeFinding({
      code: 'resume.command-syntax-invalid', verdict: 'fail', source,
      count: derived(tally.commandSyntaxInvalid, 'sessions'), samples: sampleIds(ctx.salt, tally.commandSyntaxInvalidIds)
    }))
  }
  findings.push(...sourceFindings)

  // No fixed threshold beyond "pass": sourceVerdict() takes the worst of the findings' own verdicts (each
  // already fail/warn per its own class, design's env-vs-data/anchor split), same pattern as ④'s Claude side.
  const threshold: Verdict = 'pass'
  const commandLayer = !ctx.resumeProbe
    ? {
        commandSampled: unavailable('sessions', 'resume.probe-not-injected'),
        commandFound: unavailable('sessions', 'resume.probe-not-injected'),
        commandBrokenSymlink: unavailable('sessions', 'resume.probe-not-injected'),
        commandMissing: unavailable('sessions', 'resume.probe-not-injected'),
        commandSyntaxInvalid: unavailable('sessions', 'resume.probe-not-injected')
      }
    : {
        commandSampled: reported(tally.commandSampled, 'sessions'),
        commandFound: derived(tally.commandFound, 'sessions'),
        commandBrokenSymlink: derived(tally.commandBrokenSymlink, 'sessions'),
        commandMissing: derived(tally.commandMissing, 'sessions'),
        commandSyntaxInvalid: derived(tally.commandSyntaxInvalid, 'sessions')
      }
  return {
    verdict: sourceVerdict(threshold, sourceFindings, source),
    swob: {
      recoverable: derived(tally.recoverable, 'sessions'),
      missingFile: derived(tally.missingFile, 'sessions'),
      missingDirectory: derived(tally.missingDirectory, 'sessions'),
      unsupportedSource: derived(tally.unsupported, 'sessions'),
      recoverableRate: percentMeasure(tally.recoverable, evaluated),
      ...commandLayer,
      anchorCompared: derived(tally.anchorCompared, 'sessions'),
      anchorMatch: derived(tally.anchorMatch, 'sessions'),
      anchorMismatch: derived(tally.anchorMismatch, 'sessions'),
      anchorCacheLag: derived(tally.anchorCacheLag, 'sessions'),
      anchorCannotVerify: derived(tally.anchorCannotVerify, 'sessions')
    },
    oracle: { sessions: reported(tally.total, 'sessions') },
    oracleIds: ['fs.local-environment']
  }
}

export function resumeCheck(ctx: CheckContext): ReturnType<typeof assembleCheck> {
  const bySource: Record<string, SourceEntry> = {}
  const findings: Finding[] = []
  const evaluated = new Set<string>()
  const nowMs = Date.now()
  let headlineTotal = 0
  let headlineProblems = 0
  // Only claude-code/codex are graded by this check (task book: "Claude、Codex 有结论"); Cursor is added
  // to `evaluated` below purely to stop remainingSources() also computing an entry for it (see the
  // override's own comment), so it must not inflate the headline's "how many sources" count.
  let gradedSourceCount = 0
  // C2c-3 (report appendix): every session either source's sample actually chose this run, across both
  // sources, before salting/capping — so "same local day -> same batch" is checkable (task book H1 / C2c
  // 独立验收 P2-1).
  const sampledSessionIds: string[] = []

  if (hasClaudeData(ctx) && ctx.claude) {
    evaluated.add('claude-code')
    gradedSourceCount++
    if (ctx.readout.status !== 'ok') {
      bySource['claude-code'] = { verdict: 'undetermined', swob: { status: unavailable('checks', ctx.readout.reason ?? 'readout.not-isolated') }, oracle: {}, oracleIds: ['fs.local-environment'] }
    } else {
      const sessions = ctx.readout.sessions.filter((session) => session.source === 'claude-code')
      const tally = tallyResumeSource({ ctx, source: 'claude-code', sessions, parsed: ctx.readout.claudeParsed, nowMs })
      const entry = buildSourceEntry(ctx, 'claude-code', tally, findings)
      bySource['claude-code'] = entry
      headlineTotal += tally.total - tally.unsupported
      if (entry.verdict === 'warn' || entry.verdict === 'fail') headlineProblems++
      sampledSessionIds.push(...tally.sampledSessionIds)
    }
  }
  if (hasCodexData(ctx) && ctx.codex) {
    evaluated.add('codex')
    gradedSourceCount++
    if (ctx.readout.status !== 'ok') {
      bySource.codex = { verdict: 'undetermined', swob: { status: unavailable('checks', ctx.readout.reason ?? 'readout.not-isolated') }, oracle: {}, oracleIds: ['fs.local-environment'] }
    } else {
      const sessions = ctx.readout.sessions.filter((session) => session.source === 'codex')
      const tally = tallyResumeSource({ ctx, source: 'codex', sessions, parsed: ctx.readout.codexParsed, nowMs })
      const entry = buildSourceEntry(ctx, 'codex', tally, findings)
      bySource.codex = entry
      headlineTotal += tally.total - tally.unsupported
      if (entry.verdict === 'warn' || entry.verdict === 'fail') headlineProblems++
      sampledSessionIds.push(...tally.sampledSessionIds)
    }
  }
  // Cursor: forced not-applicable (task book — this check's infrastructure is Claude/Codex-only; see file
  // header) whenever Cursor actually has data to consider. When this machine has no Cursor data at all,
  // the generic 'source.no-data' verdict (same as every other check shows for an absent source in this
  // row) is kept instead — Cursor's own terminal-resume capability is broadly 'available' elsewhere in
  // the app, so without this override the generic path would show 'undetermined', not 'not-applicable'.
  // OpenCode/ZCode/others: the generic capability-table path (task book "按能力表").
  if (ctx.selected.has('cursor')) {
    evaluated.add('cursor')
    const base = applicability('cursor', 'resume', ctx)
    bySource.cursor = base.reason === 'source.no-data'
      ? applicabilityEntry(base.verdict, base.reason)
      : applicabilityEntry('not-applicable', 'source.capability-unavailable')
  }
  Object.assign(bySource, remainingSources('resume', ctx, evaluated))
  const headline = headlineProblems === 0 ? 'resume.pass' : 'resume.problems'
  const headlineNumbers = headlineProblems === 0 ? [headlineTotal] : [gradedSourceCount, headlineProblems]
  const result = assembleCheck({ id: 'resume', bySource, findings, headline, headlineNumbers })
  if (ctx.readout.status !== 'ok') result.reason = ctx.readout.reason ?? 'readout.not-isolated'
  // C2c-3 (task book H1 / C2c 独立验收 P2-1): disclose the local day the seed was computed from (== the
  // seed itself in production, see contract.ts#resumeSampling) regardless of whether any session was
  // actually sampled this run (e.g. readout not isolated, or neither source has data) — it is still
  // meaningful on its own.
  const { date, offsetMinutes } = localDateAndOffset()
  result.resumeSampling = { localDate: date, timezoneOffsetMinutes: offsetMinutes, sampledIds: sampleIds(ctx.salt, sampledSessionIds) }
  return result
}
