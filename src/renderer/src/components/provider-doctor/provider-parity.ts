import {
  BUILTIN_PROVIDER_DEFINITIONS,
  type BuiltinProviderDefinition
} from '../../../../shared/provider-capabilities'
import type { CapabilityDeclaration } from '../../../../shared/provider-schema.generated'

export const PROVIDER_DOCTOR_CAPABILITIES = [
  'discover', 'parse', 'render', 'usage', 'tools', 'thinking', 'compact', 'context', 'interaction',
  'permission', 'subagent', 'resume', 'lineage', 'windows-native', 'wsl-path',
  'execution-domain'
] as const

export type ProviderDoctorCapability = typeof PROVIDER_DOCTOR_CAPABILITIES[number]
export type ProviderDoctorTruth = 'exact' | 'derived' | 'estimated' | 'unavailable'

export interface ProviderParityCell {
  capability: ProviderDoctorCapability
  truth: ProviderDoctorTruth
  reason: string
  evidence: string[]
}

export interface ProviderParityFixture {
  sourceId: string
  providerId: string
  displayName: string
  discoveryCategory: 'file' | 'directory' | 'sqlite' | 'composite' | 'unknown'
  adapterVersion: string
  formatVersions: readonly string[]
  fixturePaths: string[]
  fixtureProvenance: 'sanitized-real' | 'synthetic' | 'compatibility' | 'implementation-only'
  capabilities: Record<ProviderDoctorCapability, ProviderParityCell>
}

const CAPABILITY_SOURCE: Partial<Record<ProviderDoctorCapability, keyof BuiltinProviderDefinition['manifest']['capabilities']>> = {
  discover: 'discover',
  parse: 'transcript',
  render: 'transcript',
  usage: 'usage',
  tools: 'tools',
  thinking: 'thinking',
  subagent: 'subagents',
  resume: 'terminal-resume',
  lineage: 'relationships'
}

function truthFor(declaration: CapabilityDeclaration | undefined, capability: ProviderDoctorCapability): ProviderDoctorTruth {
  if (!declaration || declaration.status === 'unavailable' || declaration.status === 'not-applicable') return 'unavailable'
  if (declaration.status === 'experimental') return 'derived'
  if (capability === 'render') return 'derived'
  return 'exact'
}

function evidenceFor(declaration: CapabilityDeclaration | undefined): string[] {
  return declaration?.evidence.map((item) => item.locator) ?? []
}

function discoveryCategory(definition: BuiltinProviderDefinition): ProviderParityFixture['discoveryCategory'] {
  const joined = definition.manifest.formatVersions.join(' ').toLowerCase()
  if (joined.includes('sqlite') || joined.includes('state-db') || joined.includes('vscdb')) return 'sqlite'
  if (joined.includes('composite')) return 'composite'
  if (definition.ingestion === 'detection-only') return 'unknown'
  return definition.ingestion === 'provider-host' ? 'directory' : 'file'
}

function fixtureProvenance(paths: readonly string[]): ProviderParityFixture['fixtureProvenance'] {
  const joined = paths.join(' ').toLowerCase()
  if (joined.includes('sanitized') || joined.includes('observed')) return 'sanitized-real'
  if (joined.includes('compatib')) return 'compatibility'
  if (joined.includes('test') || joined.includes('fixture')) return 'synthetic'
  return 'implementation-only'
}

function unsupported(capability: ProviderDoctorCapability, reason: string): ProviderParityCell {
  return { capability, truth: 'unavailable', reason, evidence: [] }
}

/**
 * Feature-local projection of the production Registry. It is intentionally
 * conservative: an event family absent from the Registry contract is reported
 * unavailable instead of being inferred from a generic transcript capability.
 */
export function buildProviderParityFixture(definition: BuiltinProviderDefinition): ProviderParityFixture {
  const capabilities = {} as Record<ProviderDoctorCapability, ProviderParityCell>
  for (const capability of PROVIDER_DOCTOR_CAPABILITIES) {
    const source = CAPABILITY_SOURCE[capability]
    const declaration = source ? definition.manifest.capabilities[source] : undefined
    if (declaration) {
      const truth = capability === 'usage'
        ? definition.valuation.status === 'billable-exact'
          ? truthFor(declaration, capability)
          : definition.valuation.status === 'estimate-only' && declaration.status !== 'unavailable'
            ? 'estimated'
            : 'unavailable'
        : truthFor(declaration, capability)
      capabilities[capability] = {
        capability,
        truth,
        reason: capability === 'usage' ? definition.valuation.reason : declaration.reason ?? `${source} is backed by the production Registry declaration.`,
        evidence: evidenceFor(declaration)
      }
      continue
    }
    capabilities[capability] = unsupported(
      capability,
      capability === 'compact' || capability === 'context' || capability === 'interaction' || capability === 'permission'
        ? 'Protocol-v1 sources migrate this family as derived historical evidence; native live semantics still require provider evidence.'
        : capability === 'windows-native' || capability === 'wsl-path' || capability === 'execution-domain'
          ? 'Execution-realm support requires source path and runtime evidence; none is asserted by the provider manifest.'
          : 'No evidence-backed production declaration exists.'
    )
  }

  for (const capability of ['compact', 'context', 'interaction', 'permission'] as const) {
    capabilities[capability] = {
      capability,
      truth: 'derived',
      reason: 'The production protocol-v1 migration declares this family experimental and preserves unknown/live boundaries.',
      evidence: ['src/main/provider-v1-migration.ts']
    }
  }

  const nativeResume = definition.manifest.capabilities['native-resume']
  capabilities['windows-native'] = {
    capability: 'windows-native',
    truth: truthFor(nativeResume, 'windows-native'),
    reason: nativeResume.reason ?? 'Native resume is declared by the production Registry.',
    evidence: evidenceFor(nativeResume)
  }
  capabilities['wsl-path'] = unsupported('wsl-path', 'No provider manifest proves a WSL source root and CLI postcondition together.')
  capabilities['execution-domain'] = unsupported('execution-domain', 'Execution domain is resolved per discovered source, not guessed from the host platform.')

  const allEvidence = Object.values(definition.manifest.capabilities)
    .flatMap((declaration) => evidenceFor(declaration))
  const fixturePaths = [...new Set(allEvidence.filter((locator) =>
    locator.includes('testdata/') || locator.includes('.test.ts') || locator.includes('fixture')
  ))]

  return {
    sourceId: definition.sourceId,
    providerId: definition.manifest.providerId,
    displayName: definition.manifest.displayName,
    discoveryCategory: discoveryCategory(definition),
    adapterVersion: definition.adapterContract,
    formatVersions: definition.manifest.formatVersions,
    fixturePaths,
    fixtureProvenance: fixtureProvenance(allEvidence),
    capabilities
  }
}

/** Dynamic by construction: future Registry additions automatically enter this projection and its parity gate. */
export function productionProviderParityFixtures(): ProviderParityFixture[] {
  return BUILTIN_PROVIDER_DEFINITIONS.map(buildProviderParityFixture)
}

const ABSOLUTE_PATH = /(?:[A-Za-z]:\\[^\s]+|\/(?:Users|home|private|var|tmp)\/[^\s]+)/gu
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu

/** Provider Doctor diagnostics must remain useful without exposing user paths or addresses. */
export function sanitizeProviderDiagnosticText(value: string): string {
  return value.replace(ABSOLUTE_PATH, '<private-path>').replace(EMAIL, '<private-email>')
}

export function exportProviderParityDiagnostics(fixtures: readonly ProviderParityFixture[]): string {
  return JSON.stringify(fixtures.map((fixture) => ({
    ...fixture,
    capabilities: Object.fromEntries(Object.entries(fixture.capabilities).map(([name, cell]) => [name, {
      ...cell,
      reason: sanitizeProviderDiagnosticText(cell.reason)
    }]))
  })), null, 2)
}
