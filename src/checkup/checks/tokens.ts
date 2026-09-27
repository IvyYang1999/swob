/**
 * ⑤ Token (C2a, design §四 4.5): Claude/Codex's own independent census-level recount
 * (`census/claude-census.ts#claudeRecountUsage`, `census/codex-census.ts#codexRecountB`) compared against
 * the kernel's own per-session ledger (`readout.ts`'s `ReadoutSession.tokens`), two ways:
 *   - source-level: the four components (non-cached input / cache read / output / reasoning; Claude also
 *     tracks cache write) summed across every session Swob listed, vs. the oracle's global dedup total.
 *   - session-level: per family (a Swob top-level session plus every unit it folded in — the same
 *     granularity `loadAllSessions()` reports at), all four components equal.
 * Cursor and every other source without usage data fall through to `remainingSources` (declared
 * `usage: unavailable` in the shared capability table), which reports them not-applicable, [U].
 */
import type { Finding, Verdict } from '../contract'
import { claudeRecountUsage, type ClaudeUnit } from '../census/claude-census'
import { codexRecountB, codexUnitParentId, codexUnitSessionId, type CodexUnit } from '../census/codex-census'
import { unavailableReadoutTokens, type ReadoutSession, type ReadoutSessionTokens } from '../readout'
import {
  assembleCheck,
  derived,
  hasClaudeData,
  hasCodexData,
  makeFinding,
  reported,
  remainingSources,
  sampleIds,
  unavailable,
  worstVerdict,
  type CheckContext,
  type SourceEntry
} from './common'

interface Components { nonCachedInput: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number }

function emptyComponents(): Components {
  return { nonCachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 }
}

function addInto(target: Components, source: Components): void {
  target.nonCachedInput += source.nonCachedInput
  target.cacheRead += source.cacheRead
  target.cacheWrite += source.cacheWrite
  target.output += source.output
  target.reasoning += source.reasoning
}

function billingTotalOf(components: Components): number {
  return components.nonCachedInput + components.cacheRead + components.cacheWrite + components.output
}

function componentsEqual(left: Components, right: Components): boolean {
  return left.nonCachedInput === right.nonCachedInput && left.cacheRead === right.cacheRead &&
    left.cacheWrite === right.cacheWrite && left.output === right.output && left.reasoning === right.reasoning
}

const PASS_PCT = 0.1
const NOTE_PCT = 1
const SESSION_MATCH_PCT = 99

/**
 * |swob − oracle| / oracle, in percent, after backing out `calibrationDeltaTokens` (a known, already
 * registered gap — task book: Claude's cache-write aggregate-vs-breakdown difference). `null` when the
 * oracle denominator is 0 and an unexplained remainder is left (swob is not 0 either): there is no ratio to
 * express, and the caller treats that the same as an over-threshold deviation.
 */
function adjustedDeviationPct(swob: number, oracle: number, calibrationDeltaTokens = 0): number | null {
  const remaining = Math.max(0, Math.abs(swob - oracle) - Math.max(0, calibrationDeltaTokens))
  if (oracle === 0) return remaining === 0 ? 0 : null
  return (remaining / Math.abs(oracle)) * 100
}

/** Signed, unadjusted percent for display; null under the same "no ratio to express" condition. */
function signedDeviationPct(swob: number, oracle: number): number | null {
  if (oracle === 0) return swob === 0 ? 0 : null
  return ((swob - oracle) / oracle) * 100
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

// —— per-session family grouping (Swob's own merge granularity; census units carry no notion of it) ——

/**
 * Codex units grouped by the top-level session Swob folded them into: walk each unit's session's parent
 * chain (`codexUnitParentId`, the same physical-evidence fields `session-loader.ts` itself follows) until
 * it reaches a session Swob actually listed. Mirrors F1b's family-scoped recompute (verified equal to the
 * global one on real data); units that never reach a listed session (should not happen once ④ is clean)
 * are simply not attributed to any family and only count toward the global oracle total.
 */
function codexFamilies(units: readonly CodexUnit[], listedTopLevel: ReadonlySet<string>): Map<string, CodexUnit[]> {
  const bySession = new Map<string, CodexUnit[]>()
  for (const unit of units) {
    const id = codexUnitSessionId(unit)
    if (!id) continue
    const list = bySession.get(id) ?? []
    list.push(unit)
    bySession.set(id, list)
  }
  const parentOf = (id: string): string | null => {
    for (const unit of bySession.get(id) ?? []) {
      const parentId = codexUnitParentId(unit)
      if (parentId) return parentId
    }
    return null
  }
  const familyCache = new Map<string, string | null>()
  const familyOfId = (id: string): string | null => {
    const cached = familyCache.get(id)
    if (cached !== undefined) return cached
    if (listedTopLevel.has(id)) {
      familyCache.set(id, id)
      return id
    }
    const visited = new Set<string>([id])
    let current = parentOf(id)
    let hops = 0
    while (current && hops++ < 64) {
      if (visited.has(current)) break
      if (listedTopLevel.has(current)) {
        familyCache.set(id, current)
        return current
      }
      visited.add(current)
      current = parentOf(current)
    }
    familyCache.set(id, null)
    return null
  }
  const families = new Map<string, CodexUnit[]>()
  for (const unit of units) {
    const id = codexUnitSessionId(unit)
    const family = id ? familyOfId(id) : null
    if (!family) continue
    const list = families.get(family) ?? []
    list.push(unit)
    families.set(family, list)
  }
  return families
}

/**
 * Claude units grouped by session. `ReadoutSession.subagentPaths` cannot be used for this: the kernel's
 * light/readOnly `buildSessionSummary` (session-loader.ts, the `light` branch) merges a subagent file's
 * messages into `tokenAccounting` directly but never populates `summary.subagents[]` there (that field is
 * only filled in the full, non-light build) — so under checkup's readOnly load it is always empty, for
 * every session, regardless of whether subagent files exist. Grouping here instead follows the same
 * physical-path convention the kernel itself locates subagents by (`findClaudeSubagentFilesNearMain`,
 * `<project>/<owner-session-id>/subagents/**`; census's own `ownerDirName`), independent of that gap.
 */
function claudeFamilies(units: readonly ClaudeUnit[], sessions: readonly ReadoutSession[]): Map<string, ClaudeUnit[]> {
  const byPath = new Map<string, ClaudeUnit>()
  for (const unit of units) byPath.set(unit.path, unit)
  const subagentsByOwner = new Map<string, ClaudeUnit[]>()
  for (const unit of units) {
    if (unit.kind !== 'claude-subagent' || !unit.ownerDirName) continue
    const list = subagentsByOwner.get(unit.ownerDirName) ?? []
    list.push(unit)
    subagentsByOwner.set(unit.ownerDirName, list)
  }
  const families = new Map<string, ClaudeUnit[]>()
  for (const session of sessions) {
    if (session.source !== 'claude-code' || session.virtual) continue
    const list: ClaudeUnit[] = []
    for (const filePath of session.paths) {
      const unit = byPath.get(filePath)
      if (unit) list.push(unit)
    }
    // A multi-file (continuation-shard) session's subagents can live under any of its shards' own ids,
    // not only the session's primary id.
    const owners = new Set([session.sessionId, ...list.map((unit) => unit.basenameId)])
    for (const owner of owners) for (const subagent of subagentsByOwner.get(owner) ?? []) list.push(subagent)
    families.set(session.sessionId, list)
  }
  return families
}

interface SessionTally {
  swobGlobal: Components
  sessionsCompared: number
  sessionsEqual: number
  mismatchSamples: string[]
  unavailableAsZero: number
  unavailableAsZeroSamples: string[]
  calibrationDeltaTokens: number
}

/** Walks every non-virtual session of `source`, comparing Swob's own tokens against that family's oracle. */
function tallySessions(input: {
  ctx: CheckContext
  source: string
  familyOracle: (sessionId: string) => Components
}): SessionTally {
  const result: SessionTally = {
    swobGlobal: emptyComponents(),
    sessionsCompared: 0,
    sessionsEqual: 0,
    mismatchSamples: [],
    unavailableAsZero: 0,
    unavailableAsZeroSamples: [],
    calibrationDeltaTokens: 0
  }
  for (const session of input.ctx.readout.sessions) {
    if (session.source !== input.source || session.virtual) continue
    const tokens: ReadoutSessionTokens = session.tokens ?? unavailableReadoutTokens()
    const oracle = input.familyOracle(session.sessionId)
    const oracleHasUsage = oracle.nonCachedInput + oracle.cacheRead + oracle.cacheWrite + oracle.output + oracle.reasoning > 0
    result.calibrationDeltaTokens += tokens.cacheWriteCalibrationDeltaTokens
    if (tokens.provenance === 'unavailable' || !tokens.components) {
      result.sessionsCompared++
      if (oracleHasUsage) {
        result.unavailableAsZero++
        result.unavailableAsZeroSamples.push(session.sessionId)
      } else {
        result.sessionsEqual++
      }
      continue
    }
    addInto(result.swobGlobal, tokens.components)
    result.sessionsCompared++
    if (componentsEqual(tokens.components, oracle)) result.sessionsEqual++
    else result.mismatchSamples.push(session.sessionId)
  }
  return result
}

interface MetricNumbers { swob: Components; swobBillingTotal: number; oracle: Components; oracleBillingTotal: number }

/** Worst (largest-magnitude) calibration-adjusted deviation among the four components + billing total. */
function worstAdjustedPct(numbers: MetricNumbers, calibrationDeltaTokens: number): number | null {
  const candidates = [
    adjustedDeviationPct(numbers.swob.nonCachedInput, numbers.oracle.nonCachedInput),
    adjustedDeviationPct(numbers.swob.cacheRead, numbers.oracle.cacheRead),
    adjustedDeviationPct(numbers.swob.cacheWrite, numbers.oracle.cacheWrite, calibrationDeltaTokens),
    adjustedDeviationPct(numbers.swob.output, numbers.oracle.output),
    adjustedDeviationPct(numbers.swob.reasoning, numbers.oracle.reasoning),
    adjustedDeviationPct(numbers.swobBillingTotal, numbers.oracleBillingTotal, calibrationDeltaTokens)
  ]
  if (candidates.some((value) => value === null)) return null
  return Math.max(...(candidates as number[]).map(Math.abs))
}

function sourceVerdictFor(input: { worst: number | null; sessionMatchPct: number; hasUnavailableAsZero: boolean }): Verdict {
  if (input.hasUnavailableAsZero) return 'fail'
  if (input.worst === null || input.worst > NOTE_PCT) return 'fail'
  if (input.worst > PASS_PCT || input.sessionMatchPct < SESSION_MATCH_PCT) return 'warn'
  return 'pass'
}

function componentMeasures(components: Components, billingTotal: number): Record<string, ReturnType<typeof derived>> {
  return {
    nonCachedInput: derived(components.nonCachedInput, 'tokens'),
    cacheRead: derived(components.cacheRead, 'tokens'),
    cacheWrite: derived(components.cacheWrite, 'tokens'),
    output: derived(components.output, 'tokens'),
    reasoning: derived(components.reasoning, 'tokens'),
    billingTotal: derived(billingTotal, 'tokens')
  }
}

function buildSourceEntry(input: {
  ctx: CheckContext
  source: 'claude-code' | 'codex'
  oracleGlobal: Components
  oracleUniqueFacts: number
  oracleId: 'census.claude-jsonl' | 'census.codex-jsonl'
  tally: SessionTally
  findings: Finding[]
}): SourceEntry {
  const { ctx, source, oracleGlobal, tally, findings } = input
  const swobBillingTotal = billingTotalOf(tally.swobGlobal)
  const oracleBillingTotal = billingTotalOf(oracleGlobal)
  const numbers: MetricNumbers = { swob: tally.swobGlobal, swobBillingTotal, oracle: oracleGlobal, oracleBillingTotal }
  const worst = worstAdjustedPct(numbers, tally.calibrationDeltaTokens)
  const sessionMatchPct = tally.sessionsCompared > 0 ? (tally.sessionsEqual / tally.sessionsCompared) * 100 : 100
  const verdict = sourceVerdictFor({ worst, sessionMatchPct, hasUnavailableAsZero: tally.unavailableAsZero > 0 })

  if (tally.unavailableAsZero > 0) {
    findings.push(makeFinding({
      code: 'tokens.swob-unavailable-as-zero', verdict: 'fail', source, count: reported(tally.unavailableAsZero, 'sessions'),
      samples: sampleIds(ctx.salt, tally.unavailableAsZeroSamples)
    }))
  }
  const rawBillingDeviation = signedDeviationPct(swobBillingTotal, oracleBillingTotal)
  // Reported unconditionally whenever present, whether or not it turns out to fully explain the remaining
  // deviation below (`worst` already has this backed out of the cache-write / billing-total metrics, so a
  // gap can be partially explained: some of it calibration, some of it a genuine remaining deviation).
  if (tally.calibrationDeltaTokens > 0) {
    findings.push(makeFinding({
      code: 'tokens.cache-write-calibration-difference', verdict: 'warn', source,
      count: derived(Math.round(tally.calibrationDeltaTokens), 'tokens')
    }))
  }
  if (worst !== null && worst > PASS_PCT) {
    findings.push(makeFinding({
      code: worst > NOTE_PCT ? 'tokens.deviation-high' : 'tokens.deviation-note',
      verdict: worst > NOTE_PCT ? 'fail' : 'warn', source,
      count: derived(round3(worst), 'percent'), numbers: [round3(worst)]
    }))
  } else if (worst === null) {
    // Oracle found none of some component while Swob reports some: no ratio to a zero denominator, but
    // unambiguously over threshold. Shown as a sentinel 100% rather than [U] — this is a real, large gap,
    // not a case where the source itself provides no usage data.
    findings.push(makeFinding({ code: 'tokens.deviation-high', verdict: 'fail', source, count: derived(100, 'percent'), numbers: [100] }))
  }
  if (tally.mismatchSamples.length > 0) {
    findings.push(makeFinding({
      code: 'tokens.session-mismatch', verdict: 'warn', source, count: derived(tally.mismatchSamples.length, 'sessions'),
      samples: sampleIds(ctx.salt, tally.mismatchSamples)
    }))
  }

  return {
    verdict,
    swob: {
      ...componentMeasures(tally.swobGlobal, swobBillingTotal),
      billingTotalDeviationPct: rawBillingDeviation === null ? derived(100, 'percent') : derived(round3(rawBillingDeviation), 'percent'),
      sessionsCompared: derived(tally.sessionsCompared, 'sessions'),
      sessionsEqual: derived(tally.sessionsEqual, 'sessions')
    },
    oracle: {
      ...componentMeasures(oracleGlobal, oracleBillingTotal),
      uniqueFacts: reported(input.oracleUniqueFacts, input.source === 'codex' ? 'snapshots' : 'records')
    },
    oracleIds: [input.oracleId]
  }
}

/** Codex's oracle never tracks cache write (task book: its four components are non-cached input / cache read / output / reasoning). */
function withZeroCacheWrite(components: { nonCachedInput: number; cacheRead: number; output: number; reasoning: number }): Components {
  return { ...components, cacheWrite: 0 }
}

function codexEntry(ctx: CheckContext, findings: Finding[]): SourceEntry {
  const census = ctx.codex!
  const eligible = census.units.filter((unit) => unit.isRollout && !unit.unreadable && !ctx.changed.has(unit.path))
  const oracle = codexRecountB(eligible)
  const oracleComponents = withZeroCacheWrite(oracle.components)
  if (ctx.readout.status !== 'ok') {
    return {
      verdict: 'undetermined',
      swob: { billingTotal: unavailable('tokens', ctx.readout.reason ?? 'readout.not-isolated') },
      oracle: { ...componentMeasures(oracleComponents, oracle.billingTotal), uniqueFacts: reported(oracle.uniqueSnapshots, 'snapshots') },
      oracleIds: ['census.codex-jsonl']
    }
  }
  const listedTopLevel = new Set(ctx.readout.sessions.filter((session) => session.source === 'codex' && !session.virtual).map((session) => session.sessionId))
  const families = codexFamilies(eligible, listedTopLevel)
  const tally = tallySessions({
    ctx, source: 'codex',
    familyOracle: (sessionId) => withZeroCacheWrite(codexRecountB(families.get(sessionId) ?? []).components)
  })
  return buildSourceEntry({
    ctx, source: 'codex', oracleGlobal: oracleComponents, oracleUniqueFacts: oracle.uniqueSnapshots,
    oracleId: 'census.codex-jsonl', tally, findings
  })
}

function claudeEntry(ctx: CheckContext, findings: Finding[]): SourceEntry {
  const census = ctx.claude!
  const eligible = census.units.filter((unit) => !unit.unreadable && !ctx.changed.has(unit.path) &&
    (unit.kind === 'claude-main' || unit.kind === 'claude-subagent'))
  const oracle = claudeRecountUsage(eligible)
  const oracleComponents: Components = { ...oracle.components, reasoning: 0 }
  if (ctx.readout.status !== 'ok') {
    return {
      verdict: 'undetermined',
      swob: { billingTotal: unavailable('tokens', ctx.readout.reason ?? 'readout.not-isolated') },
      oracle: { ...componentMeasures(oracleComponents, oracle.billingTotal), uniqueFacts: reported(oracle.uniqueRequests, 'records') },
      oracleIds: ['census.claude-jsonl']
    }
  }
  const families = claudeFamilies(eligible, ctx.readout.sessions)
  const tally = tallySessions({
    ctx, source: 'claude-code',
    familyOracle: (sessionId) => {
      const recount = claudeRecountUsage(families.get(sessionId) ?? [])
      return { ...recount.components, reasoning: 0 }
    }
  })
  return buildSourceEntry({
    ctx, source: 'claude-code', oracleGlobal: oracleComponents, oracleUniqueFacts: oracle.uniqueRequests,
    oracleId: 'census.claude-jsonl', tally, findings
  })
}

export function tokensCheck(ctx: CheckContext): ReturnType<typeof assembleCheck> {
  const bySource: Record<string, SourceEntry> = {}
  const findings: Finding[] = []
  const evaluated = new Set<string>()
  if (hasClaudeData(ctx) && ctx.claude) {
    evaluated.add('claude-code')
    bySource['claude-code'] = claudeEntry(ctx, findings)
  }
  if (hasCodexData(ctx) && ctx.codex) {
    evaluated.add('codex')
    bySource.codex = codexEntry(ctx, findings)
  }
  Object.assign(bySource, remainingSources('tokens', ctx, evaluated))
  const evaluatedVerdicts = [...evaluated].map((source) => bySource[source].verdict)
  const overall = worstVerdict(evaluatedVerdicts)
  const problemFindings = findings.filter((finding) => finding.verdict === 'warn' || finding.verdict === 'fail')
  const headline = overall === 'fail' ? 'tokens.mismatch' : overall === 'warn' ? 'tokens.note' : 'tokens.pass'
  const headlineNumbers = overall === 'pass' ? [evaluated.size] : [evaluated.size, problemFindings.length]
  return assembleCheck({ id: 'tokens', bySource, findings, headline, headlineNumbers })
}
