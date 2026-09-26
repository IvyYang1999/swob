/**
 * ④ lineage, ⑤ tokens, ⑥ resume are not implemented in C1a: each returns
 * `undetermined` (check.not-implemented) while still listing every source,
 * with capability-declared gaps shown as not applicable. ⑤ carries the
 * census-level evidence for forked usage copies (self-test class 6).
 */
import type { CheckId } from '../contract'
import { countForkUsageCopies } from '../census/codex-census'
import {
  applicability,
  applicabilityEntry,
  assembleCheck,
  hasCodexData,
  derived,
  type CheckContext,
  type SourceEntry
} from './common'
import { SOURCE_IDS } from '../contract'

export function pendingCheck(id: Extract<CheckId, 'lineage' | 'tokens' | 'resume'>, ctx: CheckContext): ReturnType<typeof assembleCheck> {
  const bySource: Record<string, SourceEntry> = {}
  for (const source of SOURCE_IDS) {
    const base = applicability(source, id, ctx, 'check.not-implemented')
    const implemented = source === 'claude-code' || source === 'codex'
    const verdict = base.verdict === 'not-applicable' ? 'not-applicable' : 'undetermined'
    const reason = base.verdict === 'not-applicable' ? base.reason : implemented ? 'check.not-implemented' : base.reason
    bySource[source] = applicabilityEntry(verdict, reason)
  }
  if (id === 'tokens' && hasCodexData(ctx) && ctx.codex) {
    const eligible = ctx.codex.units.filter((unit) => !unit.unreadable && !ctx.changed.has(unit.path))
    const copies = countForkUsageCopies(eligible)
    bySource.codex = {
      ...bySource.codex,
      oracle: {
        forkUsageCopies: derived(copies.rewritten, 'snapshots', 'codex.fork-usage-copy'),
        forkUsageCopiesSameTimestamp: derived(copies.sameTimestamp, 'snapshots'),
        forkChildFilesWithCopies: derived(copies.childUnits, 'files')
      },
      oracleIds: ['census.codex-jsonl']
    }
  }
  return assembleCheck({ id, bySource, findings: [], headline: 'check.not-implemented', reason: 'check.not-implemented' })
}
