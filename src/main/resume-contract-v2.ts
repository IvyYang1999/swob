import type { ResumeContract } from '../shared/provider-schema-v2.generated'
import {
  classifyResumeL3,
  normalizeResumeAuditText,
  type ResumeAnchors,
  type ResumeL3Decision,
  type ResumeAnchorMessage
} from './resume-verifier'

export interface ResumeContractObservationV2 {
  launched: boolean
  expectedSourceRefId: string
  observedSourceRefId: string | null
  sourceExists: boolean
  expectedAnchors: ResumeAnchors
  observedDefaultMessages: ResumeAnchorMessage[]
  observedAllMessages: ResumeAnchorMessage[]
  integrity?: {
    sourceHash: string
    targetHash: string
    matches: boolean
  }
}

export type ResumeContractVerificationV2 = {
  ok: boolean
  status:
    | 'verified'
    | 'launch-failed'
    | 'source-missing'
    | 'source-mismatch'
    | 'anchor-mismatch'
    | 'integrity-mismatch'
    | 'unverifiable'
  l3: ResumeL3Decision | null
  sourceMatched: boolean
  integrityMatched: boolean | null
}

/**
 * Resume success is an observed postcondition, not a successful process spawn.
 * The anchor classifier is shared with the existing L3 audit; optional hash
 * evidence remains a stronger conjunct and can never be weakened into a warning.
 */
export function verifyResumeContractV2(
  contract: ResumeContract,
  observation: ResumeContractObservationV2
): ResumeContractVerificationV2 {
  const sourceMatched = observation.observedSourceRefId === observation.expectedSourceRefId
  const integrityMatched = observation.integrity ? observation.integrity.matches &&
    observation.integrity.sourceHash === observation.integrity.targetHash : null

  if (!observation.launched) {
    return { ok: false, status: 'launch-failed', l3: null, sourceMatched, integrityMatched }
  }
  if (!observation.sourceExists) {
    return { ok: false, status: 'source-missing', l3: null, sourceMatched, integrityMatched }
  }
  if (!sourceMatched) {
    return { ok: false, status: 'source-mismatch', l3: null, sourceMatched, integrityMatched }
  }
  if (contract.postcondition === 'unverifiable') {
    return { ok: false, status: 'unverifiable', l3: null, sourceMatched, integrityMatched }
  }

  const expectedAnchors = {
    user: normalizeResumeAuditText(observation.expectedAnchors.user),
    assistant: normalizeResumeAuditText(observation.expectedAnchors.assistant)
  }
  const l3 = classifyResumeL3(expectedAnchors, {
    status: observation.observedDefaultMessages.length > 0 ? 'found' : 'empty',
    defaultMessages: observation.observedDefaultMessages,
    allMessages: observation.observedAllMessages
  })
  if (contract.postcondition === 'anchor-match' && l3.status !== 'match') {
    return { ok: false, status: 'anchor-mismatch', l3, sourceMatched, integrityMatched }
  }
  if (integrityMatched === false) {
    return { ok: false, status: 'integrity-mismatch', l3, sourceMatched, integrityMatched }
  }
  return { ok: true, status: 'verified', l3, sourceMatched, integrityMatched }
}
