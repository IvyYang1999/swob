import type {
  CapabilityDeclaration,
  CapabilityEvidence,
  CapabilityStatus,
  ProviderCapabilities,
  ProviderManifest
} from './provider-schema.generated'

export const LEGACY_SESSION_SOURCES = [
  'claude-code',
  'codex',
  'cursor',
  'opencode',
  'zcode',
  'cc-mirror',
  'antigravity',
  'grok',
  'pi',
  'kimi',
  'hermes'
] as const

export type LegacySessionSource = typeof LEGACY_SESSION_SOURCES[number]
export type BuiltinProviderTier = 'native' | 'compatible' | 'detection-only'

export interface BuiltinProviderDefinition {
  sourceId: LegacySessionSource
  tier: BuiltinProviderTier
  manifest: ProviderManifest
}

const implementation = (locator: string, note?: string): CapabilityEvidence => ({
  kind: 'implementation',
  locator,
  ...(note ? { note } : {})
})

const test = (locator: string, note?: string): CapabilityEvidence => ({
  kind: 'test',
  locator,
  ...(note ? { note } : {})
})

const compatibility = (locator: string, note?: string): CapabilityEvidence => ({
  kind: 'compatibility-contract',
  locator,
  ...(note ? { note } : {})
})

function capability(
  status: CapabilityStatus,
  reason: string | null,
  evidence: CapabilityEvidence[] = []
): CapabilityDeclaration {
  return { status, reason, evidence }
}

const available = (...evidence: CapabilityEvidence[]): CapabilityDeclaration =>
  capability('available', null, evidence)

const unavailable = (reason: string, ...evidence: CapabilityEvidence[]): CapabilityDeclaration =>
  capability('unavailable', reason, evidence)

const experimental = (reason: string, ...evidence: CapabilityEvidence[]): CapabilityDeclaration =>
  capability('experimental', reason, evidence)

const notApplicable = (reason: string, ...evidence: CapabilityEvidence[]): CapabilityDeclaration =>
  capability('not-applicable', reason, evidence)

const loader = implementation('src/main/session-loader.ts')
const sourceDetection = implementation('src/main/session-source.ts')
const searchIndex = implementation('src/main/search-index.ts')
const archive = implementation('src/main/library-manager.ts')
const resume = implementation('src/main/session-actions.ts')
const watcher = implementation('src/main/source-directory-watcher.ts')
const unavailableSummary = implementation(
  'src/main/session-loader.ts#buildUnavailableSourceSummary',
  'Only creates a detected-file placeholder; detail returns no messages.'
)

function nativeCapabilities(options: {
  loaderFile: string
  thinking: CapabilityDeclaration
  usage: CapabilityDeclaration
  relationships: CapabilityDeclaration
  subagents: CapabilityDeclaration
  liveWatch: CapabilityDeclaration
  search: CapabilityDeclaration
  terminalResume: CapabilityDeclaration
  nativeResume: CapabilityDeclaration
}): ProviderCapabilities {
  const dedicatedLoader = implementation(options.loaderFile)
  return {
    discover: available(loader, dedicatedLoader),
    summary: available(dedicatedLoader),
    transcript: available(dedicatedLoader),
    tools: available(dedicatedLoader),
    thinking: options.thinking,
    usage: options.usage,
    relationships: options.relationships,
    subagents: options.subagents,
    'live-watch': options.liveWatch,
    search: options.search,
    archive: available(archive, dedicatedLoader),
    'terminal-resume': options.terminalResume,
    'native-resume': options.nativeResume,
    'format-provenance': unavailable(
      'Current loaders do not emit an authoritative source format version on every parsed record.',
      dedicatedLoader
    )
  }
}

function detectionOnlyCapabilities(source: LegacySessionSource): ProviderCapabilities {
  return {
    discover: experimental(
      'Path detection exists, but the upstream format is not parsed.',
      loader,
      sourceDetection,
      unavailableSummary
    ),
    summary: experimental(
      'The summary contains file metadata and a synthetic label only.',
      unavailableSummary
    ),
    transcript: unavailable('Session detail deliberately returns an empty message list.', unavailableSummary),
    tools: unavailable('No source-specific transcript parser exists.', unavailableSummary),
    thinking: unavailable('No source-specific transcript parser exists.', unavailableSummary),
    usage: unavailable('No authoritative usage values are parsed; zero must not be inferred.', unavailableSummary),
    relationships: unavailable('No relationship parser exists.', unavailableSummary),
    subagents: unavailable('No subagent parser exists.', unavailableSummary),
    'live-watch': unavailable('No source-specific watcher exists.', watcher),
    search: unavailable('No reliable normalized transcript is available to the search index.', searchIndex),
    archive: experimental(
      'Only the detected physical file is copied; compound DB/WAL/sidecar completeness is unverified.',
      archive
    ),
    'terminal-resume': experimental(
      `The ${source} command mapping is inferred and has no source-level resume audit.`,
      resume
    ),
    'native-resume': notApplicable('No verified native per-session entry point is implemented.', resume),
    'format-provenance': unavailable('No authoritative format evidence is attached to parsed records.', unavailableSummary)
  }
}

function definition(
  sourceId: LegacySessionSource,
  displayName: string,
  tier: BuiltinProviderTier,
  capabilities: ProviderCapabilities,
  formatVersions: string[] = ['unknown']
): BuiltinProviderDefinition {
  return {
    sourceId,
    tier,
    manifest: {
      schemaVersion: 1,
      providerId: `swob/${sourceId}`,
      displayName,
      implementationVersion: 'builtin-v1',
      parserDataVersion: '1',
      formatVersions,
      legacySourceIds: [sourceId],
      capabilities
    }
  }
}

export const BUILTIN_PROVIDER_DEFINITIONS: readonly BuiltinProviderDefinition[] = [
  definition('claude-code', 'Claude Code', 'native', nativeCapabilities({
    loaderFile: 'src/main/session-loader.ts#buildSessionSummary',
    thinking: unavailable(
      'Thinking blocks may be searchable in raw content but are not preserved in normalized session detail.',
      loader,
      searchIndex
    ),
    usage: available(loader, test('src/main/token-accounting.test.ts')),
    relationships: available(loader, test('src/main/session-lineage.test.ts')),
    subagents: available(loader, test('src/main/session-loader.test.ts')),
    liveWatch: available(watcher, test('src/main/source-directory-watcher.test.ts')),
    search: available(searchIndex, test('src/main/session-search.test.ts')),
    terminalResume: available(resume, test('src/main/resume-audit.test.ts')),
    nativeResume: experimental(
      'Claude Desktop import is opt-in and may rewrite the transcript.',
      resume,
      test('src/main/session-actions.test.ts')
    )
  }), ['claude-jsonl-observed']),

  definition('codex', 'Codex', 'native', nativeCapabilities({
    loaderFile: 'src/main/codex-loader.ts',
    thinking: unavailable('Reasoning content is not preserved by the current normalizer.', implementation('src/main/codex-loader.ts')),
    usage: available(implementation('src/main/codex-loader.ts'), test('src/main/codex-loader.test.ts')),
    relationships: available(implementation('src/main/codex-loader.ts'), test('src/main/session-lineage.test.ts')),
    subagents: available(implementation('src/main/codex-loader.ts'), test('src/main/codex-loader.test.ts')),
    liveWatch: available(watcher, test('src/main/source-directory-watcher.test.ts')),
    search: available(searchIndex, implementation('src/main/codex-loader.ts')),
    terminalResume: available(resume, test('src/main/resume-audit.test.ts')),
    nativeResume: available(resume, test('src/main/session-actions.test.ts'))
  }), ['codex-rollout-jsonl-observed']),

  definition('cursor', 'Cursor', 'native', nativeCapabilities({
    loaderFile: 'src/main/cursor-loader.ts',
    thinking: unavailable('Reasoning parts are deliberately omitted from normalized messages.', implementation('src/main/cursor-loader.ts')),
    usage: unavailable('The current Cursor fixtures contain no authoritative usage counters.', implementation('src/main/cursor-loader.ts')),
    relationships: unavailable('No source relationship parser is implemented.', implementation('src/main/cursor-loader.ts')),
    subagents: unavailable('No Cursor subagent identity parser is implemented.', implementation('src/main/cursor-loader.ts')),
    liveWatch: available(watcher, test('src/main/source-directory-watcher.test.ts')),
    search: experimental('Normalized transcript indexing exists, but source parity is not fully audited.', searchIndex, implementation('src/main/cursor-loader.ts')),
    terminalResume: available(resume, test('src/main/resume-audit.test.ts')),
    nativeResume: unavailable('Cursor exposes no verified per-session desktop deep link.', resume)
  }), ['cursor-agent-jsonl-observed']),

  definition('opencode', 'OpenCode', 'native', nativeCapabilities({
    loaderFile: 'src/main/opencode-loader.ts',
    thinking: unavailable('Reasoning parts are deliberately ignored by the current normalizer.', implementation('src/main/opencode-loader.ts')),
    usage: available(implementation('src/main/opencode-loader.ts'), test('src/main/opencode-loader.test.ts')),
    relationships: unavailable('No source relationship parser is implemented.', implementation('src/main/opencode-loader.ts')),
    subagents: unavailable('No OpenCode subagent identity parser is implemented.', implementation('src/main/opencode-loader.ts')),
    liveWatch: unavailable('No OpenCode source watcher is registered.', watcher),
    search: experimental('Normalized SQLite transcript indexing exists, but full parity is not audited.', searchIndex, implementation('src/main/opencode-loader.ts')),
    terminalResume: available(resume, test('src/main/resume-audit.test.ts')),
    nativeResume: unavailable('No verified per-session desktop deep link is implemented.', resume)
  }), ['opencode-sqlite-observed']),

  definition('zcode', 'ZCode', 'native', nativeCapabilities({
    loaderFile: 'src/main/zcode-loader.ts',
    thinking: unavailable('Reasoning parts are not preserved by the OpenCode-family normalizer.', implementation('src/main/opencode-loader.ts')),
    usage: available(implementation('src/main/zcode-loader.ts'), test('src/main/zcode-loader.test.ts')),
    relationships: unavailable('No source relationship parser is implemented.', implementation('src/main/zcode-loader.ts')),
    subagents: unavailable('No ZCode subagent identity parser is implemented.', implementation('src/main/zcode-loader.ts')),
    liveWatch: unavailable('No ZCode source watcher is registered.', watcher),
    search: experimental('Normalized SQLite transcript indexing exists, but full parity is not audited.', searchIndex, implementation('src/main/zcode-loader.ts')),
    terminalResume: unavailable('ZCode has no verified public CLI resume entry point.', resume),
    nativeResume: experimental('The deep link opens a workspace, not a verified specific session.', resume, test('src/main/session-actions.test.ts'))
  }), ['zcode-sqlite-observed']),

  definition('cc-mirror', 'CC-Mirror', 'compatible', {
    discover: available(loader, compatibility('Claude JSONL compatibility')),
    summary: available(loader, compatibility('Claude JSONL compatibility')),
    transcript: available(loader, compatibility('Claude JSONL compatibility')),
    tools: available(loader, compatibility('Claude JSONL compatibility')),
    thinking: unavailable(
      'Claude-compatible thinking blocks are not preserved in normalized session detail.',
      loader,
      compatibility('Claude JSONL compatibility')
    ),
    usage: available(loader, compatibility('Claude JSONL compatibility')),
    relationships: experimental('Claude-compatible lineage is reused but mirror-specific lineage is not audited.', loader),
    subagents: experimental('Claude-compatible subagent loading exists but mirror-specific layouts are not audited.', loader),
    'live-watch': unavailable('No CC-Mirror source watcher is registered.', watcher),
    search: available(searchIndex, compatibility('Claude JSONL compatibility')),
    archive: available(archive, compatibility('Claude JSONL compatibility')),
    'terminal-resume': experimental('The Claude command is reused without an independently audited mirror config root.', resume),
    'native-resume': notApplicable('No CC-Mirror-specific native session entry point exists.', resume),
    'format-provenance': unavailable('Compatibility is known, but records do not carry an authoritative mirror format version.', loader)
  }, ['claude-jsonl-compatible']),

  definition('antigravity', 'Antigravity', 'detection-only', detectionOnlyCapabilities('antigravity')),
  definition('grok', 'Grok / Factory', 'detection-only', detectionOnlyCapabilities('grok')),
  definition('pi', 'Pi', 'detection-only', detectionOnlyCapabilities('pi')),
  definition('kimi', 'Kimi Code', 'detection-only', detectionOnlyCapabilities('kimi')),
  definition('hermes', 'Hermes', 'detection-only', detectionOnlyCapabilities('hermes'))
] as const

const definitionsBySource = new Map(
  BUILTIN_PROVIDER_DEFINITIONS.map((entry) => [entry.sourceId, entry])
)

const definitionsByProvider = new Map(
  BUILTIN_PROVIDER_DEFINITIONS.map((entry) => [entry.manifest.providerId, entry])
)

export function isLegacySessionSource(value: string): value is LegacySessionSource {
  return definitionsBySource.has(value as LegacySessionSource)
}

export function builtinProviderForSource(source: string): BuiltinProviderDefinition | undefined {
  return definitionsBySource.get(source as LegacySessionSource)
}

export function builtinProviderForId(providerId: string): BuiltinProviderDefinition | undefined {
  return definitionsByProvider.get(providerId)
}

export function providerCapabilitiesForSource(source: string): ProviderCapabilities | undefined {
  return builtinProviderForSource(source)?.manifest.capabilities
}

export function providerCanParseTranscript(source: string): boolean {
  const status = providerCapabilitiesForSource(source)?.transcript.status
  return status === 'available' || status === 'experimental'
}

export function currentProviderCapabilitySnapshot(): Array<{
  providerId: string
  sourceId: LegacySessionSource
  displayName: string
  tier: BuiltinProviderTier
  capabilities: ProviderCapabilities
}> {
  return BUILTIN_PROVIDER_DEFINITIONS.map((entry) => ({
    providerId: entry.manifest.providerId,
    sourceId: entry.sourceId,
    displayName: entry.manifest.displayName,
    tier: entry.tier,
    capabilities: entry.manifest.capabilities
  }))
}
