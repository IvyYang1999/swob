import type { SessionSummary } from './types'

export type RendererSessionSummary = Omit<SessionSummary, 'allUserMessages' | 'tokenAccounting'> & {
  tokenAccounting?: Omit<NonNullable<SessionSummary['tokenAccounting']>, 'usageEvents'>
}

export interface SessionBootstrap<TInitial, TCompletion = TInitial[]> {
  initial: TInitial[]
  completion: Promise<TCompletion>
}

/**
 * Start the authoritative physical-source snapshot and additive projections at
 * the same time, but only gate first paint on the physical sources.
 */
export async function beginSessionBootstrap<TInitial, TCompletion = TInitial[]>(
  loadInitial: () => Promise<TInitial[]>,
  loadComplete: () => Promise<TCompletion>
): Promise<SessionBootstrap<TInitial, TCompletion>> {
  const initialFlight = Promise.resolve().then(loadInitial)
  const completion = Promise.resolve().then(loadComplete)
  // The caller receives and observes the original promise after the initial
  // snapshot. Attach a handler now so an early projection failure is never an
  // unhandled rejection while the physical-source scan is still running.
  void completion.catch(() => {})
  return { initial: await initialFlight, completion }
}

/** Return only sessions that were not already present in the first snapshot. */
export function additiveSessionPatch<T extends { id: string }>(initial: T[], complete: T[]): T[] {
  const initialIds = new Set(initial.map((session) => session.id))
  return complete.filter((session) => !initialIds.has(session.id))
}

/**
 * Renderer list views never consume per-call usage events or the full list of
 * user prompts. Keep those main-process audit facts out of structured-clone
 * IPC, which otherwise duplicates tens or hundreds of megabytes at startup.
 */
export function sessionSummaryForRenderer(summary: SessionSummary): RendererSessionSummary {
  const { allUserMessages: _allUserMessages, tokenAccounting, ...visible } = summary
  if (!tokenAccounting) return visible
  const { usageEvents: _usageEvents, ...compactAccounting } = tokenAccounting
  return { ...visible, tokenAccounting: compactAccounting }
}
