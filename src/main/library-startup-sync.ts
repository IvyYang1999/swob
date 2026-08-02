import type { LibrarySyncOutcome } from './library-manager'
import type { SessionSummary } from './types'

export interface IncrementalLibraryStartupOptions {
  sessions: readonly SessionSummary[]
  probeWriter: () => Promise<void>
  syncChunk: (session: SessionSummary) => Promise<LibrarySyncOutcome>
  resolveLatest: (initial: SessionSummary) => SessionSummary
  drainLive: () => Promise<void>
  onWriterProven: () => void
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
  await options.drainLive()

  for (let index = 0; index < options.sessions.length; index++) {
    await options.drainLive()
    const session = options.resolveLatest(options.sessions[index])
    const chunk = await options.syncChunk(session)
    outcome.completed += chunk.completed
    outcome.skipped.push(...chunk.skipped)
    options.onProgress?.({
      current: index + 1,
      total: options.sessions.length,
      sessionId: session.sessionId
    })
    await options.drainLive()
  }

  return outcome
}
