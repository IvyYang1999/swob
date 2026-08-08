import type { ResumeContract } from './provider-schema-v2.generated'
import type { LegacySessionSource } from './provider-capabilities'

/** The seven P1 sources that share the same Provider Protocol v2 adapter boundary. */
export const UNIFIED_PROVIDER_SOURCES = [
  'claude-code', 'codex', 'cursor', 'opencode', 'zcode', 'cc-mirror', 'pi'
] as const satisfies readonly LegacySessionSource[]

export type UnifiedProviderSource = typeof UNIFIED_PROVIDER_SOURCES[number]

export const PROVIDER_ADAPTER_LAYERS = [
  'discovery', 'metadata', 'messages', 'tools',
  'system-compact', 'usage', 'relationships', 'resume'
] as const

export type ProviderAdapterLayer = typeof PROVIDER_ADAPTER_LAYERS[number]
export type ProviderAdapterTruth = 'exact' | 'derived' | 'estimated' | 'unavailable'

export const PROVIDER_ADAPTER_LAYER_LABELS: Record<ProviderAdapterLayer, string> = {
  discovery: '发现',
  metadata: '元数据',
  messages: '消息',
  tools: '工具',
  'system-compact': '系统+compact',
  usage: 'Token',
  relationships: '关系',
  resume: 'Resume'
}

export interface ProviderAdapterLayerEvidence {
  truth: ProviderAdapterTruth
  reason: string
  fixture: string
  conformanceTestId: string
}

export interface ProviderFormatGeneration {
  id: string
  support: ProviderAdapterTruth
  reason: string
}

export interface UnifiedProviderDescriptorV2 {
  sourceId: UnifiedProviderSource
  providerId: `swob/${UnifiedProviderSource}`
  displayName: string
  formatVersions: ProviderFormatGeneration[]
  layers: Record<ProviderAdapterLayer, ProviderAdapterLayerEvidence>
  usageSemantics: string
  resumeContract: ResumeContract
  legacyFallback: 'providerAdapterMode=legacy'
}

type LayerSpec = Record<ProviderAdapterLayer, readonly [ProviderAdapterTruth, string]>

function makeResumeContract(
  commandTemplate: string,
  supportedSurfaces: string[],
  supportsSubagent = false
): ResumeContract {
  return {
    mode: 'native-cli',
    supportedSurfaces,
    supportsSubagent,
    idTransform: null,
    preflight: ['binary', 'version', 'help-capability', 'source-exists'],
    commandTemplate,
    expectedSideEffects: [
      'resume-target-must-retain-source-identity',
      'verify-last-user-and-assistant-anchors'
    ],
    postcondition: 'anchor-match'
  }
}

const exact = (reason: string) => ['exact', reason] as const
const derived = (reason: string) => ['derived', reason] as const
const unavailable = (reason: string) => ['unavailable', reason] as const

function makeDescriptor(input: {
  sourceId: UnifiedProviderSource
  displayName: string
  formats: ProviderFormatGeneration[]
  layers: LayerSpec
  usageSemantics: string
  resumeContract: ResumeContract
}): UnifiedProviderDescriptorV2 {
  const fixturePath = `testdata/provider-v2/${input.sourceId}.json`
  const testIdBase = `T173-${input.sourceId.toUpperCase().replace(/-/g, '_')}`
  const layers = Object.fromEntries(PROVIDER_ADAPTER_LAYERS.map((layer) => {
    const [truth, reason] = input.layers[layer]
    return [layer, {
      truth,
      reason,
      fixture: fixturePath,
      conformanceTestId: `${testIdBase}-${layer.toUpperCase().replace(/-/g, '_')}`
    }]
  })) as Record<ProviderAdapterLayer, ProviderAdapterLayerEvidence>
  return {
    sourceId: input.sourceId,
    providerId: `swob/${input.sourceId}`,
    displayName: input.displayName,
    formatVersions: input.formats,
    layers,
    usageSemantics: input.usageSemantics,
    resumeContract: input.resumeContract,
    legacyFallback: 'providerAdapterMode=legacy'
  }
}

const claudeDescriptor = makeDescriptor({
  sourceId: 'claude-code',
  displayName: 'Claude Code',
  formats: [{ id: 'claude-jsonl-observed', support: 'exact', reason: 'Block-rich JSONL fixture covers content and lifecycle rows.' }],
  layers: {
    discovery: exact('Verified project roots and JSONL layouts.'),
    metadata: exact('IDs, cwd, model, timestamps and permission mode are source fields.'),
    messages: exact('Ordered text, thinking, redacted thinking and image blocks.'),
    tools: exact('Call IDs, results and source order use the v2 tool registry.'),
    'system-compact': exact('Hook/system rows and compact or microcompact boundaries are explicit.'),
    usage: exact('Message/request aliases deduplicate reported usage snapshots.'),
    relationships: exact('Continuation, fork, branch and subagent evidence is structured.'),
    resume: exact('Native resume requires source identity and anchor postconditions.')
  },
  usageSemantics: 'Input/cache/output buckets are disjoint; aliases select one billing fact.',
  resumeContract: makeResumeContract('claude --resume {sessionId}', ['terminal'], true)
})

const codexDescriptor = makeDescriptor({
  sourceId: 'codex',
  displayName: 'Codex',
  formats: [{ id: 'codex-rollout-jsonl-observed', support: 'exact', reason: 'response_item and event_msg form one ordered stream.' }],
  layers: {
    discovery: exact('rollout JSONL discovery below the Codex sessions root.'),
    metadata: exact('session_meta and turn_context provide surface, cwd and model.'),
    messages: exact('Dual-stream duplicates are removed while reasoning and review remain.'),
    tools: exact('Exec, MCP and patch calls retain IDs, results and order.'),
    'system-compact': exact('Compaction, rollback and review transitions are typed.'),
    usage: derived('Per-turn usage wins; cumulative counters are differenced with reset detection.'),
    relationships: exact('Structured parent, guardian and spawned-agent identities.'),
    resume: exact('CLI/App/VSCode surfaces share source and anchor verification.')
  },
  usageSemantics: 'Cached input is a subset of input and reasoning a subset of output.',
  resumeContract: makeResumeContract('codex resume {sessionId}', ['cli', 'app', 'vscode'], true)
})

const cursorDescriptor = makeDescriptor({
  sourceId: 'cursor',
  displayName: 'Cursor',
  formats: [
    { id: 'cursor-agent-jsonl-observed', support: 'exact', reason: 'Legacy transcript JSONL is direct evidence.' },
    { id: 'cursor-acp-observed', support: 'derived', reason: 'ACP content parts use the ordered block contract.' },
    { id: 'cursor-store-db-observed', support: 'derived', reason: 'store.db is an independent resume anchor source.' }
  ],
  layers: {
    discovery: exact('Transcript and resume-store layouts are discovered separately.'),
    metadata: derived('Workspace/model fields are kept only when observed.'),
    messages: derived('Transcript/ACP blocks preserve order; store.db remains an anchor source, never a fabricated transcript.'),
    tools: exact('ACP/legacy call IDs and results normalize through the registry.'),
    'system-compact': unavailable('No fixture proves Cursor model-context compaction.'),
    usage: unavailable('Local Cursor sources expose no authoritative usage counters.'),
    relationships: unavailable('No stable cross-generation parent/subagent fixture exists.'),
    resume: derived('Agent CLI and IDE store anchors are verified separately.')
  },
  usageSemantics: 'Usage is unavailable; compatibility zeroes never become facts.',
  resumeContract: makeResumeContract('cursor agent --resume {sessionId}', ['agent-cli', 'ide-store'])
})

const opencodeDescriptor = makeDescriptor({
  sourceId: 'opencode',
  displayName: 'OpenCode',
  formats: [{ id: 'opencode-sqlite-observed', support: 'exact', reason: 'SQLite is opened read-only with query_only and WAL visibility.' }],
  layers: {
    discovery: exact('Verified session rows are enumerated from SQLite.'),
    metadata: exact('Session/message rows provide IDs, cwd, model and parent fields.'),
    messages: exact('Text and reasoning parts remain distinct and ordered.'),
    tools: exact('Tool and file/patch parts retain source IDs and input.'),
    'system-compact': unavailable('No fixture proves an OpenCode context revision.'),
    usage: exact('Each assistant message preserves row id, providerID, modelID and event time; exact bucket composition requires row-level tokens.total equality.'),
    relationships: exact('Verified parent fields become relationship facts.'),
    resume: exact('Session row, source DB and resumed anchors must match.')
  },
  usageSemantics: 'OpenCode bucket relations are provider-defined by default. Only rows whose tokens.total proves input + cache.read + cache.write + output + reasoning are normalized as disjoint and eligible for exact valuation.',
  resumeContract: makeResumeContract('opencode --session {sessionId}', ['terminal'])
})

const zcodeDescriptor = makeDescriptor({
  sourceId: 'zcode',
  displayName: 'ZCode',
  formats: [
    { id: 'zcode-sqlite-observed', support: 'exact', reason: 'ZCode shares readonly SQLite snapshot transport only; its path, schema descriptor and fixture are independent.' },
    { id: 'zcode-model-usage-v1', support: 'exact', reason: 'model_usage rows provide one stable record per model attempt.' }
  ],
  layers: {
    discovery: exact('ZCode DB discovery uses its own root and descriptor.'),
    metadata: exact('Only ZCode fixture-proven columns are normalized.'),
    messages: exact('ZCode parts do not inherit OpenCode semantics.'),
    tools: exact('Fixture-proven tool rows use the shared registry.'),
    'system-compact': unavailable('No ZCode fixture proves context compaction.'),
    usage: exact('Completed model_usage rows are accepted only after row-level total/cache checks; source-row and request-attempt identities stay distinct.'),
    relationships: exact('ZCode parent fields remain source relationships.'),
    resume: derived('Workspace deep-link is not treated as session resume; CLI anchors remain authoritative.')
  },
  usageSemantics: 'ZCode uses independent schema/usage semantics while sharing SQLite transport. computed_total_tokens must match a row-proven composition; non-zero reasoning is classified from that equality, while zero-only fixture evidence remains provider-defined.',
  resumeContract: makeResumeContract('zcode --resume {sessionId}', ['terminal', 'workspace-deep-link'])
})

const mirrorDescriptor = makeDescriptor({
  sourceId: 'cc-mirror',
  displayName: 'CC-Mirror',
  formats: [{ id: 'cc-mirror-jsonl-fixture', support: 'exact', reason: 'Fixture proves common Claude blocks and a mirror-only extension.' }],
  layers: {
    discovery: exact('Mirror roots are independent from Claude roots.'),
    metadata: exact('Only fixture-proven common fields are normalized.'),
    messages: exact('Compatible blocks retain order and fork extensions remain unknown facts.'),
    tools: exact('Only fixture-proven aliases share semantic tools.'),
    'system-compact': exact('Fixture-proven compact boundaries use the common context model.'),
    usage: exact('Fixture-proven message/request semantics deduplicate usage.'),
    relationships: derived('Claude lineage is reused only for proven matching fields.'),
    resume: derived('Claude-compatible launch remains derived until mirror source and anchors both verify.')
  },
  usageSemantics: 'Claude semantics apply only to fixture-proven fields; fork extensions are preserved.',
  resumeContract: makeResumeContract('claude --resume {sessionId}', ['terminal'])
})

const piDescriptor = makeDescriptor({
  sourceId: 'pi',
  displayName: 'Pi',
  formats: [
    { id: 'pi-jsonl-v1', support: 'exact', reason: 'Versioned header and ordered entries are fixture-backed.' },
    { id: 'pi-jsonl-v2', support: 'exact', reason: 'v2 keeps the versioned entry contract.' },
    { id: 'pi-jsonl-v3', support: 'exact', reason: 'v3 tree, active branch and compaction are fixture-backed.' }
  ],
  layers: {
    discovery: exact('Stable header identity discovers versioned Pi sessions.'),
    metadata: exact('Header/session/model-change fields remain explicit.'),
    messages: exact('Text, thinking and custom blocks retain order.'),
    tools: exact('Calls/results retain IDs and ordered v2 events.'),
    'system-compact': exact('Compaction summaries and model context use dual timelines.'),
    usage: exact('Provider-reported usage and cost are separate billing facts.'),
    relationships: derived('Tree parents are exact; the active chain is derived from the persisted v3 leaf order.'),
    resume: derived('Version probing chooses the command before anchor verification.')
  },
  usageSemantics: 'Reported usage/cost is authoritative; context membership never changes billing identity.',
  resumeContract: makeResumeContract('pi --session {sessionId}', ['terminal'])
})

export const UNIFIED_PROVIDER_DESCRIPTORS_V2: readonly UnifiedProviderDescriptorV2[] = [
  claudeDescriptor,
  codexDescriptor,
  cursorDescriptor,
  opencodeDescriptor,
  zcodeDescriptor,
  mirrorDescriptor,
  piDescriptor
]

const descriptorBySource = new Map(UNIFIED_PROVIDER_DESCRIPTORS_V2.map((entry) => [entry.sourceId, entry]))

export function unifiedProviderDescriptorV2(source: string): UnifiedProviderDescriptorV2 | undefined {
  return descriptorBySource.get(source as UnifiedProviderSource)
}

export function isUnifiedProviderSource(source: string): source is UnifiedProviderSource {
  return descriptorBySource.has(source as UnifiedProviderSource)
}
