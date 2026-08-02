/**
 * tF32 R2: Library health state hook.
 *
 * Uses the canonical shared contract from t192 integrator.
 * Fail-closed: initial state is `initializing` (NOT `ready`).
 * IPC boundary validated via `isLibraryHealthSnapshot`.
 */
import { useState, useEffect } from 'react'
import type {
  LibraryHealthSnapshot,
  SessionFreshness,
  LibraryHealthState
} from '../../../shared/library-health-contract'
import {
  isLibraryHealthSnapshot,
  createInitializingLibraryHealthSnapshot
} from '../../../shared/library-health-contract'

// Re-export shared types for consumers
export type { LibraryHealthSnapshot, LibraryHealthState, SessionFreshness }

// ---- Hook: useLibraryHealth ----

export function useLibraryHealth(): LibraryHealthSnapshot {
  const [health, setHealth] = useState<LibraryHealthSnapshot>(
    createInitializingLibraryHealthSnapshot
  )

  useEffect(() => {
    if (typeof window.api?.libraryGetHealth !== 'function') return

    // Request counter: prevents stale initial-fetch response from overwriting
    // a newer event-pushed snapshot (fast A->B state change race).
    let requestGeneration = 0
    const currentGeneration = ++requestGeneration

    // Initial fetch — validate at IPC boundary
    window.api.libraryGetHealth().then((result: unknown) => {
      // Only apply if no newer event has arrived since this request started
      if (requestGeneration !== currentGeneration) return
      if (isLibraryHealthSnapshot(result)) {
        setHealth(result)
      }
      // Invalid data: stay on initializing (fail-closed), NOT fall back to ready
    }).catch(() => {
      // IPC not ready — stay on initializing (fail-closed)
    })

    // Subscribe to changes if event channel exists
    if (typeof window.api?.onLibraryHealthChanged === 'function') {
      const cleanup = window.api.onLibraryHealthChanged(
        (update: unknown) => {
          // Event-pushed snapshots are always newer — bump the generation
          // to prevent any in-flight initial fetch from overwriting them.
          requestGeneration++
          if (isLibraryHealthSnapshot(update)) {
            setHealth(update)
          }
          // Invalid update: keep last valid state (fail-closed)
        }
      )
      return typeof cleanup === 'function' ? cleanup : undefined
    }
  }, [])

  return health
}

// ---- Hook: useSessionFreshness ----

const INITIALIZING_FRESHNESS: SessionFreshness = {
  schemaVersion: 1,
  sessionId: '',
  basis: 'unverifiable',
  status: 'unverifiable',
  severity: 'unknown',
  stale: false,
  sourceUpdatedAt: null,
  canonicalUpdatedAt: null,
  transcriptUpdatedAt: null,
  backupUpdatedAt: null,
  requiredArtifacts: [],
  lagMs: null,
  thresholdMs: 0,
  reasons: []
}

/**
 * Returns freshness info for a specific session.
 * Falls back to an unverifiable sentinel when IPC is unavailable.
 *
 * Uses a cancelled-flag cleanup to prevent stale async responses from
 * overwriting the current session's data when sessionId changes rapidly.
 */
export function useSessionFreshness(sessionId: string | undefined): SessionFreshness {
  const [freshness, setFreshness] = useState<SessionFreshness | null>(null)

  useEffect(() => {
    if (!sessionId) { setFreshness(null); return }
    if (typeof window.api?.libraryGetSessionFreshness !== 'function') return

    let cancelled = false
    setFreshness(null) // reset on sessionId change

    window.api.libraryGetSessionFreshness(sessionId).then((result: unknown) => {
      if (!cancelled && result && typeof result === 'object' && (result as any).schemaVersion === 1) {
        setFreshness(result as SessionFreshness)
      }
    }).catch(() => {
      if (!cancelled) setFreshness(null)
    })

    return () => { cancelled = true }
  }, [sessionId])

  return freshness ?? INITIALIZING_FRESHNESS
}

// ---- Helpers ----

/**
 * Format lagMs (milliseconds) into a human-readable "X minutes" / "X hours" value.
 * Returns null if lag is null or within the acceptable threshold (< 60s).
 */
export function formatLag(lagMs: number | null): { value: number; unit: 'minutes' | 'hours' } | null {
  if (lagMs === null || lagMs < 60_000) return null
  const lagSeconds = lagMs / 1000
  if (lagSeconds < 3600) return { value: Math.round(lagSeconds / 60), unit: 'minutes' }
  return { value: Math.round(lagSeconds / 3600), unit: 'hours' }
}

/**
 * Format lagMs to a minutes integer for disclaimer display.
 * Returns 0 if not stale.
 */
export function staleMinutes(lagMs: number | null): number {
  if (lagMs === null || lagMs < 60_000) return 0
  return Math.round(lagMs / 1000 / 60)
}

/**
 * Retry library compensation via IPC. Returns true if the call succeeded.
 */
export async function retryCompensation(): Promise<boolean> {
  try {
    if (typeof window.api?.libraryCompensationRetry === 'function') {
      await window.api.libraryCompensationRetry()
      return true
    }
    return false
  } catch {
    return false
  }
}

/**
 * Cancel library compensation via IPC. Returns true if the call succeeded.
 */
export async function cancelCompensation(): Promise<boolean> {
  try {
    if (typeof window.api?.libraryCompensationCancel === 'function') {
      await window.api.libraryCompensationCancel()
      return true
    }
    return false
  } catch {
    return false
  }
}
