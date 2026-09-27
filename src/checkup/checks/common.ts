/** Shared helpers for the checkup checks (pure: no filesystem, no kernel). */
import type {
  CheckId,
  CheckResult,
  Finding,
  Label,
  Measure,
  ReasonCode,
  SourceId,
  Verdict
} from '../contract'
import { SOURCE_IDS } from '../contract'
import { FINDING_TEXT, HEADLINES, OWNER_ACTIONS, fillTemplate } from '../templates'
import { builtinProviderForSource, providerUsesCanonicalRuntime } from '../../shared/provider-capabilities'
import type { ClaudeCensus } from '../census/claude-census'
import type { CodexCensus } from '../census/codex-census'
import type { CodexStateDb } from '../census/codex-state-db'
import type { SourcePresence } from '../census/source-roots'
import type { UnscannedRootsCensus } from '../census/unscanned-roots'
import type { ReadoutSession, SwobReadout } from '../readout'
import { saltedId } from '../privacy'

export interface CheckContext {
  salt: string
  selected: ReadonlySet<string>
  claude: ClaudeCensus | null
  codex: CodexCensus | null
  codexDb: CodexStateDb | null
  unscanned: UnscannedRootsCensus | null
  presence: readonly SourcePresence[]
  readout: SwobReadout
  /** Real paths of census units that changed during the run or became unreadable. */
  changed: ReadonlySet<string>
}

export type SourceEntry = CheckResult['bySource'][string]

export function measure(value: number | null, label: Label, unit: string, reason?: string): Measure {
  return reason ? { value, label, unit, reason } : { value, label, unit }
}
export const reported = (value: number, unit: string, reason?: string): Measure => measure(value, 'reported', unit, reason)
export const derived = (value: number, unit: string, reason?: string): Measure => measure(value, 'derived', unit, reason)
export const unavailable = (unit: string, reason: ReasonCode): Measure => measure(null, 'unavailable', unit, reason)

/** Percentage with three decimals; null when the denominator is zero. */
export function percent(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null
  return Math.round((numerator / denominator) * 100_000) / 1000
}

export function percentMeasure(numerator: number, denominator: number, reason?: ReasonCode): Measure {
  const value = percent(numerator, denominator)
  return value === null ? unavailable('percent', reason ?? 'census.not-implemented') : derived(value, 'percent')
}

const RANK: Record<Verdict, number> = { pass: 1, warn: 2, fail: 3, undetermined: 0, 'not-applicable': 0 }

/** Worst of pass/warn/fail; not-applicable and undetermined do not take part (design §3.3). */
export function worstVerdict(verdicts: readonly Verdict[]): Verdict {
  const graded = verdicts.filter((verdict) => RANK[verdict] > 0)
  if (graded.length > 0) return graded.reduce((worst, verdict) => RANK[verdict] > RANK[worst] ? verdict : worst)
  if (verdicts.length > 0 && verdicts.every((verdict) => verdict === 'not-applicable')) return 'not-applicable'
  return 'undetermined'
}

export function sampleIds(salt: string, paths: Iterable<string>, limit = 5): string[] {
  const ids = new Set<string>()
  for (const filePath of paths) ids.add(saltedId(salt, `unit:${filePath}`))
  return [...ids].sort().slice(0, limit)
}

export function makeFinding(input: {
  code: ReasonCode
  verdict: Finding['verdict']
  source: string
  count: Measure
  numbers?: number[]
  samples?: string[]
}): Finding {
  const text = FINDING_TEXT[input.code]
  if (!text) throw new Error(`no registered text for finding ${input.code}`)
  return {
    code: input.code,
    verdict: input.verdict,
    source: input.source,
    count: input.count,
    ownerLine: fillTemplate(text.ownerLine, input.numbers ?? [input.count.value ?? 0], input.source),
    engineerHint: fillTemplate(text.engineerHint, [], input.source),
    samples: (input.samples ?? []).slice(0, 5)
  }
}

/** Capability consulted for "not applicable" per check (design §3.3, provider-capabilities.ts:769). */
const CHECK_CAPABILITY: Record<CheckId, string | null> = {
  inclusion: 'discover',
  content: 'transcript',
  compaction: null,
  lineage: 'relationships',
  tokens: 'usage',
  resume: 'terminal-resume'
}

/** Verdict + reason for a source that C1a does not evaluate for this check. */
export function applicability(
  source: SourceId,
  check: CheckId,
  ctx: Pick<CheckContext, 'presence' | 'selected'>,
  implementedReason: ReasonCode = 'source.not-implemented'
): { verdict: Verdict; reason: ReasonCode } {
  if (!ctx.selected.has(source)) return { verdict: 'not-applicable', reason: 'source.not-selected' }
  const capability = CHECK_CAPABILITY[check]
  if (capability) {
    const capabilities = builtinProviderForSource(source)?.manifest.capabilities as Record<string, { status?: string }> | undefined
    const status = capabilities?.[capability]?.status
    if (status === 'unavailable' || status === 'not-applicable') {
      return { verdict: 'not-applicable', reason: 'source.capability-unavailable' }
    }
  }
  const present = ctx.presence.find((entry) => entry.source === source)?.present ?? false
  if (!present) return { verdict: 'not-applicable', reason: 'source.no-data' }
  if (providerUsesCanonicalRuntime(source)) return { verdict: 'undetermined', reason: 'readout.provider-host-not-parsed-readonly' }
  return { verdict: 'undetermined', reason: implementedReason }
}

export function applicabilityEntry(verdict: Verdict, reason: ReasonCode): SourceEntry {
  return { verdict, swob: { status: unavailable('checks', reason) }, oracle: {}, oracleIds: [] }
}

/** Entries for every source not in `evaluated`. */
export function remainingSources(
  check: CheckId,
  ctx: Pick<CheckContext, 'presence' | 'selected'>,
  evaluated: ReadonlySet<string>,
  implementedReason?: ReasonCode
): Record<string, SourceEntry> {
  const entries: Record<string, SourceEntry> = {}
  for (const source of SOURCE_IDS) {
    if (evaluated.has(source)) continue
    const { verdict, reason } = applicability(source, check, ctx, implementedReason)
    entries[source] = applicabilityEntry(verdict, reason)
  }
  return entries
}

export function orderedBySource(entries: Record<string, SourceEntry>): Record<string, SourceEntry> {
  const ordered: Record<string, SourceEntry> = {}
  for (const source of SOURCE_IDS) if (entries[source]) ordered[source] = entries[source]
  for (const [source, entry] of Object.entries(entries)) if (!ordered[source]) ordered[source] = entry
  return ordered
}

export function assembleCheck(input: {
  id: CheckId
  bySource: Record<string, SourceEntry>
  findings: Finding[]
  headline: keyof typeof HEADLINES
  headlineNumbers?: number[]
  reason?: ReasonCode
}): CheckResult {
  const bySource = orderedBySource(input.bySource)
  const verdict = worstVerdict(Object.values(bySource).map((entry) => entry.verdict))
  const headlineKey = verdict === 'undetermined' && input.headline !== 'check.not-implemented'
    ? 'check.undetermined'
    : verdict === 'not-applicable' ? 'check.not-applicable' : input.headline
  const result: CheckResult = {
    id: input.id,
    verdict,
    headline: fillTemplate(HEADLINES[headlineKey], headlineKey === input.headline ? input.headlineNumbers ?? [] : []),
    ownerAction: OWNER_ACTIONS[verdict],
    bySource,
    findings: input.findings
  }
  if (input.reason) result.reason = input.reason
  return result
}

/** A census source is evaluated only when at least one of its roots exists (else: no data → not applicable). */
export function hasClaudeData(ctx: Pick<CheckContext, 'claude' | 'selected'>): boolean {
  return ctx.selected.has('claude-code') && !!ctx.claude && ctx.claude.roots.length > 0
}
export function hasCodexData(ctx: Pick<CheckContext, 'codex' | 'selected'>): boolean {
  return ctx.selected.has('codex') && !!ctx.codex && ctx.codex.roots.length > 0
}

/** Verdict of one evaluated source: threshold verdict worsened by its findings. */
export function sourceVerdict(threshold: Verdict, findings: readonly Finding[], source: string): Verdict {
  return worstVerdict([threshold, ...findings.filter((finding) => finding.source === source).map((finding) => finding.verdict)])
}

/**
 * Codex thread-spawn edges (state db `thread_spawn_edges`) reconciled against the Swob readout. Shared by
 * ① (inclusion.ts codexReconciliation, unchanged behaviour: it only ever reads `attachedAnywhere` /
 * `childInCensus`) and ④ (checks/lineage.ts, which also needs the parent-matched count and the Swob-extra
 * side: ①'s own reconciliation never had a second implementation to diff against, so this is the stronger
 * check C2b's review added instead).
 */
export interface CodexSpawnEdgeReconciliation {
  /** Edge count whose child appears in *some* session's subagentIds ("attached somewhere"; ①'s number). */
  attachedAnywhere: number
  /** Edge count whose child is present in the Codex census units at all (①'s number). */
  childInCensus: number
  /** Edge count whose child's Swob-recorded parent (subagents[].parentSessionId) equals the edge's own parent. */
  attachedToRecordedParent: number
  /** Swob subagent child ids (from every session's subagents[]) that no state-db edge lists as a child at all. */
  swobExtraChildIds: string[]
}

export function reconcileCodexSpawnEdges(
  edges: ReadonlyArray<{ parent: string; child: string }>,
  sessions: ReadonlyArray<Pick<ReadoutSession, 'subagentIds' | 'subagents'>>,
  censusIds: ReadonlySet<string>
): CodexSpawnEdgeReconciliation {
  const subagentIds = new Set(sessions.flatMap((session) => session.subagentIds))
  const parentByChild = new Map<string, string | null>()
  for (const session of sessions) {
    for (const subagent of session.subagents ?? []) {
      if (!parentByChild.has(subagent.sessionId)) parentByChild.set(subagent.sessionId, subagent.parentSessionId)
    }
  }
  const edgeChildIds = new Set(edges.map((edge) => edge.child))
  return {
    attachedAnywhere: edges.filter((edge) => subagentIds.has(edge.child)).length,
    childInCensus: edges.filter((edge) => censusIds.has(edge.child)).length,
    attachedToRecordedParent: edges.filter((edge) => parentByChild.get(edge.child) === edge.parent).length,
    swobExtraChildIds: [...parentByChild.keys()].filter((childId) => !edgeChildIds.has(childId))
  }
}
