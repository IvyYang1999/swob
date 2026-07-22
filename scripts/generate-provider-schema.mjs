import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const schemaPath = path.join(root, 'schema/provider-protocol-v1.schema.json')
const outputPath = path.join(root, 'src/shared/provider-schema.generated.ts')
const checkOnly = process.argv.includes('--check')
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'))

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
  if (node.allOf) return node.allOf.map((value) => `(${typeExpression(value)})`).join(' & ')
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
 * Source: schema/provider-protocol-v1.schema.json
 * Run: npm run schema:gen
 */

export const PROVIDER_PROTOCOL_SCHEMA_ID = ${JSON.stringify(schema.$id)} as const
export const PROVIDER_PROTOCOL_VERSION = ${JSON.stringify(schema.$defs.ProtocolVersion.enum[0])} as const
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
