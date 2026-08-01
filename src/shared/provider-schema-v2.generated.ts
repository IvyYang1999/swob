/* eslint-disable */
/**
 * GENERATED FILE. DO NOT EDIT.
 * Sources: schema/provider-protocol-v2.schema.json,
 *          schema/provider-protocol-v2.conformance.json
 * Run: npm run schema:gen
 */

export const PROVIDER_PROTOCOL_SCHEMA_ID = "https://swob.dev/schema/provider-protocol/v2" as const
export const PROVIDER_PROTOCOL_VERSION = "2.0" as const
export const PROVIDER_CONFORMANCE_VERSION = "2.0.0" as const
export const PROVIDER_RESOURCE_LIMITS = {
  "maxEnvelopeBytes": 1048576,
  "maxJsonDepth": 64,
  "maxNodes": 250000,
  "maxStringCodeUnits": 262144,
  "maxArrayItems": 4096,
  "maxObjectProperties": 256,
  "maxEventsPerChunk": 2048
} as const
export const PROVIDER_CAPABILITY_NAMES = ["discover","summary","transcript","tools","thinking","usage","relationships","subagents","interactions","permissions","context-timeline","identity","chunked-transport","terminal-resume","native-resume","format-provenance"] as const
export const PROVIDER_CAPABILITY_STATES = ["available","unavailable","not-applicable","experimental"] as const
export const PROVIDER_EVENT_KINDS = ["message.text","message.thinking","message.redacted-thinking","message.reasoning","tool.call","tool.progress","tool.result","interaction.request","interaction.response","permission.request","permission.response","context.compaction","context.summary","model.changed","mode.changed","session.metadata","session.lifecycle","subagent.spawn","rollback","usage","artifact","unknown"] as const

export type ProtocolVersion = "2.0"

export type ProviderId = string

export type NonEmptyString = string

export type NullableString = string | null

export type NullableInteger = number | null

export type JsonPrimitive = string | number | boolean | null

export type JsonArray = Array<JsonValue>

export interface JsonObject { [key: string]: JsonValue }

export type JsonValue = JsonPrimitive | JsonArray | JsonObject

export type Fingerprint = { algorithm: "sha256" | "composite-sha256" | "upstream-version"; value: NonEmptyString; inputs?: Array<NonEmptyString> }

export type CapabilityName = "discover" | "summary" | "transcript" | "tools" | "thinking" | "usage" | "relationships" | "subagents" | "interactions" | "permissions" | "context-timeline" | "identity" | "chunked-transport" | "terminal-resume" | "native-resume" | "format-provenance"

export type CapabilityStatus = "available" | "unavailable" | "not-applicable" | "experimental"

export type CapabilityEvidence = { kind: "test" | "observed-format" | "upstream-source" | "compatibility-contract" | "missing"; fixture: NonEmptyString; conformanceTestId: NonEmptyString; locator?: NonEmptyString; note?: NonEmptyString }

export type CapabilityDeclaration = { status: CapabilityStatus; reason: NullableString; evidence: Array<CapabilityEvidence> }

export type ProviderCapabilities = Record<string, CapabilityDeclaration>

export type ProviderManifest = { schemaVersion: 2; providerId: ProviderId; displayName: NonEmptyString; implementationVersion: NonEmptyString; parserDataVersion: NonEmptyString; formatVersions: Array<NonEmptyString>; capabilities: ProviderCapabilities; resumeContract: ResumeContract | null }

export type ProtocolHello = { protocolVersion: ProtocolVersion; schemaId: "https://swob.dev/schema/provider-protocol/v2"; providerId: ProviderId; implementationVersion: NonEmptyString; manifestFingerprint: NonEmptyString }

export type SessionIdentity = { physicalSourceId: NonEmptyString; logicalSessionKey: NonEmptyString; logicalSessionId: NonEmptyString; branchViewId: NonEmptyString; parentBranchViewId: NullableString }

export type ContextMembershipInterval = { contextRevision: number; state: "visible-to-model" | "archived" | "unknown"; fromSequence: number; untilSequence: NullableInteger }

export type EventTimeline = { archived: true; modelContext: Array<ContextMembershipInterval> }

export type EventProvenance = { providerId: ProviderId; sourceRefId: NonEmptyString; parserDataVersion: NonEmptyString; formatVersion: NullableString; observedAt: NullableString; sourceRecordId: NonEmptyString; rawRecordFingerprint: Fingerprint | null }

export type RawRecordReference = { locatorHash: NonEmptyString; offset: number; length: number }

export type InteractionState = { state: "historical"; answered: boolean } | { state: "live-pending"; channelId: NonEmptyString; expiresAt: NullableString } | { state: "expired" | "cancelled" }

export type InteractionOption = { id: NullableString; label: NonEmptyString; description: NullableString }

export type InteractionRequestPayload = { requestId: NonEmptyString; prompt: string; options: Array<InteractionOption>; multiSelect: boolean; state: InteractionState; toolCallId: NullableString; rawInput: JsonValue }

export type InteractionResponsePayload = { requestId: NonEmptyString; outcome: "answered" | "cancelled" | "expired"; answers: Array<string>; toolCallId: NullableString }

export type PermissionRequestPayload = { requestId: NonEmptyString; permission: NonEmptyString; resource: JsonValue; state: InteractionState; toolCallId: NullableString; rawInput: JsonValue }

export type PermissionResponsePayload = { requestId: NonEmptyString; decision: "allow" | "deny" | "cancelled" | "expired"; toolCallId: NullableString }

export type TextPayload = { text: string }

export type ReasoningPayload = { text: string; stream?: NonEmptyString }

export type RedactedThinkingPayload = { reason: NullableString; digest: NullableString }

export type ToolCallPayload = { callId: NonEmptyString; rawName: NonEmptyString; semanticToolId: NonEmptyString; input: JsonValue }

export type ToolProgressPayload = { callId: NonEmptyString; state: "pending" | "running" | "streaming"; output: JsonValue }

export type ToolResultPayload = { callId: NonEmptyString; output: JsonValue; isError: boolean | null; state: "complete" | "error" | "cancelled" | "orphan" }

export type ContextCompactionPayload = { contextRevision: number; archivedThroughSequence: number; summaryEventId: NullableString }

export type ContextSummaryPayload = { text: string; contextRevision: number }

export type ModelChangedPayload = { fromModelId: NullableString; toModelId: NonEmptyString }

export type ModeChangedPayload = { fromMode: NullableString; toMode: NonEmptyString }

export type SessionMetadataPayload = { title: NullableString; cwd: Array<NonEmptyString>; projectPath: NullableString }

export type SessionLifecyclePayload = { phase: NonEmptyString } | { relationshipType: "parent-child" | "continuation" | "fork" | "import-copy" | "subagent" | "related"; fromSessionRecordId: NonEmptyString; toSessionRecordId: NonEmptyString } | { relationshipType: "parent-child" | "continuation" | "fork" | "import-copy" | "subagent" | "related"; parentBranchViewId: NonEmptyString }

export type SubagentSpawnPayload = { agentId: NonEmptyString; parentAgentId: NonEmptyString }

export type RollbackPayload = { toEventId: NonEmptyString; reason: NonEmptyString }

export type ArtifactPayload = { uri: NonEmptyString; mimeType: NullableString } | { uri: NonEmptyString; action: "read" | "write" | "edit" | "create" | "delete" | "reference"; exists: boolean | null; fingerprint: Fingerprint | null }

export type UsageInput = { total: NullableInteger; uncached: NullableInteger; cacheRead: NullableInteger; cacheWrite5m: NullableInteger; cacheWrite1h: NullableInteger }

export type UsageOutput = { total: NullableInteger; visible: NullableInteger; reasoning: NullableInteger }

export type UsageRelations = { cacheRead: "subset-of-input" | "independent" | "provider-defined"; cacheWrite: "subset-of-input" | "independent" | "provider-defined"; reasoning: "subset-of-output" | "independent" | "provider-defined" }

export type UsageMeasurement = { source: "reported" | "derived" | "estimated" | "unavailable"; confidence: "exact" | "high" | "medium" | "low" | "unavailable"; sourceField: NullableString }

export type UsageCost = { amount: number; currency: NonEmptyString; kind: "reported" | "derived" }

export type UsageRecord = { eventId: NullableString; turnId: NullableString; modelId: NullableString; input: UsageInput; output: UsageOutput; providerTotal: NullableInteger; aggregation: "per-message" | "per-turn" | "delta" | "cumulative"; relations: UsageRelations; dedupKey: NonEmptyString; billingFactKey: NonEmptyString; measurement: UsageMeasurement; cost: UsageCost | null; priceRevision: NullableString }

export type UnknownPayload = { rawType: NonEmptyString; rawPayload: JsonValue }

export type CanonicalEventKind = "message.text" | "message.thinking" | "message.redacted-thinking" | "message.reasoning" | "tool.call" | "tool.progress" | "tool.result" | "interaction.request" | "interaction.response" | "permission.request" | "permission.response" | "context.compaction" | "context.summary" | "model.changed" | "mode.changed" | "session.metadata" | "session.lifecycle" | "subagent.spawn" | "rollback" | "usage" | "artifact" | "unknown"

export type CanonicalEvent = ({ id: NonEmptyString; identity: SessionIdentity; sharedEventKey: NonEmptyString; messageId: NullableString; sequence: number; messageBlockIndex: NullableInteger; timestamp: NullableString; actor: "user" | "assistant" | "system" | "tool" | "subagent" | "unknown"; kind: CanonicalEventKind; payload: JsonValue; visibility: "primary" | "collapsed" | "hidden-noise"; classification: "noise" | "promoted-system" | "lifecycle" | "interaction" | "user-content" | "unknown"; timeline: EventTimeline; provenance: EventProvenance; rawRef: RawRecordReference | null })

export type Diagnostic = { level: "info" | "warning" | "error"; code: NonEmptyString; message: NonEmptyString; eventId: NullableString }

export type ParseChunk = { providerId: ProviderId; parserDataVersion: NonEmptyString; formatVersion: NullableString; fingerprint: Fingerprint; identity: SessionIdentity; mode: "initial" | "append" | "replace"; chunkIndex: number; previousCursor: NullableString; cursor: NullableString; done: boolean; events: Array<CanonicalEvent>; diagnostics: Array<Diagnostic> }

export type ProviderError = { code: NonEmptyString; message: NonEmptyString; retryable: boolean; providerId: ProviderId; details: JsonObject | null }

export type ResumeContract = { mode: "native-cli" | "deep-link" | "import" | "fork-primer"; supportedSurfaces: Array<NonEmptyString>; supportsSubagent: boolean; idTransform: NullableString; preflight: Array<"binary" | "version" | "help-capability" | "source-exists">; commandTemplate: NullableString; expectedSideEffects: Array<NonEmptyString>; postcondition: "anchor-match" | "source-id-match" | "unverifiable" }

export type HelloEnvelope = { protocolVersion: ProtocolVersion; messageId: NonEmptyString; kind: "hello"; payload: ProtocolHello }

export type ManifestEnvelope = { protocolVersion: ProtocolVersion; messageId: NonEmptyString; kind: "manifest"; payload: ProviderManifest }

export type ParseChunkEnvelope = { protocolVersion: ProtocolVersion; messageId: NonEmptyString; kind: "parse-chunk"; payload: ParseChunk }

export type ErrorEnvelope = { protocolVersion: ProtocolVersion; messageId: NonEmptyString; kind: "error"; payload: ProviderError }

export type ProviderEnvelope = HelloEnvelope | ManifestEnvelope | ParseChunkEnvelope | ErrorEnvelope

export type ProviderConformanceSample = { manifest: ProviderManifest; envelopes: Array<ProviderEnvelope> }
