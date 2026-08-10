import type { ContextArtifact, EvidenceGrade, EvidenceRef } from '../../shared/contracts/truth-kernel'
import type { ContextLedgerProjection } from './types'

const at = '2026-08-11T00:00:00.000Z'
const claim: Record<EvidenceGrade, EvidenceRef['claim']> = {
  A: 'wire-exact', B: 'provider-confirmed', C: 'deterministically-reconstructed',
  D: 'heuristically-inferred', E: 'current-snapshot'
}

function artifact(grade: EvidenceGrade): ContextArtifact {
  return {
    schemaVersion: 1,
    contextArtifactId: `fixture-${grade}`,
    kind: grade === 'E' ? 'instruction-file' : 'unknown',
    providerId: 'fixture-provider',
    sourceUri: grade === 'E'
      ? { status: 'available', value: 'current://AGENTS.md' }
      : { status: 'unknown', reason: 'fixture source withheld' },
    scope: grade === 'E' ? 'project' : 'unknown',
    capturedAt: at,
    effectiveAt: grade === 'E'
      ? { status: 'unknown', reason: 'current state has no historical effective time' }
      : { status: 'available', value: at },
    contentDigest: { status: 'unknown', reason: 'fixture digest withheld' },
    content: grade === 'E'
      ? { status: 'available', value: 'current file content; never historical exact' }
      : { status: 'unavailable', reason: 'fixture body withheld' },
    attachmentRef: { status: 'unavailable', reason: 'not an attachment' },
    redaction: grade === 'E' ? 'none' : 'content-withheld',
    tokenCount: { status: 'unavailable', reason: 'no per-artifact measurement' },
    tokenMeasurement: 'unavailable',
    evidence: [{
      evidenceId: `fixture-evidence-${grade}`,
      sourceId: 'fixture-source',
      sourceKind: grade === 'A' ? 'runtime-capture' : grade === 'E' ? 'artifact' : 'transcript',
      capturedAt: at,
      grade,
      claim: claim[grade]
    }]
  }
}

/** A privacy-safe fixture proving the renderer/export supports all A–E labels. */
export function contextLedgerEvidenceGradeFixture(): ContextLedgerProjection {
  const artifacts = (['A', 'B', 'C', 'D', 'E'] as EvidenceGrade[]).map(artifact)
  return {
    logicalSessionId: 'fixture-session',
    artifacts,
    injections: [],
    snapshots: [],
    transitions: [],
    mcpExposures: [],
    evidenceCounts: { A: 1, B: 1, C: 1, D: 1, E: 1 },
    unknownArtifactCount: 1
  }
}
