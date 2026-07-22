/* eslint-disable */
/**
 * GENERATED FILE. DO NOT EDIT.
 * Source: schema/provider-protocol-v1.schema.json
 * Run: npm run schema:gen
 */

export const PROVIDER_PROTOCOL_SCHEMA_ID = "https://swob.dev/schema/provider-protocol/v1" as const
export const PROVIDER_PROTOCOL_VERSION = "1.0" as const
export const PROVIDER_CAPABILITY_NAMES = ["discover","summary","transcript","tools","thinking","usage","relationships","subagents","live-watch","search","archive","terminal-resume","native-resume","format-provenance"] as const
export const PROVIDER_CAPABILITY_STATES = ["available","unavailable","not-applicable","experimental"] as const
export const PROVIDER_PARSE_STATUSES = ["complete","partial","skipped","error","replace"] as const

export type ProtocolVersion = "1.0"

export type ProviderId = string

export type NonEmptyString = string

export type NullableString = string | null

export type NullableInteger = number | null

export type JsonPrimitive = string | number | boolean | null

export type JsonArray = Array<JsonValue>

export interface JsonObject { [key: string]: JsonValue }

export type JsonValue = JsonPrimitive | JsonArray | JsonObject

export type CapabilityName = "discover" | "summary" | "transcript" | "tools" | "thinking" | "usage" | "relationships" | "subagents" | "live-watch" | "search" | "archive" | "terminal-resume" | "native-resume" | "format-provenance"

export type CapabilityStatus = "available" | "unavailable" | "not-applicable" | "experimental"

export type EvidenceKind = "implementation" | "test" | "official-documentation" | "upstream-source" | "observed-format" | "compatibility-contract" | "missing"

export type CapabilityEvidence = { kind: EvidenceKind; locator: NonEmptyString; note?: NonEmptyString }

export type CapabilityDeclaration = { status: CapabilityStatus; reason: NullableString; evidence: Array<CapabilityEvidence> }

export type ProviderCapabilities = { discover: CapabilityDeclaration; summary: CapabilityDeclaration; transcript: CapabilityDeclaration; tools: CapabilityDeclaration; thinking: CapabilityDeclaration; usage: CapabilityDeclaration; relationships: CapabilityDeclaration; subagents: CapabilityDeclaration; "live-watch": CapabilityDeclaration; search: CapabilityDeclaration; archive: CapabilityDeclaration; "terminal-resume": CapabilityDeclaration; "native-resume": CapabilityDeclaration; "format-provenance": CapabilityDeclaration }

export type ProviderManifest = { schemaVersion: 1; providerId: ProviderId; displayName: NonEmptyString; implementationVersion: NonEmptyString; parserDataVersion: NonEmptyString; formatVersions: Array<NonEmptyString>; legacySourceIds?: Array<NonEmptyString>; capabilities: ProviderCapabilities }

export type ProtocolHello = { protocolVersion: ProtocolVersion; schemaId: "https://swob.dev/schema/provider-protocol/v1"; providerId: ProviderId; implementationVersion: NonEmptyString; manifestFingerprint: NonEmptyString }

export type Fingerprint = { algorithm: "sha256" | "composite-sha256" | "upstream-version"; value: NonEmptyString; inputs?: Array<NonEmptyString> }

export type FileSourceRef = { kind: "file"; stableId: NonEmptyString; providerId: ProviderId; uri: NonEmptyString; displayLocator: NonEmptyString; fingerprint: Fingerprint }

export type CompositeDirectorySourceRef = { kind: "composite-directory"; stableId: NonEmptyString; providerId: ProviderId; rootUri: NonEmptyString; memberUris: Array<NonEmptyString>; displayLocator: NonEmptyString; fingerprint: Fingerprint }

export type SqliteRowSourceRef = { kind: "sqlite-row"; stableId: NonEmptyString; providerId: ProviderId; databaseUri: NonEmptyString; table: NonEmptyString; primaryKey: JsonObject; displayLocator: NonEmptyString; fingerprint: Fingerprint }

export type VirtualMemberSourceRef = { kind: "virtual-member"; stableId: NonEmptyString; providerId: ProviderId; containerRefId: NonEmptyString; memberKey: NonEmptyString; displayLocator: NonEmptyString; fingerprint: Fingerprint }

export type ImportPackageSourceRef = { kind: "import-package"; stableId: NonEmptyString; providerId: ProviderId; packageUri: NonEmptyString; entryPath: NonEmptyString; displayLocator: NonEmptyString; fingerprint: Fingerprint }

export type SourceRef = FileSourceRef | CompositeDirectorySourceRef | SqliteRowSourceRef | VirtualMemberSourceRef | ImportPackageSourceRef

export type RecordProvenance = { providerId: ProviderId; sourceRefId: NonEmptyString; parserDataVersion: NonEmptyString; formatVersion: NullableString; observedAt: NullableString; rawRecordFingerprint?: Fingerprint; evidence?: Array<CapabilityEvidence> }

export type CanonicalRecordBase = { id: NonEmptyString; provenance: RecordProvenance }

export type SessionRecord = (CanonicalRecordBase) & ({ recordType: "session"; sourceRef: SourceRef; sourceSessionId: NonEmptyString; createdAt: NullableString; updatedAt: NullableString; cwd: Array<NonEmptyString>; projectPath: NullableString; providerTitle?: NullableString })

export type TextContent = { kind: "text"; text: string }

export type ThinkingContent = { kind: "thinking"; text: string }

export type MediaRefContent = { kind: "media-ref"; uri: NonEmptyString; mimeType: NullableString }

export type MessageContent = TextContent | ThinkingContent | MediaRefContent

export type MessageRecord = (CanonicalRecordBase) & ({ recordType: "message"; sessionRecordId: NonEmptyString; ordinal: number; role: "user" | "assistant" | "system" | "tool" | "unknown"; timestamp: NullableString; content: Array<MessageContent> })

export type ToolCallRecord = (CanonicalRecordBase) & ({ recordType: "tool-call"; sessionRecordId: NonEmptyString; messageRecordId: NullableString; ordinal: number; name: NonEmptyString; input: JsonValue })

export type ToolResultEvent = (CanonicalRecordBase) & ({ recordType: "tool-result"; sessionRecordId: NonEmptyString; toolCallRecordId: NonEmptyString; timestamp: NullableString; content: JsonValue; isError: boolean | null })

export type UsageRecord = (CanonicalRecordBase) & ({ recordType: "usage"; sessionRecordId: NonEmptyString; messageRecordId: NullableString; timestamp: NullableString; model: NullableString; inputTokens: NullableInteger; outputTokens: NullableInteger; cacheReadTokens: NullableInteger; cacheWriteTokens: NullableInteger; reasoningTokens: NullableInteger; costUsd: number | null; usageProvenance: "reported" | "derived" | "estimated" | "unavailable" })

export type RelationshipRecord = (CanonicalRecordBase) & ({ recordType: "relationship"; fromSessionRecordId: NonEmptyString; toSessionRecordId: NonEmptyString; relationshipType: "parent-child" | "continuation" | "fork" | "import-copy" | "subagent" | "related" })

export type ArtifactRecord = (CanonicalRecordBase) & ({ recordType: "artifact"; sessionRecordId: NonEmptyString; messageRecordId: NullableString; uri: NonEmptyString; action: "read" | "write" | "edit" | "create" | "delete" | "reference"; exists: boolean | null; fingerprint: Fingerprint | null })

export type CanonicalRecord = SessionRecord | MessageRecord | ToolCallRecord | ToolResultEvent | UsageRecord | RelationshipRecord | ArtifactRecord

export type Tombstone = { sourceRefId: NonEmptyString; sessionRecordId: NonEmptyString; deletedAt: NullableString; reason: "source-missing" | "provider-deleted" | "replaced"; previousFingerprint: Fingerprint | null }

export type ProviderErrorCode = "protocol-version-mismatch" | "schema-validation-failed" | "source-unreadable" | "format-unsupported" | "parse-failed" | "partial-data" | "cancelled" | "internal"

export type ProviderError = { code: ProviderErrorCode; message: NonEmptyString; retryable: boolean; providerId: ProviderId; sourceRefId: NullableString; recordId: NullableString; details: JsonObject | null }

export type ParseStatus = "complete" | "partial" | "skipped" | "error" | "replace"

export type SessionParseResult = { sourceRefId: NonEmptyString; sessionRecordId: NullableString; status: ParseStatus; records: Array<CanonicalRecord>; errors: Array<ProviderError>; replaceSessionRecordId: NullableString }

export type ParseOutcome = { providerId: ProviderId; parserDataVersion: NonEmptyString; formatVersion: NullableString; fingerprint: Fingerprint; status: ParseStatus; sessions: Array<SessionParseResult>; errors: Array<ProviderError>; tombstones: Array<Tombstone> }

export type QueryFrameFieldType = "string" | "number" | "boolean" | "timestamp" | "json"

export type QueryFrameField = { name: NonEmptyString; type: QueryFrameFieldType; nullable: boolean }

export type QueryFrame = { schemaVersion: 1; projectionId: NonEmptyString; lossy: true; sourceRecordTypes: Array<"session" | "message" | "tool-call" | "tool-result" | "usage" | "relationship" | "artifact">; fields: Array<QueryFrameField>; rows: Array<Array<JsonValue>> }

export type HelloEnvelope = { protocolVersion: ProtocolVersion; messageId: NonEmptyString; kind: "hello"; payload: ProtocolHello }

export type ManifestEnvelope = { protocolVersion: ProtocolVersion; messageId: NonEmptyString; kind: "manifest"; payload: ProviderManifest }

export type ParseOutcomeEnvelope = { protocolVersion: ProtocolVersion; messageId: NonEmptyString; kind: "parse-outcome"; payload: ParseOutcome }

export type QueryFrameEnvelope = { protocolVersion: ProtocolVersion; messageId: NonEmptyString; kind: "query-frame"; payload: QueryFrame }

export type ErrorEnvelope = { protocolVersion: ProtocolVersion; messageId: NonEmptyString; kind: "error"; payload: ProviderError }

export type ProviderEnvelope = HelloEnvelope | ManifestEnvelope | ParseOutcomeEnvelope | QueryFrameEnvelope | ErrorEnvelope
