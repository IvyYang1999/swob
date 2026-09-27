/**
 * ⑥ Resume (dry run) (C2c, design §四 4.6). Only checks, never starts anything: no resume command is ever
 * executed, no `claude`/`codex`/`cursor`/… process is ever spawned. `zsh -n -c` is a syntax check only
 * (the `-n` flag reads but never executes).
 *
 * Two layers, both against every non-virtual Claude/Codex session (design "对全部会话干跑"):
 * - Data layer (kernel-independent, pure fs metadata): four buckets — recoverable / missing file /
 *   missing directory / unsupported source (`session.canResumeLocal === false`, e.g. an intra-file branch
 *   view or a remote-only session; never inferred, mirrors the kernel's own field).
 * - L3 content anchor: readout.ts already extracted and hashed the last user/assistant anchor of every
 *   file it read (`resumeAnchors`); this check only asks resume-verifier.ts's own classifier (via
 *   `classifyResumeAnchors`, whitelisted) whether the session's primary file's anchor still reads cleanly,
 *   and — for a session with more than one physical file (continuation shards, compaction copies) —
 *   whether it agrees with the other files Swob merged into the same session. Labelled [D], "非独立来源"
 *   (design/task book): v1 has no second, independently-implemented anchor extraction to diff against —
 *   both sides come from the same readout pass, so this catches "the files Swob grouped together disagree
 *   with each other" and "the primary file stopped reading cleanly since the readout ran", but not "Swob
 *   picked the wrong single file as primary when only one file exists". An independent implementation is
 *   deferred to C2d (task book).
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
import { classifyResumeAnchors, type ReadoutSession, type ResumeAnchorHashes, type ResumeAnchorMatchStatus } from '../readout'
import {
  applicability,
  applicabilityEntry,
  assembleCheck,
  derived,
  hasClaudeData,
  hasCodexData,
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

/**
 * Swob's own primaryPath anchor against every *other* file this session's own `paths` list groups under
 * it (continuation shards, compaction copies, …), so a genuine "Swob's primary pick disagrees with
 * another file it merged into the same session" divergence is a reachable outcome, not dead code — while
 * the common single-file session still degenerates to "does primaryPath still read cleanly" (the
 * documented v1 simplification: no cross-file *staleness* ordering, just cross-file *agreement*).
 */
function anchorStatusFor(session: ReadoutSession, parsed: ReadonlyMap<string, ParsedEntry> | undefined): ResumeAnchorMatchStatus | null {
  const primary = anchorLookup(session.primaryPath, parsed)
  if (primary === null) return null
  if (primary === 'unparseable') return classifyResumeAnchors({ expected: { lastUser: null, lastAssistant: null }, target: 'unparseable' })
  for (const otherPath of session.paths) {
    if (otherPath === session.primaryPath) continue
    const other = anchorLookup(otherPath, parsed)
    if (other === null || other === 'unparseable') continue
    const status = classifyResumeAnchors({ expected: primary, target: other })
    if (status !== 'match' && status !== 'skipped') return status
  }
  return classifyResumeAnchors({ expected: primary, target: primary })
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
}

function emptyTally(): ResumeTally {
  return {
    total: 0, recoverable: 0, missingFile: 0, missingFilePaths: [], missingDirectory: 0, missingDirectoryPaths: [],
    unsupported: 0, commandSampled: 0, commandFound: 0, commandBrokenSymlink: 0, commandBrokenSymlinkIds: [],
    commandMissing: 0, commandMissingIds: [], commandSyntaxInvalid: 0, commandSyntaxInvalidIds: [],
    anchorCompared: 0, anchorMatch: 0, anchorMismatch: 0, anchorMismatchIds: [], anchorWould404: 0, anchorWould404Ids: []
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
    const status = anchorStatusFor(session, parsed)
    if (status === null) continue
    tally.anchorCompared++
    if (status === 'match' || status === 'skipped') tally.anchorMatch++
    else if (status === 'would-404') { tally.anchorWould404++; tally.anchorWould404Ids.push(session.sessionId) }
    else { tally.anchorMismatch++; tally.anchorMismatchIds.push(session.sessionId) }
  }
  if (!ctx.resumeProbe) return tally
  const probe = ctx.resumeProbe
  const sample = chooseSample(evaluable, ctx.resumeSample.seed, ctx.resumeSample.perSource, nowMs)
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
      anchorMismatch: derived(tally.anchorMismatch, 'sessions')
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
  return result
}
