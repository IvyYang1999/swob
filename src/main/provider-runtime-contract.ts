// Type-only contract that every builtin provider implements. Kept apart from
// provider-host.ts, which imports all providers at runtime, so depending on the
// contract no longer pulls the host into a provider's type closure.
// provider-host.ts re-exports both names for existing importers.
import type {
  Fingerprint,
  ParseOutcome,
  ProviderManifest,
  SourceRef
} from '../shared/provider-schema.generated'
import type {
  ParseChunk as ParseChunkV2,
  ProviderManifest as ProviderManifestV2
} from '../shared/provider-schema-v2.generated'

export interface BuiltinProviderRuntime {
  readonly manifest: ProviderManifest
  discover(signal: AbortSignal): Promise<SourceRef[]>
  fingerprint(source: SourceRef, signal: AbortSignal): Promise<Fingerprint>
  inputBytes(source: SourceRef, signal: AbortSignal): Promise<number>
  parse(source: SourceRef, fingerprint: Fingerprint, signal: AbortSignal): Promise<ParseOutcome>
}

/** Native Provider Protocol v2 runtime. It shares the hardened discovery and
 * source fingerprint boundary with v1, but never creates a v1 ParseOutcome. */
export interface BuiltinProviderRuntimeV2 {
  readonly manifest: ProviderManifestV2
  discover(signal: AbortSignal): Promise<SourceRef[]>
  fingerprint(source: SourceRef, signal: AbortSignal): Promise<Fingerprint>
  inputBytes(source: SourceRef, signal: AbortSignal): Promise<number>
  parse(source: SourceRef, fingerprint: Fingerprint, signal: AbortSignal): Promise<ParseChunkV2[]>
}
