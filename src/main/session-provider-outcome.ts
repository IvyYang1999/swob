import type { SessionProviderOutcome, SessionSummary } from './types'
import { accountingForSession } from './token-accounting'

/**
 * Compatibility inference is based on the materialized session, never on a
 * provider's static capability. Real loaders persist providerOutcome directly.
 */
export function providerOutcomeForSession(session: SessionSummary): SessionProviderOutcome {
  if (session.providerOutcome) return session.providerOutcome
  const parsed = session.isManifestOnly !== true && session.messageCount > 0
  if (!parsed) {
    return {
      detected: 'detected',
      parse: 'placeholder',
      usage: 'unavailable',
      reason: session.isManifestOnly ? 'manifest-only' : 'empty-session'
    }
  }
  const accounting = accountingForSession(session)
  return {
    detected: 'detected',
    parse: 'parsed',
    usage: accounting.billingTotal === null ? 'unavailable' : 'available'
  }
}

export function sessionHasParsedTranscript(session: SessionSummary): boolean {
  return providerOutcomeForSession(session).parse === 'parsed'
}

export function sessionHasAuthoritativeUsage(session: SessionSummary): boolean {
  const outcome = providerOutcomeForSession(session)
  return outcome.parse === 'parsed' && outcome.usage === 'available'
}
