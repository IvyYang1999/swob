import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const schemaPath = path.join(root, 'schema/provider-protocol-v1.schema.json')
const conformancePath = path.join(root, 'schema/provider-protocol-v1.conformance.json')
const outputPath = path.join(root, 'src/shared/provider-schema.generated.ts')
const checkOnly = process.argv.includes('--check')
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'))
const conformance = JSON.parse(fs.readFileSync(conformancePath, 'utf8'))

if (conformance.wireProtocolVersion !== schema.$defs.ProtocolVersion.enum[0]) {
  throw new Error('provider conformance wireProtocolVersion must match the schema protocol version')
}
if (conformance.schemaId !== schema.$id) {
  throw new Error('provider conformance schemaId must match the schema $id')
}
for (const [name, value] of Object.entries(conformance.resourceLimits)) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`provider resource limit ${name} must be a positive safe integer`)
  }
}

function jsonPointerValue(document, pointer) {
  if (!pointer.startsWith('/')) throw new Error(`invalid schema JSON pointer: ${pointer}`)
  return pointer.slice(1).split('/').reduce((value, segment) => {
    const key = segment.replaceAll('~1', '/').replaceAll('~0', '~')
    if (value === null || typeof value !== 'object' || !(key in value)) {
      throw new Error(`provider schema limit binding does not exist: ${pointer}`)
    }
    return value[key]
  }, document)
}

for (const [limitName, pointers] of Object.entries(conformance.schemaLimitBindings || {})) {
  const expected = conformance.resourceLimits[limitName]
  if (!Number.isSafeInteger(expected)) {
    throw new Error(`provider schema binding references unknown resource limit: ${limitName}`)
  }
  if (!Array.isArray(pointers) || pointers.length === 0) {
    throw new Error(`provider schema limit binding must contain JSON pointers: ${limitName}`)
  }
  for (const pointer of pointers) {
    const actual = jsonPointerValue(schema, pointer)
    if (actual !== expected) {
      throw new Error(
        `provider schema limit ${pointer} (${actual}) must match ${limitName} (${expected})`
      )
    }
  }
}

function refName(ref) {
  const prefix = '#/$defs/'
  if (!ref.startsWith(prefix)) throw new Error(`Unsupported external $ref: ${ref}`)
  return ref.slice(prefix.length)
}

function propertyName(name) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name)
}

function typeExpression(node) {
  if (node.$ref) return refName(node.$ref)
  if (Object.prototype.hasOwnProperty.call(node, 'const')) return JSON.stringify(node.const)
  if (node.enum) return node.enum.map((value) => JSON.stringify(value)).join(' | ')
  if (node.oneOf) return node.oneOf.map(typeExpression).join(' | ')
  if (node.anyOf) return node.anyOf.map(typeExpression).join(' | ')
  if (node.allOf) {
    const structuralChildren = node.allOf.filter((value) => !value.if)
    const base = { ...node }
    delete base.allOf
    const hasBaseShape = base.type || base.properties || base.additionalProperties || base.$ref || base.oneOf || base.anyOf
    const parts = [
      ...(hasBaseShape ? [typeExpression(base)] : []),
      ...structuralChildren.map(typeExpression)
    ]
    return parts.length > 0 ? parts.map((value) => `(${value})`).join(' & ') : 'unknown'
  }
  if (Array.isArray(node.type)) return node.type.map((value) => typeExpression({ ...node, type: value })).join(' | ')
  if (node.type === 'string') return 'string'
  if (node.type === 'number' || node.type === 'integer') return 'number'
  if (node.type === 'boolean') return 'boolean'
  if (node.type === 'null') return 'null'
  if (node.type === 'array') return `Array<${typeExpression(node.items || {})}>`
  if (node.type === 'object' || node.properties || node.additionalProperties) {
    const required = new Set(node.required || [])
    const properties = Object.entries(node.properties || {}).map(([name, value]) =>
      `${propertyName(name)}${required.has(name) ? '' : '?'}: ${typeExpression(value)}`
    )
    let objectType = properties.length > 0 ? `{ ${properties.join('; ')} }` : '{}'
    if (node.additionalProperties && typeof node.additionalProperties === 'object') {
      const values = typeExpression(node.additionalProperties)
      objectType = properties.length > 0
        ? `(${objectType} & Record<string, ${values}>)`
        : `Record<string, ${values}>`
    } else if (node.additionalProperties === true) {
      objectType = properties.length > 0
        ? `(${objectType} & Record<string, unknown>)`
        : 'Record<string, unknown>'
    }
    return objectType
  }
  return 'unknown'
}

const definitions = Object.entries(schema.$defs).map(([name, definition]) => {
  // An interface breaks TypeScript's otherwise-illegal recursive alias cycle:
  // JsonValue -> JsonObject -> JsonValue.
  if (name === 'JsonObject') return 'export interface JsonObject { [key: string]: JsonValue }'
  return `export type ${name} = ${typeExpression(definition)}`
})
const capabilityNames = schema.$defs.CapabilityName.enum
const capabilityStates = schema.$defs.CapabilityStatus.enum
const parseStatuses = schema.$defs.ParseStatus.enum

const generated = `/* eslint-disable */
/**
 * GENERATED FILE. DO NOT EDIT.
 * Sources: schema/provider-protocol-v1.schema.json,
 *          schema/provider-protocol-v1.conformance.json
 * Run: npm run schema:gen
 */

export const PROVIDER_PROTOCOL_SCHEMA_ID = ${JSON.stringify(schema.$id)} as const
export const PROVIDER_PROTOCOL_VERSION = ${JSON.stringify(schema.$defs.ProtocolVersion.enum[0])} as const
export const PROVIDER_CONFORMANCE_VERSION = ${JSON.stringify(conformance.contractVersion)} as const
export const PROVIDER_RESOURCE_LIMITS = ${JSON.stringify(conformance.resourceLimits, null, 2)} as const
export const PROVIDER_QUERY_FRAME_VERSION = ${JSON.stringify(conformance.queryFrame.currentSchemaVersion)} as const
export const PROVIDER_CAPABILITY_NAMES = ${JSON.stringify(capabilityNames)} as const
export const PROVIDER_CAPABILITY_STATES = ${JSON.stringify(capabilityStates)} as const
export const PROVIDER_PARSE_STATUSES = ${JSON.stringify(parseStatuses)} as const

${definitions.join('\n\n')}
`

if (checkOnly) {
  const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : ''
  if (current !== generated) {
    console.error('provider schema generated types are stale; run npm run schema:gen')
    process.exit(1)
  }
} else {
  fs.writeFileSync(outputPath, generated)
}
