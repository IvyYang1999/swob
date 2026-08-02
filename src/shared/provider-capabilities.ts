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
  'hermes',
  'qoder',
  'trae',
  'gemini'
] as const

export type LegacySessionSource = typeof LEGACY_SESSION_SOURCES[number]
export type BuiltinProviderTier = 'native' | 'compatible' | 'detection-only'
export type BuiltinProviderIngestion = 'legacy-loader' | 'provider-host' | 'detection-only'
export type ValuationCapabilityStatus = 'billable-exact' | 'estimate-only' | 'unavailable'

export interface ValuationCapability {
  status: ValuationCapabilityStatus
  /** Why this is the strongest honest status, including any exact-pricing preconditions. */
  reason: string
  evidence: CapabilityEvidence[]
}

export interface BuiltinProviderDefinition {
  sourceId: LegacySessionSource
  tier: BuiltinProviderTier
  ingestion: BuiltinProviderIngestion
  adapterContract: 'provider-protocol-v2' | 'legacy'
  /** Registry-only product truth. This deliberately does not change Provider protocol wire schemas. */
  valuation: ValuationCapability
  manifest: ProviderManifest
}

const V2_ADAPTER_SOURCES = new Set<LegacySessionSource>([
  'claude-code', 'codex', 'cursor', 'opencode', 'zcode', 'cc-mirror',
  'antigravity', 'grok', 'pi', 'kimi', 'hermes', 'qoder', 'trae', 'gemini'
])

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

const valuation = (
  status: ValuationCapabilityStatus,
  reason: string,
  ...evidence: CapabilityEvidence[]
): ValuationCapability => ({ status, reason, evidence })

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

const perCallPricingFixture = (sourceId: LegacySessionSource, note: string): CapabilityEvidence => test(
  `testdata/valuation/per-call-pricing-evidence.json#${sourceId}`,
  `Per-call pricing evidence fixture. ${note}`
)

/**
 * Valuation is a separate product capability from usage measurement.
 * A source is billable-exact only when one billable call retains its mutually
 * exclusive counters plus price evidence (reported amount, or model + billing
 * provider + event time against an approved catalog rule). Aggregate counters
 * can be useful measurements without being exact pricing evidence.
 */
export const VALUATION_CAPABILITIES = {
  'claude-code': valuation(
    'billable-exact',
    'Per-request usage retains model, billing-provider attribution, event time, and cache buckets; exact catalog matches or explicit harness estimates remain separately labelled.',
    implementation('src/main/token-accounting.ts#usageEventsFromClaudeMessages'),
    implementation('src/main/token-valuation.ts#valueUsageEvent'),
    perCallPricingFixture('claude-code', 'One Claude request matches a dated approved Anthropic rule.')
  ),
  codex: valuation(
    'billable-exact',
    'Per-turn or cumulative-delta events retain model, billing-provider attribution, event time, and OpenAI cache/reasoning relations after deduplication.',
    implementation('src/main/token-accounting.ts#usageEventsFromCodexSnapshots'),
    implementation('src/main/token-valuation.ts#valueUsageEvent'),
    perCallPricingFixture('codex', 'One normalized Codex delta matches a dated approved OpenAI rule.')
  ),
  cursor: valuation(
    'unavailable',
    'The evidenced Cursor format has no authoritative usage counters, so there is no honest amount to price.',
    implementation('src/main/cursor-loader.ts'),
    test('src/main/cursor-loader.test.ts')
  ),
  opencode: valuation(
    'billable-exact',
    'Conditional: each assistant message now retains explicit providerID, modelID, event time, disjoint cache buckets, and visible-output/reasoning evidence; exact pricing still requires a matching approved rule or explicit reported amount.',
    implementation('src/main/opencode-loader.ts'),
    implementation('src/main/sqlite-agent-usage.ts#accountOpenCodeMessageUsage'),
    test('src/main/sqlite-agent-usage-golden.test.ts'),
    perCallPricingFixture('opencode', 'One OpenCode message preserves the explicit OpenAI route, model, event time, and normalized request buckets.')
  ),
  zcode: valuation(
    'billable-exact',
    'Conditional: each model_usage attempt now retains explicit provider_id, model_id, started_at, cache-subset buckets, and authoritative computed_total_tokens; exact pricing still requires a matching approved rule.',
    implementation('src/main/zcode-loader.ts'),
    implementation('src/main/sqlite-agent-usage.ts#accountZCodeModelUsage'),
    test('src/main/sqlite-agent-usage-golden.test.ts'),
    perCallPricingFixture('zcode', 'One ZCode model_usage attempt preserves the explicit Anthropic route, model, event time, and authoritative total.')
  ),
  'cc-mirror': valuation(
    'billable-exact',
    'Conditional: exact pricing is allowed only when a per-request record proves the billing route plus model and event time, or carries an explicit amount. Claude JSON compatibility alone does not prove Anthropic pricing.',
    implementation('src/main/token-accounting.ts#usageEventsFromClaudeMessages'),
    compatibility('Claude JSONL usage buckets; billing route must be independently evidenced.'),
    perCallPricingFixture('cc-mirror', 'The fixture includes an explicit verified Anthropic billing route; the condition is part of conformance.')
  ),
  antigravity: valuation(
    'estimate-only',
    'Only a pinned reverse-engineered SQLite mapping yields per-turn counters; no reviewed per-call price or trusted reported amount is preserved.',
    implementation('src/main/providers/antigravity-provider.ts'),
    test('src/main/providers/antigravity-provider.test.ts')
  ),
  grok: valuation(
    'billable-exact',
    'Conditional: exact pricing requires a complete per-turn model row whose provider-produced costUsdTicks passed the parser trust checks; incomplete or aggregate-only rows are not exact.',
    implementation('src/main/providers/grok-provider.ts'),
    perCallPricingFixture('grok', 'The pinned synthetic model row carries trusted provider cost ticks for one turn.')
  ),
  pi: valuation(
    'billable-exact',
    'Conditional: exact pricing requires explicit per-message usage.cost, or a per-message model, verified billing provider, and event time matching an approved rule; a model name alone is insufficient.',
    implementation('src/main/providers/pi-provider.ts'),
    perCallPricingFixture('pi', 'The Pi v3 fixture carries an explicit cost on one assistant message.')
  ),
  kimi: valuation(
    'estimate-only',
    'Per-turn counters are retained, but cache TTL, reasoning relation, and reviewed per-call price evidence are incomplete.',
    implementation('src/main/providers/kimi-provider.ts'),
    test('src/main/providers/kimi-provider.test.ts')
  ),
  hermes: valuation(
    'estimate-only',
    'Hermes preserves cumulative session or per-model counters and reported aggregate cost, but not a complete per-call price trace.',
    implementation('src/main/providers/hermes-provider.ts'),
    test('src/main/providers/hermes-provider.test.ts')
  ),
  qoder: valuation(
    'estimate-only',
    'Raw per-message usage is retained, but cache relations are provider-defined and the compatibility projection intentionally withholds the ambiguous product aggregate.',
    implementation('src/main/providers/qoder-provider.ts'),
    test('src/main/providers/qoder-provider.test.ts')
  ),
  trae: valuation(
    'unavailable',
    'No authoritative usage counters exist in the evidenced Trae layout, so valuation is unavailable rather than zero.',
    implementation('src/main/providers/trae-provider.ts'),
    test('src/main/providers/trae-provider.test.ts')
  ),
  gemini: valuation(
    'estimate-only',
    'Per-request prompt, cache, candidate and thoughts counters retain exact measurement semantics, but no reviewed dated Google pricing rule or provider-reported cost is attached to each call.',
    implementation('src/main/providers/gemini-provider.ts'),
    test('src/main/providers/gemini-provider.test.ts')
  )
} as const satisfies Record<LegacySessionSource, ValuationCapability>

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
    archive: unavailable(
      'The archive call chain rejects this source; no physical source path is copied.',
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

function piCanonicalCapabilities(): ProviderCapabilities {
  const provider = implementation('src/main/providers/pi-provider.ts')
  const host = implementation('src/main/provider-host.ts')
  const canonicalStore = implementation('src/main/canonical-store.ts')
  const fixture = test('src/main/provider-runtime.test.ts', 'Synthetic Pi full-chain fixture.')
  return {
    discover: available(provider, host, fixture),
    summary: available(provider, canonicalStore, fixture),
    transcript: available(provider, canonicalStore, fixture),
    tools: available(provider, fixture),
    thinking: available(provider, fixture),
    usage: available(provider, fixture),
    relationships: available(provider, fixture),
    subagents: unavailable('The Pi parent/branch relation is parsed; a verified spawned-child fixture is not yet available.', provider),
    'live-watch': unavailable('Pi is refreshed by provider discovery; no dedicated live watcher is registered.', watcher),
    search: available(searchIndex, canonicalStore, fixture),
    archive: available(archive, canonicalStore, fixture),
    'terminal-resume': experimental('The Pi CLI resume mapping is inferred and has no source-level resume audit.', resume),
    'native-resume': notApplicable('Pi exposes no verified native per-session entry point.', resume),
    'format-provenance': available(provider, canonicalStore, fixture)
  }
}

function kimiCanonicalCapabilities(): ProviderCapabilities {
  const provider = implementation('src/main/providers/kimi-provider.ts')
  const host = implementation('src/main/provider-host.ts#runProviderV2')
  const projection = implementation('src/main/provider-v2-consumer-projection.ts', 'Lossy read model for existing consumers; v2 remains authoritative.')
  const fixture = test('src/main/providers/kimi-provider.test.ts', 'Synthetic native, migrated and subagent wires.')
  return {
    discover: available(provider, host, fixture),
    summary: available(provider, projection, fixture),
    transcript: available(provider, projection, fixture),
    tools: available(provider, projection, fixture),
    thinking: available(provider, projection, fixture),
    usage: available(provider, projection, fixture),
    relationships: available(provider, fixture),
    subagents: available(provider, fixture),
    'live-watch': unavailable('Kimi is refreshed by provider discovery; no dedicated live watcher is registered.', watcher),
    search: available(searchIndex, projection, fixture),
    archive: available(archive, projection, fixture),
    'terminal-resume': experimental(
      'The kimi --session contract is source-audited, but launch-after-anchor verification is not wired into the action path.',
      resume,
      test('src/main/session-actions.test.ts')
    ),
    'native-resume': notApplicable('Kimi Code exposes a CLI session entry point, not a desktop deep link.', resume),
    'format-provenance': available(provider, host, fixture)
  }
}

function grokCanonicalCapabilities(): ProviderCapabilities {
  const provider = implementation('src/main/providers/grok-provider.ts')
  const host = implementation('src/main/provider-host.ts')
  const canonicalStore = implementation('src/main/canonical-store.ts')
  const projection = implementation('src/main/provider-v2-consumer-projection.ts')
  const fixture = test('src/main/providers/grok-provider.test.ts', 'Fully synthetic Grok Build composite and compaction fixture.')
  return {
    discover: available(provider, host, fixture),
    summary: available(provider, projection, fixture),
    transcript: available(provider, projection, fixture),
    tools: available(provider, projection, fixture),
    thinking: available(provider, projection, fixture),
    usage: available(provider, canonicalStore, fixture),
    relationships: available(provider, fixture),
    subagents: unavailable('Parent/fork identity is parsed, but no verified child-agent event stream is available.', provider, fixture),
    'live-watch': unavailable('Grok Build is refreshed by provider discovery; no dedicated live watcher is registered.', watcher),
    search: available(searchIndex, projection, fixture),
    archive: available(archive, projection, fixture),
    'terminal-resume': unavailable(
      'Upstream documents grok --resume, but binary/help/source/post-launch anchor verification could not run on this build machine.',
      provider,
      fixture
    ),
    'native-resume': notApplicable('Grok Build exposes no verified native desktop deep link.', provider),
    'format-provenance': available(provider, canonicalStore, fixture)
  }
}

function antigravityCanonicalCapabilities(): ProviderCapabilities {
  const provider = implementation('src/main/providers/antigravity-provider.ts')
  const fixture = test(
    'src/main/providers/antigravity-provider.test.ts',
    'Synthetic JSONL, Markdown and known-schema SQLite conformance fixtures.'
  )
  const officialStorage = {
    kind: 'official-documentation' as const,
    locator: 'https://antigravity.google/docs/hooks',
    note: 'Google documents conversationId and the persistent transcript.jsonl path.'
  }
  return {
    discover: available(provider, officialStorage, fixture),
    summary: available(provider, fixture),
    transcript: available(provider, officialStorage, fixture),
    tools: available(provider, fixture),
    thinking: available(provider, fixture),
    usage: experimental(
      'Only the pinned known SQLite schema exposes provider-produced gen_metadata counters. The field mapping is reverse-engineered; JSONL, Markdown, and encrypted protobuf usage remain unavailable. Swob never applies chars/4.',
      provider,
      fixture
    ),
    relationships: experimental(
      'Structured subagent conversationId results are linked; other relationship encodings remain unavailable.',
      provider,
      fixture
    ),
    subagents: experimental(
      'Structured INVOKE_SUBAGENT results are parsed, but a real installed-version fixture is still required.',
      provider,
      fixture
    ),
    'live-watch': unavailable('Antigravity is refreshed by provider discovery; no dedicated live watcher is registered.', watcher),
    search: available(searchIndex, provider, fixture),
    archive: available(archive, provider, fixture),
    'terminal-resume': experimental(
      'Google documents agy --conversation. Swob probes the installed binary for that exact long flag before launch, but does not yet observe a post-launch source/message anchor, so Resume success is not verified.',
      provider,
      officialStorage,
      fixture
    ),
    'native-resume': notApplicable('No verified per-session Antigravity desktop deep link is published.', resume),
    'format-provenance': available(provider, fixture)
  }
}

function hermesCanonicalCapabilities(): ProviderCapabilities {
  const provider = implementation('src/main/providers/hermes-provider.ts')
  const host = implementation('src/main/provider-host.ts')
  const canonicalStore = implementation('src/main/canonical-store.ts')
  const fixture = test('src/main/providers/hermes-provider.test.ts', 'Synthetic JSON/state.db plus full-chain fixture.')
  return {
    discover: available(provider, host, fixture),
    summary: available(provider, canonicalStore, fixture),
    transcript: available(provider, canonicalStore, fixture),
    tools: available(provider, fixture),
    thinking: available(provider, fixture),
    usage: experimental(
      'Authoritative aggregate counters are preserved, but exact per-model attribution requires session_model_usage evidence.',
      provider,
      fixture
    ),
    relationships: experimental(
      'Continuation, branch and delegate relationships are reported only when their Hermes markers are provable.',
      provider,
      fixture
    ),
    subagents: experimental('Only explicit Hermes delegate markers prove a delegated child session.', provider, fixture),
    'live-watch': unavailable('Hermes is refreshed by provider discovery; no dedicated live watcher is registered.', watcher),
    search: available(searchIndex, canonicalStore, fixture),
    archive: available(archive, canonicalStore, fixture),
    'terminal-resume': experimental(
      'hermes --resume is source-audited for state.db sessions, but post-launch anchor verification is not enforced.',
      resume,
      fixture
    ),
    'native-resume': notApplicable('Hermes exposes a CLI resume surface, not a native application deep link.', resume),
    'format-provenance': available(provider, canonicalStore, fixture)
  }
}

function traeCanonicalCapabilities(): ProviderCapabilities {
  const provider = implementation('src/main/providers/trae-provider.ts')
  const host = implementation('src/main/provider-host.ts')
  const canonicalStore = implementation('src/main/canonical-store.ts')
  const fixture = test(
    'src/main/providers/trae-provider.test.ts',
    'Fully synthetic legacy state.vscdb full-chain fixture.'
  )
  return {
    discover: experimental(
      'Legacy plaintext state.vscdb is supported; current ModularData is encrypted and unavailable.',
      provider,
      host,
      fixture
    ),
    summary: experimental('Summary metadata is exact only for the evidenced legacy layout.', provider, fixture),
    transcript: experimental('Transcript parsing is exact only for the evidenced legacy layout.', provider, fixture),
    tools: unavailable('No verified Trae plaintext field exposes tool calls or results.', provider),
    thinking: unavailable('No verified Trae plaintext field distinguishes model thinking.', provider),
    usage: unavailable('No authoritative usage counters exist in the evidenced Trae layout.', provider),
    relationships: unavailable('No verified parent, fork, or continuation field exists.', provider),
    subagents: unavailable('No verified subagent identity field exists.', provider),
    'live-watch': unavailable('Trae is refreshed by provider discovery; no dedicated live watcher is registered.', watcher),
    search: experimental('Search is available for parsed legacy transcripts only.', searchIndex, canonicalStore, fixture),
    archive: experimental('Library archive is available for parsed legacy transcripts only.', archive, canonicalStore, fixture),
    'terminal-resume': unavailable('No verified Trae per-session CLI resume command exists.', resume),
    'native-resume': unavailable('No verified Trae per-session deep link with a source postcondition exists.', resume),
    'format-provenance': available(provider, canonicalStore, fixture)
  }
}

function qoderCanonicalCapabilities(): ProviderCapabilities {
  const provider = implementation('src/main/providers/qoder-provider.ts')
  const host = implementation('src/main/provider-host.ts')
  const fixture = test(
    'src/main/providers/qoder-provider.test.ts',
    'Fully synthetic compound Qoder transcript, sidecar, and subagent fixture.'
  )
  const upstream = {
    kind: 'upstream-source' as const,
    locator: 'https://github.com/kenn-io/agentsview/tree/1cd581fe34e87e134160c6668deffb674b7eaa4e/internal/parser',
    note: 'Pinned independent reference; no public first-party producer schema was available.'
  }
  return {
    discover: available(provider, host, fixture),
    summary: available(provider, fixture, upstream),
    transcript: available(provider, fixture, upstream),
    tools: available(provider, fixture, upstream),
    thinking: experimental(
      'Thinking blocks are decoded when persisted, but no public Qoder producer schema proves every surface writes them.',
      provider,
      fixture,
      upstream
    ),
    usage: experimental(
      'Persisted message.usage counters are preserved in v2 without estimation; cache relations are unproven, so the compatible product aggregate remains unavailable.',
      provider,
      fixture,
      upstream
    ),
    relationships: available(provider, fixture, upstream),
    subagents: available(provider, fixture, upstream),
    'live-watch': unavailable(
      'Qoder is refreshed by provider discovery; no dedicated live watcher is registered.',
      watcher
    ),
    search: available(searchIndex, host, fixture),
    archive: available(archive, host, fixture),
    'terminal-resume': experimental(
      'Official qodercli documents -r <session-id>, but no authenticated launch-after-anchor observation is recorded.',
      resume,
      {
        kind: 'official-documentation',
        locator: 'https://docs.qoder.com/zh/cli/using-cli'
      }
    ),
    'native-resume': unavailable(
      'Opening the Qoder IDE or a task view is not evidence that a specific transcript resumes correctly.',
      resume
    ),
    'format-provenance': experimental(
      'Compound layout is pinned to an independent reference; no public first-party producer schema or local authenticated sample was available.',
      provider,
      fixture,
      upstream
    )
  }
}

function geminiCanonicalCapabilities(): ProviderCapabilities {
  const provider = implementation('src/main/providers/gemini-provider.ts')
  const host = implementation('src/main/provider-host.ts')
  const projection = implementation('src/main/provider-v2-consumer-projection.ts')
  const fixture = test(
    'src/main/providers/gemini-provider.test.ts',
    'Fully synthetic first-party-shaped JSONL, legacy JSON and nested subagent fixtures.'
  )
  const upstream = {
    kind: 'upstream-source' as const,
    locator: 'https://github.com/google-gemini/gemini-cli/tree/f47d6c6f7a1308d81f9f57acf7d279f0928c5249/packages/core/src/services',
    note: 'Pinned first-party Apache-2.0 chat recording types and service.'
  }
  return {
    discover: available(provider, host, fixture, upstream),
    summary: available(provider, projection, fixture, upstream),
    transcript: available(provider, projection, fixture, upstream),
    tools: available(provider, projection, fixture, upstream),
    thinking: available(provider, projection, fixture, upstream),
    usage: available(provider, projection, fixture, upstream),
    relationships: experimental(
      'Subagent parent identity is derived from the official nested path because the child record has no explicit parentSessionId.',
      provider,
      fixture,
      upstream
    ),
    subagents: experimental(
      'Nested subagent sessions are supported, but parent identity is path-derived.',
      provider,
      fixture,
      upstream
    ),
    'live-watch': unavailable('Gemini CLI is refreshed by provider discovery; no dedicated live watcher is registered.', watcher),
    search: available(searchIndex, projection, fixture),
    archive: available(archive, projection, fixture),
    'terminal-resume': experimental(
      'The local gemini 0.38.2 binary and --resume help capability were observed, but no authenticated post-launch content-anchor match is recorded.',
      resume,
      test('src/main/providers/gemini-provider.test.ts'),
      {
        kind: 'official-documentation',
        locator: 'https://github.com/google-gemini/gemini-cli/blob/f47d6c6f7a1308d81f9f57acf7d279f0928c5249/docs/reference/configuration.md'
      }
    ),
    'native-resume': notApplicable('Gemini CLI exposes a terminal resume surface, not a desktop deep link.', resume),
    'format-provenance': available(provider, host, fixture, upstream)
  }
}

function definition(
  sourceId: LegacySessionSource,
  displayName: string,
  tier: BuiltinProviderTier,
  capabilities: ProviderCapabilities,
  formatVersions: string[] = [],
  ingestion: BuiltinProviderIngestion = tier === 'detection-only' ? 'detection-only' : 'legacy-loader'
): BuiltinProviderDefinition {
  return {
    sourceId,
    tier,
    ingestion,
    adapterContract: V2_ADAPTER_SOURCES.has(sourceId) ? 'provider-protocol-v2' : 'legacy',
    valuation: VALUATION_CAPABILITIES[sourceId],
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
    thinking: available(loader, test('src/main/unified-session-adapter-v2.test.ts')),
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
    thinking: available(implementation('src/main/codex-loader.ts'), test('src/main/codex-loader.test.ts')),
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
    thinking: available(implementation('src/main/cursor-loader.ts'), test('src/main/cursor-loader.test.ts')),
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
    thinking: available(implementation('src/main/opencode-loader.ts'), test('src/main/opencode-loader.test.ts')),
    usage: available(implementation('src/main/opencode-loader.ts'), test('src/main/opencode-loader.test.ts')),
    relationships: available(implementation('src/main/opencode-loader.ts'), test('src/main/opencode-loader.test.ts')),
    subagents: unavailable('No OpenCode subagent identity parser is implemented.', implementation('src/main/opencode-loader.ts')),
    liveWatch: unavailable('No OpenCode source watcher is registered.', watcher),
    search: experimental('Normalized SQLite transcript indexing exists, but full parity is not audited.', searchIndex, implementation('src/main/opencode-loader.ts')),
    terminalResume: available(resume, test('src/main/resume-audit.test.ts')),
    nativeResume: unavailable('No verified per-session desktop deep link is implemented.', resume)
  }), ['opencode-sqlite-observed']),

  definition('zcode', 'ZCode', 'native', nativeCapabilities({
    loaderFile: 'src/main/zcode-loader.ts',
    thinking: available(implementation('src/main/opencode-loader.ts'), test('src/main/zcode-loader.test.ts')),
    usage: available(implementation('src/main/zcode-loader.ts'), test('src/main/zcode-loader.test.ts')),
    relationships: available(implementation('src/main/zcode-loader.ts'), test('src/main/zcode-loader.test.ts')),
    subagents: unavailable('No ZCode subagent identity parser is implemented.', implementation('src/main/zcode-loader.ts')),
    liveWatch: unavailable('No ZCode source watcher is registered.', watcher),
    search: experimental('Normalized SQLite transcript indexing exists, but full parity is not audited.', searchIndex, implementation('src/main/zcode-loader.ts')),
    terminalResume: unavailable('没有公开 CLI Resume', resume),
    nativeResume: experimental('The deep link opens a workspace, not a verified specific session.', resume, test('src/main/session-actions.test.ts'))
  }), ['zcode-sqlite-observed']),

  definition('cc-mirror', 'CC-Mirror', 'compatible', {
    discover: available(loader, compatibility('Claude JSONL compatibility')),
    summary: available(loader, compatibility('Claude JSONL compatibility')),
    transcript: available(loader, compatibility('Claude JSONL compatibility')),
    tools: available(loader, compatibility('Claude JSONL compatibility')),
    thinking: available(loader, test('src/main/unified-session-adapter-v2.test.ts')),
    usage: available(loader, compatibility('Claude JSONL compatibility')),
    relationships: experimental('Claude-compatible lineage is reused but mirror-specific lineage is not audited.', loader),
    subagents: experimental('Claude-compatible subagent loading exists but mirror-specific layouts are not audited.', loader),
    'live-watch': unavailable('No CC-Mirror source watcher is registered.', watcher),
    search: available(searchIndex, compatibility('Claude JSONL compatibility')),
    archive: unavailable(
      'The archive path allowlist excludes .cc-mirror sources.',
      archive,
      compatibility('Claude JSONL compatibility does not imply archive path eligibility.')
    ),
    'terminal-resume': experimental('The Claude command is reused without an independently audited mirror config root.', resume),
    'native-resume': notApplicable('No CC-Mirror-specific native session entry point exists.', resume),
    'format-provenance': unavailable('Compatibility is known, but records do not carry an authoritative mirror format version.', loader)
  }, ['claude-jsonl-compatible']),

  definition('antigravity', 'Antigravity', 'native', antigravityCanonicalCapabilities(), [
    'antigravity-step-jsonl-v1',
    'antigravity-sqlite-1.0.7-1.0.10',
    'antigravity-brain-markdown-v1',
    'antigravity-encrypted-protobuf-unknown'
  ], 'provider-host'),
  definition('grok', 'Grok Build', 'native', grokCanonicalCapabilities(), [
    'grok-build-composite-v0',
    'grok-build-composite-v1',
    'grok-build-composite-mixed-v0-v1'
  ], 'provider-host'),
  definition('pi', 'Pi', 'native', piCanonicalCapabilities(), [
    'pi-jsonl-v1',
    'pi-jsonl-v2',
    'pi-jsonl-v3'
  ], 'provider-host'),
  definition('kimi', 'Kimi Code', 'native', kimiCanonicalCapabilities(), [
    'kimi-code-wire-native-v1.5',
    'kimi-code-wire-migrated-v1.0'
  ], 'provider-host'),
  definition('hermes', 'Hermes', 'native', hermesCanonicalCapabilities(), [
    'hermes-state-db-v1-plus',
    'hermes-json-snapshot-v1'
  ], 'provider-host'),
  definition('qoder', 'Qoder', 'native', qoderCanonicalCapabilities(), [
    'qoder-project-jsonl-compound-reference-v1'
  ], 'provider-host'),
  definition('trae', 'Trae', 'native', traeCanonicalCapabilities(), [
    'trae-state-vscdb-legacy-v1'
  ], 'provider-host'),
  definition('gemini', 'Gemini CLI', 'native', geminiCanonicalCapabilities(), [
    'gemini-cli-conversation-jsonl-v2',
    'gemini-cli-conversation-json-v1'
  ], 'provider-host')
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

export function providerUsesCanonicalRuntime(source: string): boolean {
  return builtinProviderForSource(source)?.ingestion === 'provider-host'
}

export function providerCapabilitiesForSource(source: string): ProviderCapabilities | undefined {
  return builtinProviderForSource(source)?.manifest.capabilities
}

export function valuationCapabilityForSource(source: string): ValuationCapability {
  return builtinProviderForSource(source)?.valuation ?? valuation(
    'unavailable',
    'This source is not registered, so Swob has no audited valuation contract for it.'
  )
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
  valuation: ValuationCapability
  capabilities: ProviderCapabilities
}> {
  return BUILTIN_PROVIDER_DEFINITIONS.map((entry) => ({
    providerId: entry.manifest.providerId,
    sourceId: entry.sourceId,
    displayName: entry.manifest.displayName,
    tier: entry.tier,
    valuation: entry.valuation,
    capabilities: entry.manifest.capabilities
  }))
}
