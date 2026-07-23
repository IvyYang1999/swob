import * as fs from 'node:fs'
import * as path from 'node:path'
import type {
  CanonicalRecord,
  Fingerprint,
  ParseOutcome,
  SourceRef,
  Tombstone
} from '../shared/provider-schema.generated'
import { PROVIDER_PROTOCOL_VERSION } from '../shared/provider-schema.generated'
import { canonicalProviderJson, validateProviderEnvelope } from '../shared/provider-protocol'

export const CANONICAL_RECORDS_FILE = 'canonical-records.json'
export const CANONICAL_PROVENANCE_FILE = 'provider-provenance.json'

export interface CanonicalPackageDescriptor {
  schemaVersion: 1
  providerId: string
  sourceRefStableId: string
  sessionRecordId: string
  fingerprint: Fingerprint
  parserDataVersion: string
  formatVersion: string | null
  recordsFile: typeof CANONICAL_RECORDS_FILE
  provenanceFile: typeof CANONICAL_PROVENANCE_FILE
  tombstone?: Tombstone
}

export interface CanonicalPackageRecords {
  schemaVersion: 1
  providerId: string
  parserDataVersion: string
  formatVersion: string | null
  fingerprint: Fingerprint
  sourceRef: SourceRef
  sessionRecordId: string
  records: CanonicalRecord[]
}

export interface CanonicalPackageProvenance {
  schemaVersion: 1
  providerId: string
  parserDataVersion: string
  formatVersion: string | null
  fingerprint: Fingerprint
  sourceRef: SourceRef
  sessionRecordId: string
  archivedAt: string
  tombstone: Tombstone | null
}

export function isCanonicalRecordsPath(filePath: string): boolean {
  return path.basename(filePath) === CANONICAL_RECORDS_FILE
}

export function isCanonicalPackageDescriptor(value: unknown): value is CanonicalPackageDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const descriptor = value as Partial<CanonicalPackageDescriptor>
  return descriptor.schemaVersion === 1 &&
    typeof descriptor.providerId === 'string' && descriptor.providerId.includes('/') &&
    typeof descriptor.sourceRefStableId === 'string' && descriptor.sourceRefStableId.length > 0 &&
    typeof descriptor.sessionRecordId === 'string' && descriptor.sessionRecordId.length > 0 &&
    typeof descriptor.parserDataVersion === 'string' && descriptor.parserDataVersion.length > 0 &&
    (typeof descriptor.formatVersion === 'string' || descriptor.formatVersion === null) &&
    descriptor.recordsFile === CANONICAL_RECORDS_FILE &&
    descriptor.provenanceFile === CANONICAL_PROVENANCE_FILE &&
    Boolean(descriptor.fingerprint && typeof descriptor.fingerprint === 'object')
}

export function encodeCanonicalPackageRecords(value: CanonicalPackageRecords): string {
  return canonicalProviderJson(value)
}

export function encodeCanonicalPackageProvenance(value: CanonicalPackageProvenance): string {
  return canonicalProviderJson(value)
}

function validatePackage(value: CanonicalPackageRecords): boolean {
  const outcome: ParseOutcome = {
    providerId: value.providerId,
    parserDataVersion: value.parserDataVersion,
    formatVersion: value.formatVersion,
    fingerprint: value.fingerprint,
    status: 'complete',
    sessions: [{
      sourceRefId: value.sourceRef.stableId,
      sessionRecordId: value.sessionRecordId,
      status: 'complete',
      records: value.records,
      errors: [],
      replaceSessionRecordId: null,
      noDataReason: null
    }],
    errors: [],
    tombstones: []
  }
  const validation = validateProviderEnvelope({
    protocolVersion: PROVIDER_PROTOCOL_VERSION,
    messageId: 'canonical-package-validation',
    kind: 'parse-outcome',
    payload: outcome
  })
  return validation.ok && value.sourceRef.providerId === value.providerId &&
    value.records.some((record) => record.recordType === 'session' && record.id === value.sessionRecordId)
}

export function readCanonicalPackageRecords(filePath: string): CanonicalPackageRecords | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as CanonicalPackageRecords
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.records) || !validatePackage(parsed)) return null
    return parsed
  } catch {
    return null
  }
}
