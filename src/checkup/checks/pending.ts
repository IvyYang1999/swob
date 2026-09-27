/**
 * ④ lineage, ⑥ resume are not implemented yet (C2b/C2c): each returns `undetermined`
 * (check.not-implemented) while still listing every source, with capability-declared gaps shown as not
 * applicable. ⑤ tokens was this shape through C1a/C1b/C1c; C2a implemented it (see `./tokens.ts`) — the
 * census-level fork-usage-copy evidence it carried while pending now lives in `tokensCheck` itself.
 */
import type { CheckId } from '../contract'
import {
  applicability,
  applicabilityEntry,
  assembleCheck,
  type CheckContext,
  type SourceEntry
} from './common'
import { SOURCE_IDS } from '../contract'

export function pendingCheck(id: Extract<CheckId, 'lineage' | 'resume'>, ctx: CheckContext): ReturnType<typeof assembleCheck> {
  const bySource: Record<string, SourceEntry> = {}
  for (const source of SOURCE_IDS) {
    const base = applicability(source, id, ctx, 'check.not-implemented')
    const implemented = source === 'claude-code' || source === 'codex'
    const verdict = base.verdict === 'not-applicable' ? 'not-applicable' : 'undetermined'
    const reason = base.verdict === 'not-applicable' ? base.reason : implemented ? 'check.not-implemented' : base.reason
    bySource[source] = applicabilityEntry(verdict, reason)
  }
  return assembleCheck({ id, bySource, findings: [], headline: 'check.not-implemented', reason: 'check.not-implemented' })
}
