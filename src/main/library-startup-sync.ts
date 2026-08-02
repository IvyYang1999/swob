import type { LibrarySyncOutcome } from './library-manager'
import type { SessionSummary } from './types'

export interface IncrementalLibraryStartupOptions {
  sessions: readonly SessionSummary[]
  probeWriter: () => Promise<void>
  syncChunk: (session: SessionSummary) => Promise<LibrarySyncOutcome>
  resolveLatest: (initial: SessionSummary) => SessionSummary
  /** True only when this drain completed at least one durable live commit. */
  drainLive: () => Promise<boolean | void>
  onWriterProven: () => void
  onFirstDurableBoundary?: () => void
  onProgress?: (progress: { current: number; total: number; sessionId: string }) => void
}

/**
 * Proves the writer without holding it, then gives live source work priority at
 * every startup transaction boundary. A fresh summary is resolved immediately
 * before each chunk so an older startup snapshot cannot overwrite a live sync.
 */
export async function syncLibraryStartupIncrementally(
  options: IncrementalLibraryStartupOptions
): Promise<LibrarySyncOutcome> {
  const outcome: LibrarySyncOutcome = {
    total: options.sessions.length,
    completed: 0,
    skipped: []
  }

  await options.probeWriter()
  options.onWriterProven()
  let boundaryReported = false
  const reportBoundary = (): void => {
    if (boundaryReported) return
    boundaryReported = true
    options.onFirstDurableBoundary?.()
  }
  if (await options.drainLive()) reportBoundary()
  // With no source sessions there can be no live or startup-session commit.
  // The successful writer probe is the explicit empty-Library boundary.
  if (options.sessions.length === 0) reportBoundary()

  for (let index = 0; index < options.sessions.length; index++) {
    if (await options.drainLive()) reportBoundary()
    const session = options.resolveLatest(options.sessions[index])
    const chunk = await options.syncChunk(session)
    // Only a successfully processed chunk proves that at least one startup
    // session is current under the Library writer. An identity-conflict skip
    // is deliberately read-only and must not release heavyweight projections
    // ahead of the next session that can actually cross that boundary.
    if (chunk.completed > 0) reportBoundary()
    outcome.completed += chunk.completed
    outcome.skipped.push(...chunk.skipped)
    options.onProgress?.({
      current: index + 1,
      total: options.sessions.length,
      sessionId: session.sessionId
    })
    if (await options.drainLive()) reportBoundary()
  }

  // If every source is an intentionally read-only identity conflict there is
  // no writable startup session to wait for. The full pass itself is then the
  // bounded completion point, so deferred projections may proceed.
  reportBoundary()

  return outcome
}
