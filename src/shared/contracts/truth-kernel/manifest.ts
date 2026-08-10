import {
  TRUTH_KERNEL_SCHEMA_VERSION,
  TRUTH_KERNEL_SERIALIZATION_VERSION
} from './types'

export const TRUTH_KERNEL_CONTRACT_VERSION = '1.0.0' as const
export const TRUTH_KERNEL_IPC_VERSION = 'truth-kernel-ipc/1.0.0' as const
export const TRUTH_KERNEL_FIXTURE_VERSION = '1.0.0' as const

export const TRUTH_KERNEL_CONTRACT_MANIFEST = {
  contractId: 'swob/truth-kernel',
  contractVersion: TRUTH_KERNEL_CONTRACT_VERSION,
  schemaVersion: TRUTH_KERNEL_SCHEMA_VERSION,
  serializationVersion: TRUTH_KERNEL_SERIALIZATION_VERSION,
  ipcVersion: TRUTH_KERNEL_IPC_VERSION,
  fixtureVersion: TRUTH_KERNEL_FIXTURE_VERSION,
  compatibility: {
    providerProtocol: '2.0',
    sessionMeta: 3,
    canonicalStore: 2
  },
  guarantees: [
    'provider-event-lossless-envelope',
    'unknown-payload-canonical-round-trip',
    'source-transcript-read-only',
    'derived-projections-rebuildable',
    'package-identity-location-separated',
    'usage-valuation-attribution-separated',
    'user-correction-is-new-revision',
    'integrity-after-ingest-claim-boundary'
  ]
} as const

export const TRUTH_KERNEL_PERFORMANCE_THRESHOLDS = {
  schemaVersion: 1,
  fixtureValidationP95Ms: 250,
  canonicalRoundTripP95Ms: 250,
  catalogTenThousandSessionsColdStartP95Ms: 3_000,
  catalogIncrementalRefreshP95Ms: 500,
  timelinePageP95Ms: 250,
  measurementEnvironment: 'release-like-local-fixture'
} as const
