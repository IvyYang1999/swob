import { createHash } from 'node:crypto'
import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js'
import schemaDocument from '../../schema/provider-protocol-v1.schema.json'
import {
  PROVIDER_PROTOCOL_SCHEMA_ID,
  PROVIDER_PROTOCOL_VERSION,
  PROVIDER_RESOURCE_LIMITS,
  type ProviderEnvelope,
  type ProviderError,
  type ProviderManifest,
  type ProtocolHello
} from './provider-schema.generated'

export interface ProviderSchemaIssue {
  path: string
  keyword: string
  message: string
}

export interface ProviderSchemaValidation<T> {
  ok: boolean
  value?: T
  issues: ProviderSchemaIssue[]
  error?: ProviderError
}

export interface ProviderConformanceReport {
  ok: boolean
  providerId: string | null
  issues: ProviderSchemaIssue[]
  checkedEnvelopes: number
}

export class ProviderProtocolValidationError extends Error {
  readonly providerError: ProviderError
  readonly issues: ProviderSchemaIssue[]

  constructor(providerError: ProviderError, issues: ProviderSchemaIssue[]) {
    super(`ProviderProtocol v1 validation failed: ${issues.map((entry) => `${entry.path}: ${entry.message}`).join('; ')}`)
    this.name = 'ProviderProtocolValidationError'
    this.providerError = providerError
    this.issues = issues
  }
}

const ajv = new Ajv2020({ strict: true, allErrors: true })
ajv.addSchema(schemaDocument)

function schemaValidator<T>(definition: string): ValidateFunction<T> {
  const validator = ajv.getSchema<T>(`${PROVIDER_PROTOCOL_SCHEMA_ID}#/$defs/${definition}`)
  if (!validator) throw new Error(`Provider schema definition is missing: ${definition}`)
  return validator
}

const validateEnvelopeSchema = schemaValidator<ProviderEnvelope>('ProviderEnvelope')
const validateManifestSchema = schemaValidator<ProviderManifest>('ProviderManifest')

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

function issue(path: string, keyword: string, message: string): ProviderSchemaIssue {
  return { path, keyword, message }
}

function providerIdFrom(value: unknown): string {
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const payload = record.payload
    const candidates = [
      record.providerId,
      payload && typeof payload === 'object' ? (payload as Record<string, unknown>).providerId : null
    ]
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(candidate)) {
        return candidate
      }
    }
  }
  return 'swob/protocol'
}

function protocolError(
  value: unknown,
  code: ProviderError['code'],
  message: string,
  details: Record<string, string | number | boolean | null>
): ProviderError {
  return {
    code,
    message,
    retryable: false,
    providerId: providerIdFrom(value),
    sourceRefId: null,
    recordId: null,
    details
  }
}

function failed<T>(
  value: unknown,
  code: ProviderError['code'],
  issues: ProviderSchemaIssue[],
  details: Record<string, string | number | boolean | null> = {}
): ProviderSchemaValidation<T> {
  return {
    ok: false,
    issues,
    error: protocolError(value, code, issues[0]?.message || 'Provider protocol validation failed.', details)
  }
}

function resourceFailure<T>(
  value: unknown,
  limitName: keyof typeof PROVIDER_RESOURCE_LIMITS,
  actual: number,
  path = '$'
): ProviderSchemaValidation<T> {
  const limit = PROVIDER_RESOURCE_LIMITS[limitName]
  return failed(value, 'resource-limit-exceeded', [
    issue(path, 'resource-limit', `${limitName} exceeded: ${actual} > ${limit}`)
  ], { limitName, actual, limit })
}

function namedArrayLimit(path: string): { name: keyof typeof PROVIDER_RESOURCE_LIMITS; value: number } | null {
  const key = path.slice(path.lastIndexOf('/') + 1)
  if (key === 'records') return { name: 'maxRecordsPerSession', value: PROVIDER_RESOURCE_LIMITS.maxRecordsPerSession }
  if (key === 'sessions') return { name: 'maxSessionsPerOutcome', value: PROVIDER_RESOURCE_LIMITS.maxSessionsPerOutcome }
  if (key === 'rows') return { name: 'maxQueryRows', value: PROVIDER_RESOURCE_LIMITS.maxQueryRows }
  return null
}

function preflightValueBudget<T>(value: unknown): ProviderSchemaValidation<T> | null {
  type BudgetEntry =
    | { kind: 'enter'; value: unknown; path: string; depth: number }
    | { kind: 'leave'; value: object }
  const stack: BudgetEntry[] = [{ kind: 'enter', value, path: '$', depth: 1 }]
  const ancestors = new WeakSet<object>()
  let nodes = 0

  while (stack.length > 0) {
    const current = stack.pop()!
    if (current.kind === 'leave') {
      ancestors.delete(current.value)
      continue
    }
    nodes++
    if (nodes > PROVIDER_RESOURCE_LIMITS.maxNodes) {
      return resourceFailure(value, 'maxNodes', nodes, current.path)
    }
    if (current.depth > PROVIDER_RESOURCE_LIMITS.maxJsonDepth) {
      return resourceFailure(value, 'maxJsonDepth', current.depth, current.path)
    }
    if (typeof current.value === 'string') {
      if (current.value.length > PROVIDER_RESOURCE_LIMITS.maxStringCodeUnits) {
        return resourceFailure(value, 'maxStringCodeUnits', current.value.length, current.path)
      }
      continue
    }
    if (!current.value || typeof current.value !== 'object') continue
    if (ancestors.has(current.value)) {
      return failed(value, 'schema-validation-failed', [
        issue(current.path, 'json-cycle', 'JSON values must not contain object cycles')
      ])
    }
    ancestors.add(current.value)
    stack.push({ kind: 'leave', value: current.value })

    if (Array.isArray(current.value)) {
      if (current.value.length > PROVIDER_RESOURCE_LIMITS.maxArrayItems) {
        return resourceFailure(value, 'maxArrayItems', current.value.length, current.path)
      }
      const named = namedArrayLimit(current.path)
      if (named && current.value.length > named.value) {
        return resourceFailure(value, named.name, current.value.length, current.path)
      }
      for (let index = current.value.length - 1; index >= 0; index--) {
        stack.push({ kind: 'enter', value: current.value[index], path: `${current.path}/${index}`, depth: current.depth + 1 })
      }
      continue
    }

    const entries = Object.entries(current.value as Record<string, unknown>)
    const columnLimit = current.path.endsWith('/cells')
      ? PROVIDER_RESOURCE_LIMITS.maxQueryColumns
      : PROVIDER_RESOURCE_LIMITS.maxObjectProperties
    if (entries.length > columnLimit) {
      return resourceFailure(
        value,
        current.path.endsWith('/cells') ? 'maxQueryColumns' : 'maxObjectProperties',
        entries.length,
        current.path
      )
    }
    for (let index = entries.length - 1; index >= 0; index--) {
      const [key, child] = entries[index]
      if (key.length > PROVIDER_RESOURCE_LIMITS.maxStringCodeUnits) {
        return resourceFailure(value, 'maxStringCodeUnits', key.length, `${current.path}/${key}`)
      }
      stack.push({ kind: 'enter', value: child, path: `${current.path}/${key}`, depth: current.depth + 1 })
    }
  }
  return null
}

interface LexicalContext {
  kind: 'array' | 'object'
  count: number
  expectingKey: boolean
  expectingValue: boolean
  key: string | null
  path: string
  limitName: keyof typeof PROVIDER_RESOURCE_LIMITS
  limit: number
}

function lexicalArrayLimit(key: string | null): {
  name: keyof typeof PROVIDER_RESOURCE_LIMITS
  value: number
} {
  if (key === 'records') return { name: 'maxRecordsPerSession', value: PROVIDER_RESOURCE_LIMITS.maxRecordsPerSession }
  if (key === 'sessions') return { name: 'maxSessionsPerOutcome', value: PROVIDER_RESOURCE_LIMITS.maxSessionsPerOutcome }
  if (key === 'rows') return { name: 'maxQueryRows', value: PROVIDER_RESOURCE_LIMITS.maxQueryRows }
  return { name: 'maxArrayItems', value: PROVIDER_RESOURCE_LIMITS.maxArrayItems }
}

function preflightJsonText<T>(text: string): ProviderSchemaValidation<T> | null {
  const stack: LexicalContext[] = []
  let nodes = 0

  const registerNode = (path: string): ProviderSchemaValidation<T> | null => {
    nodes++
    return nodes > PROVIDER_RESOURCE_LIMITS.maxNodes
      ? resourceFailure(text, 'maxNodes', nodes, path)
      : null
  }

  const registerValue = (): ProviderSchemaValidation<T> | null => {
    const parent = stack.at(-1)
    if (!parent || !parent.expectingValue) return null
    parent.expectingValue = false
    if (parent.kind === 'array') {
      parent.count++
      if (parent.count > parent.limit) {
        return resourceFailure(text, parent.limitName, parent.count, parent.path)
      }
    }
    return null
  }

  for (let index = 0; index < text.length;) {
    const char = text[index]
    if (/\s/.test(char) || char === ':') {
      index++
      continue
    }
    if (char === ',') {
      const parent = stack.at(-1)
      if (parent) {
        parent.expectingValue = true
        if (parent.kind === 'object') parent.expectingKey = true
      }
      index++
      continue
    }
    if (char === ']' || char === '}') {
      stack.pop()
      index++
      continue
    }
    if (char === '"') {
      let length = 0
      let keyText = ''
      index++
      while (index < text.length && text[index] !== '"') {
        if (text[index] === '\\' && index + 1 < text.length) {
          index += 2
          length++
        } else {
          if (keyText.length < 64) keyText += text[index]
          index++
          length++
        }
        if (length > PROVIDER_RESOURCE_LIMITS.maxStringCodeUnits) {
          return resourceFailure(text, 'maxStringCodeUnits', length)
        }
      }
      index++
      const parent = stack.at(-1)
      if (parent?.kind === 'object' && parent.expectingKey) {
        parent.count++
        if (parent.count > PROVIDER_RESOURCE_LIMITS.maxObjectProperties) {
          return resourceFailure(text, 'maxObjectProperties', parent.count, parent.path)
        }
        parent.expectingKey = false
        parent.expectingValue = true
        parent.key = keyText
      } else {
        const budget = registerNode(parent?.path || '$') || registerValue()
        if (budget) return budget
      }
      continue
    }
    if (char === '[' || char === '{') {
      const parent = stack.at(-1)
      const parentKey = parent?.kind === 'object' ? parent.key : null
      const path = parent ? `${parent.path}/${parentKey || parent.count}` : '$'
      const nodeBudget = registerNode(path) || registerValue()
      if (nodeBudget) return nodeBudget
      const arrayLimit = lexicalArrayLimit(parentKey)
      stack.push({
        kind: char === '[' ? 'array' : 'object',
        count: 0,
        expectingKey: char === '{',
        expectingValue: char === '[',
        key: null,
        path,
        limitName: char === '[' ? arrayLimit.name : 'maxObjectProperties',
        limit: char === '[' ? arrayLimit.value : PROVIDER_RESOURCE_LIMITS.maxObjectProperties
      })
      if (stack.length > PROVIDER_RESOURCE_LIMITS.maxJsonDepth) {
        return resourceFailure(text, 'maxJsonDepth', stack.length, path)
      }
      index++
      continue
    }

    const parent = stack.at(-1)
    const budget = registerNode(parent?.path || '$') || registerValue()
    if (budget) return budget
    while (index < text.length && !/[\s,\]}]/.test(text[index])) index++
  }
  return null
}

function ajvIssues(errors: ErrorObject[] | null | undefined): ProviderSchemaIssue[] {
  return (errors || []).map((entry) => ({
    path: `$${entry.instancePath}`,
    keyword: entry.keyword,
    message: entry.message || 'schema validation failed'
  }))
}

function validateWithSchema<T>(
  value: unknown,
  validator: ValidateFunction<T>
): ProviderSchemaValidation<T> {
  const resource = preflightValueBudget<T>(value)
  if (resource) return resource
  if (!validator(value)) {
    return failed(value, 'schema-validation-failed', ajvIssues(validator.errors))
  }
  return { ok: true, value, issues: [] }
}

export function validateProviderManifest(value: unknown): ProviderSchemaValidation<ProviderManifest> {
  return validateWithSchema(value, validateManifestSchema)
}

export function validateProviderEnvelope(value: unknown): ProviderSchemaValidation<ProviderEnvelope> {
  return validateWithSchema(value, validateEnvelopeSchema)
}

export function decodeProviderEnvelope(input: string | Uint8Array): ProviderSchemaValidation<ProviderEnvelope> {
  const bytes = typeof input === 'string' ? Buffer.byteLength(input, 'utf8') : input.byteLength
  if (bytes > PROVIDER_RESOURCE_LIMITS.maxEnvelopeBytes) {
    return resourceFailure(input, 'maxEnvelopeBytes', bytes)
  }
  let text: string
  try {
    text = typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: true }).decode(input)
  } catch {
    return failed(input, 'schema-validation-failed', [issue('$', 'utf8', 'provider envelope must be valid UTF-8')])
  }
  const lexical = preflightJsonText<ProviderEnvelope>(text)
  if (lexical) return lexical
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return failed(input, 'schema-validation-failed', [issue('$', 'json-parse', 'provider envelope must be valid JSON')])
  }
  return validateProviderEnvelope(value)
}

export function assertProviderEnvelope(value: unknown): ProviderEnvelope {
  const result = validateProviderEnvelope(value)
  if (!result.ok) throw new ProviderProtocolValidationError(result.error!, result.issues)
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
