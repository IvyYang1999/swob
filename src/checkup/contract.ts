/**
 * Kernel checkup report contract (KernelCheckupReport.v1).
 *
 * The §6.1 interface of the design (调研/内核体检报告设计-2026-09-26.md) is kept
 * verbatim; every C1a addition is an optional field and is listed in the
 * package decisions. This module is types + frozen registries only: it has no
 * runtime import, so the census closure may depend on it.
 */
import type { SessionSummary } from '../main/types'

// —— §6.1 contract (shells depend on this part only) ——
export type Label = 'reported' | 'derived' | 'estimated' | 'unavailable' // same words as TokenProvenance
export type Verdict = 'pass' | 'warn' | 'fail' | 'not-applicable' | 'undetermined'
export type CheckId = 'inclusion' | 'content' | 'compaction' | 'lineage' | 'tokens' | 'resume'

export interface Measure { value: number | null; label: Label; unit: string; reason?: string } // reason required for unavailable / estimated
export interface Finding {
  code: string                 // stable reason code, e.g. 'content.line-separator-split'
  verdict: Exclude<Verdict, 'pass'>
  source: string
  count: Measure
  ownerLine: string            // one sentence for the owner
  engineerHint: string         // locator for engineers (file#function)
  samples: string[]            // salted 8-hex sample ids, at most 5
}
export interface CheckResult {
  id: CheckId; verdict: Verdict; headline: string; ownerAction: string
  bySource: Record<string, { verdict: Verdict; swob: Record<string, Measure>; oracle: Record<string, Measure>; oracleIds: string[] }>
  findings: Finding[]
  /** C1a addition: reason code when the whole check is undetermined / not applicable. */
  reason?: string
}
export interface CheckupReport {
  schemaVersion: 1
  generatedAt: string
  scope: { kind: 'all' | 'day' | 'range'; day?: string; since?: string; until?: string }
  kernel: { version: string; commit: string | null; readOnly: true; checkupVersion: string; selfTest: { passed: number; total: number } }
  machine: { platform: string; hostHash: string; nodeVersion: string }
  verdict: Verdict
  checks: CheckResult[]                                       // always 6, fixed order
  inventory: Array<{ source: string; root: string; units: Measure; bytes: Measure; timeRange: [string | null, string | null]; scannedBySwob: boolean }>
  oracles: Array<{ id: string; available: boolean; reason?: string; version?: string }>
  library?: { root: string; packages: Measure; lastWriteAt: string | null; missingLive: Measure; staleLive: Measure }
  timingsMs: Record<string, number>
  // —— C1a additions (all optional) ——
  /**
   * First 8 hex of sha256(salt). The salt comes from the machine identifier (never the hostname) and is
   * never reported; comparisons (C1b --compare) check this first, since ids/unitSig only match under one salt.
   */
  saltFingerprint?: string
  /** Reason code when `verdict` is undetermined (e.g. checkup.self-test-failed). */
  verdictReason?: string
  /** Per self-test fault class outcome; ids are SELF_TEST_CASES. */
  selfTestCases?: Array<{ id: string; passed: boolean }>
  /** Swob readout status (fail-closed isolation guard). */
  readout?: { status: 'ok' | 'undetermined'; reason?: string }
  /** Per physical unit results; `unitSig` = hash(salted path id + mtime + size) for run-to-run comparison. */
  units?: CheckupUnit[]
  /** Known, recorded side effects (never counted as failures), e.g. SQLite WAL sidecars. */
  sideEffects?: Array<{ code: string; source: string; count: Measure }>
  /** Numeric run diagnostics only. */
  diagnostics?: Record<string, number>
  // —— C1b additions (all optional) ——
  /**
   * Sessions the Swob readout returned per source (intra-file branch views not counted). [R] when read;
   * unavailable when the readout did not run, or for a provider-host source that read-only mode does not parse.
   */
  readoutBySource?: Record<string, { sessions: Measure }>
}

export interface CheckupUnit {
  id: string                    // salted 8-hex id of the unit's real path
  unitSig: string               // salted 8-hex hash of (id, mtimeMs, size) at census time
  source: string
  kind: UnitKind
  bucket: InclusionBucket | null   // null when changed during the run or not evaluated
  reason?: string
  changed: boolean
  records: { nonBlank: number; bad: number; parseable: number; lineSeparator: number; truncatedTail: number }
  swobRead: number | null       // per-file Swob read count when the kernel exposes one ([R]); null otherwise
}

// —— entry ——
export interface CheckupOptions {
  homeDir?: string                        // default runtimeHome()
  /**
   * One-shot state directory owned by the caller (S1 P2b injection point).
   * C1a semantics: the checkup only removes what it created inside it and
   * never deletes the directory itself.
   */
  stateDir: string
  scope?: CheckupReport['scope']          // AI diary passes { kind: 'day', day }
  mode?: 'full' | 'quick'                 // quick: only files changed inside scope
  sources?: string[]                      // default: all 14 sources
  resumeProbe?: ResumeProbe               // injected by desktop app / CLI; not by the AI diary
  resumeSample?: { perSource: number; seed: string }   // default 4 per source / today's date
  libraryRoot?: string | null             // only when given, the library appendix is produced
  signal?: AbortSignal
  // —— C1a additions (optional) ——
  kernelVersion?: string                  // e.g. package.json version of the kernel checkout
  kernelCommit?: string | null            // git commit of the kernel checkout
  /** Salt for sample ids; derived from the machine identifier when omitted. Never persisted or reported. */
  privacySalt?: string
  /** Parent directory for self-test samples; must be inside stateDir. Default: a fresh directory in stateDir. */
  selfTestDir?: string
}
export interface ResumeProbe {
  build(session: SessionSummary): { command: string } | { refused: string }
  pathEnv: string                         // login shell PATH
}

// —— frozen registries (privacy whitelist sources) ——
export const CHECK_ORDER: readonly CheckId[] = ['inclusion', 'content', 'compaction', 'lineage', 'tokens', 'resume']
/**
 * Version of the report semantics (kernel.checkupVersion); compared reports with different versions are
 * flagged. 1.0.0: C1a. 1.1.0: C1b-1 — Claude subagent read counts measured with parseSessionFile [R]
 * instead of inferred, readoutBySource, readout.source-empty findings under ①.
 * 1.2.0: C1c — Codex read counts measured per file with parseCodexFileWithStats [R] (units carry
 * swobRead) and Claude reads through parseSessionFileWithStats (truncated → partial); a file without a
 * read count is left out and listed (content.swob-read-error), never inferred. ③ Codex: a multi-copy
 * session whose count equals one copy is explained (compaction.multi-copy-explained, warn), the
 * per-session count follows the kernel's per-file rule (known differences listed as
 * codex.compaction-rule-difference) and legacy-unrecognized needs a Swob count of 0. A --sources run
 * marks unselected sources in readoutBySource and in the inventory rows with data (source.not-selected).
 */
export const CHECKUP_VERSION = '1.2.0'
export const SELF_TEST_TOTAL = 7

export const SOURCE_IDS = [
  'claude-code', 'codex', 'cursor', 'opencode', 'zcode', 'cc-mirror', 'antigravity',
  'grok', 'pi', 'kimi', 'hermes', 'qoder', 'trae', 'gemini'
] as const
export type SourceId = typeof SOURCE_IDS[number]

/** Sources that produce verdicts in C1a. */
export const C1A_SOURCES: readonly SourceId[] = ['claude-code', 'codex']

export type UnitKind =
  | 'claude-main' | 'claude-subagent' | 'claude-other'
  | 'codex-top-level' | 'codex-thread-spawn' | 'codex-guardian' | 'codex-subagent'
  | 'codex-unknown' | 'codex-non-rollout'

export type InclusionBucket = 'session' | 'merged' | 'excluded' | 'unsupported' | 'not-included'

export const UNIT_KINDS: readonly UnitKind[] = [
  'claude-main', 'claude-subagent', 'claude-other',
  'codex-top-level', 'codex-thread-spawn', 'codex-guardian', 'codex-subagent', 'codex-unknown', 'codex-non-rollout'
]
export const INCLUSION_BUCKETS: readonly InclusionBucket[] = ['session', 'merged', 'excluded', 'unsupported', 'not-included']

export const SELF_TEST_CASES = [
  'line-separator-split',
  'tool-bad-line',
  'truncated-tail',
  'codex-legacy-compacted',
  'fork-inherited-compaction',
  'fork-usage-copy',
  // C2b (④ lineage): a grandchild thread-spawn edge the Swob side never attaches.
  'lineage-grandchild-orphan'
] as const
export type SelfTestCaseId = typeof SELF_TEST_CASES[number]

export const MEASURE_UNITS = [
  'units', 'files', 'records', 'lines', 'sessions', 'markers', 'edges', 'threads',
  'snapshots', 'bytes', 'percent', 'ms', 'tokens', 'checks', 'dirs'
] as const

export const ORACLE_IDS = [
  'census.claude-jsonl',
  'census.codex-jsonl',
  'codex.state-db',
  'census.unscanned-roots',
  'census.source-presence'
] as const

/**
 * Fixed source roots that may appear in reports. They are templates, never
 * machine paths: user-specific segments are written as `*`.
 */
export const FIXED_ROOTS = [
  '~/.claude/projects',
  '~/.claude-window/*/projects',
  '~/.codex/sessions',
  '~/.codex/archived_sessions',
  '$CODEX_HOME/sessions',
  '$CODEX_HOME/archived_sessions',
  '<additional-codex-home>/sessions',
  '<additional-codex-home>/archived_sessions',
  '~/.codex',
  '~/.cursor/projects',
  '~/.local/share/opencode',
  '~/.zcode/cli/db',
  '~/.cc-mirror/*/projects',
  '~/.gemini/tmp',
  '~/.gemini/antigravity',
  '~/.gemini/antigravity-cli',
  '~/.gemini/antigravity-ide',
  '~/.grok/sessions',
  '~/.factory/sessions',
  '~/.pi/agent/sessions',
  '~/.kimi-code/sessions',
  '~/.hermes/sessions',
  '~/.qoder/projects',
  '~/.qoderwork/projects',
  '~/Library/Application Support/Trae/User',
  '~/Library/Application Support/Trae CN/User',
  '~/Library/Application Support/TRAE SOLO CN/User',
  '~/.kimi/sessions',
  '~/.zcode/v2'
] as const

/** Every stable reason code. Anything not registered here is rejected by the privacy scanner. */
export const REASON_CODES = [
  // census
  'census.file-changed-during-run',
  'census.lower-symlink',
  'census.unreadable',
  'census.not-implemented',
  // readout
  'readout.not-isolated',
  'readout.kernel-error',
  'readout.parse-timeout',
  'readout.provider-host-not-parsed-readonly',
  // content ②
  'content.line-separator-split',
  'content.tool-bad-line',
  'content.truncated-tail',
  'content.unexplained-loss',
  'content.swob-extra-records',
  'content.swob-per-file-unavailable',
  // C1c: a file without a kernel read count (the read threw, or it was not read): left out of ②, never inferred
  'content.swob-read-error',
  // compaction ③
  'codex.legacy-compacted-unrecognized',
  'compaction.count-mismatch',
  'compaction.fork-inherited-marker',
  // C1c: a multi-copy Codex session whose count equals one copy (warn); files where the kernel's
  // per-file counting rule differs from the census rows (known rule difference, not-applicable)
  'compaction.multi-copy-explained',
  'codex.compaction-rule-difference',
  // inclusion ①
  'inclusion.unexplained',
  'claude.no-conversation-records',
  'claude.subagent-no-conversation',
  'claude.subagent-orphan',
  'claude.subagent-owner-not-included',
  'claude.subagent-too-deep',
  'claude.unrecognized-jsonl-location',
  'claude.continuation-shard',
  'claude.subagent-attached',
  'codex.empty-session',
  'codex.nested-subagent-orphan',
  'codex.subagent-parent-missing',
  'codex.subagent-no-parent-id',
  'codex.child-usage-not-attributed',
  'codex.child-attached',
  'codex.non-rollout-file',
  'codex.no-session-id',
  'codex.duplicate-session-copy',
  'codex.rollout-not-in-thread-db',
  'codex.thread-rollout-missing',
  'codex.thread-rollout-outside-roots',
  'codex.thread-not-in-census',
  'codex.state-db-missing',
  'codex.state-db-unreadable',
  'unsupported.kimi-legacy-sessions',
  'unscanned.zcode-v2-tasks',
  // lineage ④ (C2b)
  'codex.derivation-edge-unexpressed',
  'codex.derivation-edge-swob-extra',
  'codex.fork-edge-unexpressed',
  'codex.fork-edge-swob-extra',
  'claude.continuation-edge-unexpressed',
  'claude.resume-fork-edge-unexpressed',
  'claude.branch-edge-swob-extra',
  // tokens ⑤ (census-level evidence only in C1a)
  'codex.fork-usage-copy',
  // source applicability
  'source.not-implemented',
  'source.no-data',
  'source.capability-unavailable',
  'source.not-selected',
  // checks / run
  'check.not-implemented',
  'checkup.self-test-failed',
  'checkup.scope-not-implemented',
  'checkup.no-verdict-checks',
  // side effects
  'sqlite.readonly-sidecar-touch',
  'sqlite.main-db-changed',
  // —— C1b additions ——
  // readout: a selected source has raw data but the readout returned no session (listed under ①, never grades it)
  'readout.source-empty',
  // run-to-run comparison refusals (never written into a report; shown in the rendered comparison)
  'compare.schema-mismatch',
  'compare.previous-no-fingerprint',
  'compare.current-no-fingerprint',
  'compare.fingerprint-mismatch',
  'compare.scope-mismatch'
] as const
export type ReasonCode = typeof REASON_CODES[number]

/** Enum-like string values allowed in reports (besides reason codes, sources, units and roots). */
export const REPORT_ENUMS = [
  'reported', 'derived', 'estimated', 'unavailable',
  'pass', 'warn', 'fail', 'not-applicable', 'undetermined',
  'inclusion', 'content', 'compaction', 'lineage', 'tokens', 'resume',
  'all', 'day', 'range', 'ok',
  'darwin', 'linux', 'win32',
  'kimi-legacy', 'zcode-v2'
] as const
