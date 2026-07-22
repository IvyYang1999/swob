import { createHash } from 'node:crypto'
import schemaDocument from '../../schema/provider-protocol-v1.schema.json'
import {
  PROVIDER_CAPABILITY_NAMES,
  PROVIDER_PROTOCOL_SCHEMA_ID,
  PROVIDER_PROTOCOL_VERSION,
  type CapabilityDeclaration,
  type ParseOutcome,
  type ProviderEnvelope,
  type ProviderManifest,
  type ProtocolHello
} from './provider-schema.generated'

type SchemaNode = Record<string, unknown>

export interface ProviderSchemaIssue {
  path: string
  keyword: string
  message: string
}

export interface ProviderSchemaValidation<T> {
  ok: boolean
  value?: T
  issues: ProviderSchemaIssue[]
}

export interface ProviderConformanceReport {
  ok: boolean
  providerId: string | null
  issues: ProviderSchemaIssue[]
  checkedEnvelopes: number
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)])
    )
  }
  return value
}

export function canonicalProviderJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

export function providerFingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalProviderJson(value)).digest('hex')
}

export function stableCanonicalRecordId(input: {
  providerId: string
  sourceRefStableId: string
  recordType: string
  sourceRecordId: string
}): string {
  const digest = providerFingerprint([
    input.providerId,
    input.sourceRefStableId,
    input.recordType,
    input.sourceRecordId
  ])
  return `swob:${input.providerId}:${input.recordType}:${digest}`
}

function schemaRef(ref: string): SchemaNode {
  const prefix = '#/$defs/'
  if (!ref.startsWith(prefix)) throw new Error(`Unsupported schema ref: ${ref}`)
  const name = ref.slice(prefix.length)
  const definition = (schemaDocument.$defs as Record<string, SchemaNode>)[name]
  if (!definition) throw new Error(`Unknown schema definition: ${name}`)
  return definition
}

function valueTypeMatches(expected: string, value: unknown): boolean {
  if (expected === 'null') return value === null
  if (expected === 'array') return Array.isArray(value)
  if (expected === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value)
  if (expected === 'integer') return typeof value === 'number' && Number.isInteger(value)
  if (expected === 'number') return typeof value === 'number' && Number.isFinite(value)
  return typeof value === expected
}

function knownProperties(node: SchemaNode): Set<string> {
  if (typeof node.$ref === 'string') return knownProperties(schemaRef(node.$ref))
  const result = new Set(Object.keys((node.properties as Record<string, SchemaNode> | undefined) || {}))
  for (const child of (node.allOf as SchemaNode[] | undefined) || []) {
    for (const key of knownProperties(child)) result.add(key)
  }
  return result
}

function issue(path: string, keyword: string, message: string): ProviderSchemaIssue {
  return { path, keyword, message }
}

function validateNode(node: SchemaNode, value: unknown, path: string): ProviderSchemaIssue[] {
  if (typeof node.$ref === 'string') return validateNode(schemaRef(node.$ref), value, path)

  if (Object.prototype.hasOwnProperty.call(node, 'const') &&
    canonicalProviderJson(value) !== canonicalProviderJson(node.const)) {
    return [issue(path, 'const', `must equal ${JSON.stringify(node.const)}`)]
  }
  if (Array.isArray(node.enum) && !node.enum.some((entry) =>
    canonicalProviderJson(entry) === canonicalProviderJson(value))) {
    return [issue(path, 'enum', `must be one of ${node.enum.map(String).join(', ')}`)]
  }

  if (Array.isArray(node.oneOf)) {
    const candidates = node.oneOf.map((candidate) => validateNode(candidate as SchemaNode, value, path))
    const valid = candidates.filter((errors) => errors.length === 0)
    if (valid.length !== 1) {
      const detail = valid.length === 0
        ? candidates.flat().slice(0, 4).map((entry) => `${entry.path} ${entry.message}`).join('; ')
        : `${valid.length} alternatives matched`
      return [issue(path, 'oneOf', detail || 'must match exactly one alternative')]
    }
  }
  if (Array.isArray(node.anyOf)) {
    const valid = node.anyOf.some((candidate) => validateNode(candidate as SchemaNode, value, path).length === 0)
    if (!valid) return [issue(path, 'anyOf', 'must match at least one alternative')]
  }
  if (Array.isArray(node.allOf)) {
    const errors = node.allOf.flatMap((candidate) => validateNode(candidate as SchemaNode, value, path))
    if (errors.length > 0) return errors
  }

  if (node.type) {
    const expected = Array.isArray(node.type) ? node.type as string[] : [node.type as string]
    if (!expected.some((type) => valueTypeMatches(type, value))) {
      return [issue(path, 'type', `must be ${expected.join(' or ')}`)]
    }
  }

  if (typeof value === 'string') {
    if (typeof node.minLength === 'number' && value.length < node.minLength) {
      return [issue(path, 'minLength', `must contain at least ${node.minLength} character(s)`)]
    }
    if (typeof node.pattern === 'string' && !(new RegExp(node.pattern)).test(value)) {
      return [issue(path, 'pattern', `must match ${node.pattern}`)]
    }
  }
  if (typeof value === 'number' && typeof node.minimum === 'number' && value < node.minimum) {
    return [issue(path, 'minimum', `must be >= ${node.minimum}`)]
  }

  if (Array.isArray(value)) {
    const errors: ProviderSchemaIssue[] = []
    if (typeof node.minItems === 'number' && value.length < node.minItems) {
      errors.push(issue(path, 'minItems', `must contain at least ${node.minItems} item(s)`))
    }
    if (node.uniqueItems === true) {
      const keys = value.map(canonicalProviderJson)
      if (new Set(keys).size !== keys.length) errors.push(issue(path, 'uniqueItems', 'must not contain duplicates'))
    }
    if (node.items && typeof node.items === 'object') {
      value.forEach((entry, index) => {
        errors.push(...validateNode(node.items as SchemaNode, entry, `${path}/${index}`))
      })
    }
    return errors
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const object = value as Record<string, unknown>
    const properties = (node.properties as Record<string, SchemaNode> | undefined) || {}
    const errors: ProviderSchemaIssue[] = []
    for (const name of (node.required as string[] | undefined) || []) {
      if (!Object.prototype.hasOwnProperty.call(object, name)) {
        errors.push(issue(`${path}/${name}`, 'required', 'is required'))
      }
    }
    for (const [name, child] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(object, name)) {
        errors.push(...validateNode(child, object[name], `${path}/${name}`))
      }
    }
    const known = new Set(Object.keys(properties))
    if (node.unevaluatedProperties === false) {
      for (const name of knownProperties(node)) known.add(name)
    }
    for (const [name, child] of Object.entries(object)) {
      if (known.has(name)) continue
      if (node.additionalProperties === false || node.unevaluatedProperties === false) {
        errors.push(issue(`${path}/${name}`, 'additionalProperties', 'is not allowed'))
      } else if (node.additionalProperties && typeof node.additionalProperties === 'object') {
        errors.push(...validateNode(node.additionalProperties as SchemaNode, child, `${path}/${name}`))
      }
    }
    return errors
  }

  return []
}

function validateDefinition<T>(name: string, value: unknown): ProviderSchemaValidation<T> {
  const definition = (schemaDocument.$defs as Record<string, SchemaNode>)[name]
  if (!definition) throw new Error(`Unknown schema definition: ${name}`)
  const issues = validateNode(definition, value, '$')
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: value as T, issues: [] }
}

function capabilitySemanticIssues(capability: CapabilityDeclaration, path: string): ProviderSchemaIssue[] {
  const issues: ProviderSchemaIssue[] = []
  if (capability.status !== 'available' && !capability.reason?.trim()) {
    issues.push(issue(`${path}/reason`, 'capability-reason', 'non-available capability requires a reason'))
  }
  if ((capability.status === 'available' || capability.status === 'experimental') && capability.evidence.length === 0) {
    issues.push(issue(`${path}/evidence`, 'capability-evidence', 'available or experimental capability requires evidence'))
  }
  return issues
}

function manifestSemanticIssues(manifest: ProviderManifest): ProviderSchemaIssue[] {
  return PROVIDER_CAPABILITY_NAMES.flatMap((name) =>
    capabilitySemanticIssues(manifest.capabilities[name], `$/capabilities/${name}`)
  )
}

function parseOutcomeSemanticIssues(outcome: ParseOutcome): ProviderSchemaIssue[] {
  const issues: ProviderSchemaIssue[] = []
  if ((outcome.status === 'partial' || outcome.status === 'error') && outcome.errors.length === 0 &&
    outcome.sessions.every((session) => session.errors.length === 0)) {
    issues.push(issue('$/errors', 'parse-errors', `${outcome.status} outcome requires a typed error`))
  }
  outcome.sessions.forEach((session, index) => {
    const path = `$/sessions/${index}`
    if ((session.status === 'partial' || session.status === 'skipped' || session.status === 'error') && session.errors.length === 0) {
      issues.push(issue(`${path}/errors`, 'parse-errors', `${session.status} session requires a typed error`))
    }
    if (session.status === 'replace' && !session.replaceSessionRecordId) {
      issues.push(issue(`${path}/replaceSessionRecordId`, 'replace-target', 'replace session requires a target'))
    }
    for (const record of session.records) {
      if (record.provenance.providerId !== outcome.providerId) {
        issues.push(issue(`${path}/records`, 'provider-identity', 'record provenance providerId must match outcome providerId'))
      }
      if (record.provenance.sourceRefId !== session.sourceRefId) {
        issues.push(issue(`${path}/records`, 'source-identity', 'record provenance sourceRefId must match session sourceRefId'))
      }
    }
  })
  return issues
}

export function validateProviderManifest(value: unknown): ProviderSchemaValidation<ProviderManifest> {
  const structural = validateDefinition<ProviderManifest>('ProviderManifest', value)
  if (!structural.ok) return structural
  const issues = manifestSemanticIssues(structural.value!)
  return issues.length > 0 ? { ok: false, issues } : structural
}

export function validateProviderEnvelope(value: unknown): ProviderSchemaValidation<ProviderEnvelope> {
  const structural = validateDefinition<ProviderEnvelope>('ProviderEnvelope', value)
  if (!structural.ok) return structural
  const envelope = structural.value!
  const issues: ProviderSchemaIssue[] = []
  if (envelope.protocolVersion !== PROVIDER_PROTOCOL_VERSION) {
    issues.push(issue('$/protocolVersion', 'protocol-version', `must equal ${PROVIDER_PROTOCOL_VERSION}`))
  }
  if (envelope.kind === 'manifest') issues.push(...manifestSemanticIssues(envelope.payload))
  if (envelope.kind === 'parse-outcome') issues.push(...parseOutcomeSemanticIssues(envelope.payload))
  if (envelope.kind === 'query-frame') {
    const fieldNames = envelope.payload.fields.map((field) => field.name)
    if (new Set(fieldNames).size !== fieldNames.length) {
      issues.push(issue('$/payload/fields', 'query-frame-fields', 'field names must be unique'))
    }
    envelope.payload.rows.forEach((row, index) => {
      if (row.length !== envelope.payload.fields.length) {
        issues.push(issue(
          `$/payload/rows/${index}`,
          'query-frame-width',
          `row width ${row.length} does not match field count ${envelope.payload.fields.length}`
        ))
      }
    })
  }
  return issues.length > 0 ? { ok: false, issues } : structural
}

export function assertProviderEnvelope(value: unknown): ProviderEnvelope {
  const result = validateProviderEnvelope(value)
  if (!result.ok) {
    const summary = result.issues.map((entry) => `${entry.path}: ${entry.message}`).join('; ')
    throw new Error(`ProviderProtocol v1 validation failed: ${summary}`)
  }
  return result.value!
}

export function helloForProvider(manifest: ProviderManifest): ProtocolHello {
  return {
    protocolVersion: PROVIDER_PROTOCOL_VERSION,
    schemaId: PROVIDER_PROTOCOL_SCHEMA_ID,
    providerId: manifest.providerId,
    implementationVersion: manifest.implementationVersion,
    manifestFingerprint: providerFingerprint(manifest)
  }
}

export function runProviderConformance(input: {
  manifest: unknown
  envelopes: unknown[]
}): ProviderConformanceReport {
  const issues: ProviderSchemaIssue[] = []
  const manifestResult = validateProviderManifest(input.manifest)
  if (!manifestResult.ok) issues.push(...manifestResult.issues.map((entry) => ({
    ...entry,
    path: `manifest${entry.path.slice(1)}`
  })))
  const manifest = manifestResult.value
  let helloCount = 0
  for (let index = 0; index < input.envelopes.length; index++) {
    const result = validateProviderEnvelope(input.envelopes[index])
    if (!result.ok) {
      issues.push(...result.issues.map((entry) => ({
        ...entry,
        path: `envelopes/${index}${entry.path.slice(1)}`
      })))
      continue
    }
    const envelope = result.value!
    if (envelope.kind === 'hello') {
      helloCount++
      if (manifest && envelope.payload.providerId !== manifest.providerId) {
        issues.push(issue(`envelopes/${index}/payload/providerId`, 'provider-identity', 'hello and manifest providerId differ'))
      }
      if (manifest && envelope.payload.manifestFingerprint !== providerFingerprint(manifest)) {
        issues.push(issue(`envelopes/${index}/payload/manifestFingerprint`, 'manifest-fingerprint', 'hello fingerprint does not match manifest'))
      }
    }
    if (envelope.kind === 'parse-outcome' && manifest && envelope.payload.providerId !== manifest.providerId) {
      issues.push(issue(`envelopes/${index}/payload/providerId`, 'provider-identity', 'parse outcome and manifest providerId differ'))
    }
  }
  if (helloCount !== 1) issues.push(issue('envelopes', 'hello-count', 'conformance sample requires exactly one hello envelope'))
  return {
    ok: issues.length === 0,
    providerId: manifest?.providerId || null,
    issues,
    checkedEnvelopes: input.envelopes.length
  }
}
