import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BUILTIN_PROVIDER_DEFINITIONS,
  isLegacySessionSource
} from '../shared/provider-capabilities'
import type {
  NormalizedTokenComponents,
  ReportedCostKind,
  UsageEvent
} from './token-accounting'
import { valueUsageEvent } from './token-valuation'

interface PricingEvidenceCase {
  sourceId: string
  evidence: 'approved-catalog-rule' | 'provider-reported-per-turn-cost' | 'provider-recorded-per-message-cost'
  condition: string
  modelCanonical?: string
  billingProvider?: string
  timestamp: string
  reportedCostUsd?: number
  reportedCostKind?: ReportedCostKind
  components: NormalizedTokenComponents
}

const fixtureFile = path.resolve('testdata/valuation/per-call-pricing-evidence.json')
const fixture = JSON.parse(fs.readFileSync(fixtureFile, 'utf8')) as {
  schemaVersion: number
  cases: PricingEvidenceCase[]
}

function eventFromCase(input: PricingEvidenceCase): UsageEvent {
  if (!isLegacySessionSource(input.sourceId)) throw new Error(`Unknown fixture source ${input.sourceId}`)
  return {
    provider: input.sourceId,
    providerFormatVersion: 't182-pricing-evidence-v1',
    dedupKey: `t182:${input.sourceId}:call-1`,
    billingFactKey: `t182:${input.sourceId}:bill-1`,
    timestamp: input.timestamp,
    ...(input.modelCanonical ? { modelRaw: input.modelCanonical, modelCanonical: input.modelCanonical } : {}),
    modelProvenance: input.modelCanonical ? 'response' : 'unknown',
    ...(input.billingProvider ? { billingProvider: input.billingProvider } : {}),
    providerProvenance: input.billingProvider ? 'explicit' : 'unknown',
    scope: 'main',
    counterKind: 'incremental',
    provenance: 'reported',
    components: input.components,
    semantics: input.sourceId === 'codex' ? 'openai-input-subset' : 'provider-specific',
    ...(input.reportedCostUsd !== undefined ? { reportedCostUsd: input.reportedCostUsd } : {}),
    ...(input.reportedCostKind ? { reportedCostKind: input.reportedCostKind } : {}),
    warnings: []
  }
}

describe('valuation capability conformance', () => {
  it('backs every billable-exact declaration with one replayable per-call pricing fixture', () => {
    expect(fixture.schemaVersion).toBe(1)
    const exactSources = BUILTIN_PROVIDER_DEFINITIONS
      .filter((definition) => definition.valuation.status === 'billable-exact')
      .map((definition) => definition.sourceId)
      .sort()
    expect(fixture.cases.map((entry) => entry.sourceId).sort()).toEqual(exactSources)

    for (const pricingCase of fixture.cases) {
      expect(pricingCase.condition.length).toBeGreaterThan(20)
      const result = valueUsageEvent(eventFromCase(pricingCase))
      expect(result.usd, pricingCase.sourceId).toBeGreaterThan(0)
      if (pricingCase.evidence === 'approved-catalog-rule') {
        expect(result.coveragePercent, pricingCase.sourceId).toBe(100)
        expect(result.pricingMatch, pricingCase.sourceId).not.toBe('none')
        expect(result.pricingRules, pricingCase.sourceId).toHaveLength(1)
      } else {
        expect(result.pricingMatch, pricingCase.sourceId).toBe('reported')
        if (pricingCase.reportedCostKind === 'provider-billed') {
          expect(result.financialCoveragePercent, pricingCase.sourceId).toBe(100)
        }
      }
    }
  })
})
