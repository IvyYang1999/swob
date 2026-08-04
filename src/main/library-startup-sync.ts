import type { LibrarySyncOutcome } from './library-manager'
import type { SessionSummary } from './types'

export interface LibraryStartupProgress {
  current: number
  total: number
  completed: number
  failed: number
  remaining: number
  sessionId: string
  failureReason?: string
}

export class LibraryStartupSyncInterruptedError extends Error {
  constructor() {
    super('Library background synchronization interrupted')
    this.name = 'LibraryStartupSyncInterruptedError'
  }
}

export interface IncrementalLibraryStartupOptions {
  sessions: readonly SessionSummary[]
  probeWriter: () => Promise<void>
  syncChunk: (session: SessionSummary) => Promise<LibrarySyncOutcome>
  resolveLatest: (initial: SessionSummary) => SessionSummary
  /** True only when this drain completed at least one durable live commit. */
  drainLive: () => Promise<boolean | void>
  onWriterProven: () => void
  onFirstDurableBoundary?: (kind: 'durable' | 'empty' | 'read-only-only' | 'failed') => void
  onProgress?: (progress: LibraryStartupProgress) => void
  shouldInterrupt?: () => boolean
  yieldToEventLoop?: () => Promise<void>
  yieldEvery?: number
}

function failureReason(error: unknown): string {
  if (!error || typeof error !== 'object') return 'SESSION_SYNC_FAILED'
  const typed = error as { code?: unknown; name?: unknown }
  if (typeof typed.code === 'string' && /^[A-Z0-9_:-]+$/.test(typed.code)) return typed.code
  if (typed.name !== 'Error' && typeof typed.name === 'string' && /^[A-Za-z0-9_-]+$/.test(typed.name)) {
    return typed.name
  }
  return 'SESSION_SYNC_FAILED'
}

function mustAbortStartup(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const typed = error as { code?: unknown; name?: unknown }
  return typed.name === 'AbortError' || typed.name === 'LibraryWriterBusyError' ||
    typed.name === 'LibraryPathUnsafeError' ||
    ['LIBRARY_WRITER_BUSY', 'EACCES', 'EPERM', 'ENOSPC', 'EIO'].includes(String(typed.code || ''))
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
  let failed = 0
  let unexpectedFailure = false
  const reportBoundary = (kind: 'durable' | 'empty' | 'read-only-only' | 'failed'): void => {
    if (boundaryReported) return
    boundaryReported = true
    options.onFirstDurableBoundary?.(kind)
  }
  if (await options.drainLive()) reportBoundary('durable')
  // With no source sessions there can be no live or startup-session commit.
  // The successful writer probe is the explicit empty-Library boundary.
  if (options.sessions.length === 0) reportBoundary('empty')

  for (let index = 0; index < options.sessions.length; index++) {
    if (options.shouldInterrupt?.()) throw new LibraryStartupSyncInterruptedError()
    if (await options.drainLive()) reportBoundary('durable')
    const session = options.resolveLatest(options.sessions[index])
    let itemFailure: string | undefined
    try {
      const chunk = await options.syncChunk(session)
      // Only a successfully processed chunk proves that at least one startup
      // session is current under the Library writer. An identity-conflict skip
      // is deliberately read-only and must not release heavyweight projections
      // ahead of the next session that can actually cross that boundary.
      if (chunk.completed > 0) reportBoundary('durable')
      outcome.completed += chunk.completed
      outcome.skipped.push(...chunk.skipped)
      if (chunk.skipped.length > 0) {
        failed++
        itemFailure = chunk.skipped[0].code
      }
    } catch (error) {
      if (mustAbortStartup(error)) throw error
      failed++
      unexpectedFailure = true
      itemFailure = failureReason(error)
    }
    options.onProgress?.({
      current: index + 1,
      total: options.sessions.length,
      completed: outcome.completed,
      failed,
      remaining: Math.max(0, options.sessions.length - index - 1),
      sessionId: session.sessionId,
      ...(itemFailure ? { failureReason: itemFailure } : {})
    })
    if (await options.drainLive()) reportBoundary('durable')
    const yieldEvery = Math.max(1, Math.trunc(options.yieldEvery || 8))
    if ((index + 1) % yieldEvery === 0) await options.yieldToEventLoop?.()
  }

  // If every source is an intentionally read-only identity conflict there is
  // no writable startup session to wait for. The full pass itself is then the
  // bounded completion point, so deferred projections may proceed.
  reportBoundary(unexpectedFailure ? 'failed' : 'read-only-only')

  return outcome
}
