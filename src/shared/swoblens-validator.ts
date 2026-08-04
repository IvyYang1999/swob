import {
  SWOBLENS_BUILTIN_LENS_IDS,
  SWOBLENS_SCHEMA_VERSION,
  SWOBLENS_SHARE_COLOR_REFERENCES,
  SWOBLENS_THEME_TOKEN_KEYS,
  type SwobLensDeclaration,
  type SwobLensLocalizedText,
  type SwobLensManifest,
  type SwobLensManifestFile,
  type SwobLensPackageType
} from './swoblens-manifest'

export class SwobLensValidationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'SwobLensValidationError'
  }
}

const ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/
const PACKAGE_TYPES = new Set<SwobLensPackageType>(['theme', 'lens-preset', 'share-template'])
const THEME_KEYS = new Set<string>(SWOBLENS_THEME_TOKEN_KEYS)
const SHARE_COLOR_REFERENCES = new Set<string>(SWOBLENS_SHARE_COLOR_REFERENCES)
const LENS_IDS = new Set<string>(SWOBLENS_BUILTIN_LENS_IDS)
const SCENE_TAGS = new Set(['knowledge', 'developer', 'team'])

function fail(code: string, message: string): never {
  throw new SwobLensValidationError(code, message)
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_SCHEMA', `${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed)
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key))
  if (unknown.length > 0) fail('UNKNOWN_FIELD', `${label} contains unknown field: ${unknown[0]}`)
  const dangerous = Object.keys(value).find((key) => key === '__proto__' || key === 'prototype' || key === 'constructor')
  if (dangerous) fail('UNKNOWN_FIELD', `${label} contains forbidden field: ${dangerous}`)
}

function stringValue(value: unknown, label: string, max = 120): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value !== value.trim() || value.length > max) {
    fail('INVALID_SCHEMA', `${label} must be a non-empty string of at most ${max} characters`)
  }
  if (/\p{Cc}/u.test(value)) fail('INVALID_SCHEMA', `${label} contains control characters`)
  return value
}

function localizedText(value: unknown, label: string): SwobLensLocalizedText {
  const item = record(value, label)
  exactKeys(item, ['zh-CN', 'en'], label)
  return {
    'zh-CN': stringValue(item['zh-CN'], `${label}.zh-CN`, 80),
    en: stringValue(item.en, `${label}.en`, 80)
  }
}

export function isSafeSwobLensRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 160 || value.includes('\0')) return false
  if (value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(value)) return false
  if (value.includes('\\') || /^[a-z][a-z0-9+.-]*:/i.test(value)) return false
  const parts = value.split('/')
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..')
}

function manifestFile(value: unknown, index: number): SwobLensManifestFile {
  const item = record(value, `manifest.files[${index}]`)
  exactKeys(item, ['path', 'sha256', 'bytes'], `manifest.files[${index}]`)
  if (!isSafeSwobLensRelativePath(item.path) || item.path === 'manifest.json') {
    fail('INVALID_PATH', `manifest.files[${index}].path is unsafe`)
  }
  if (typeof item.sha256 !== 'string' || !SHA256_PATTERN.test(item.sha256)) {
    fail('INVALID_SCHEMA', `manifest.files[${index}].sha256 must be lowercase SHA-256`)
  }
  if (!Number.isInteger(item.bytes) || (item.bytes as number) < 1) {
    fail('INVALID_SCHEMA', `manifest.files[${index}].bytes must be a positive integer`)
  }
  return { path: item.path, sha256: item.sha256, bytes: item.bytes as number }
}

export function validateSwobLensManifest(value: unknown): SwobLensManifest {
  const manifest = record(value, 'manifest')
  exactKeys(manifest, [
    'schemaVersion', 'id', 'name', 'version', 'type', 'author',
    'minSwobVersion', 'declaration', 'files'
  ], 'manifest')
  if (manifest.schemaVersion !== SWOBLENS_SCHEMA_VERSION) fail('UNSUPPORTED_SCHEMA', 'Unsupported manifest schemaVersion')
  if (typeof manifest.id !== 'string' || !ID_PATTERN.test(manifest.id) || manifest.id.length > 80) {
    fail('INVALID_SCHEMA', 'manifest.id is invalid')
  }
  if (typeof manifest.version !== 'string' || !SEMVER_PATTERN.test(manifest.version)) {
    fail('INVALID_SCHEMA', 'manifest.version must be semantic version 2.0')
  }
  if (typeof manifest.minSwobVersion !== 'string' || !SEMVER_PATTERN.test(manifest.minSwobVersion)) {
    fail('INVALID_SCHEMA', 'manifest.minSwobVersion must be semantic version 2.0')
  }
  if (typeof manifest.type !== 'string' || !PACKAGE_TYPES.has(manifest.type as SwobLensPackageType)) {
    fail('INVALID_SCHEMA', 'manifest.type is unsupported')
  }
  if (!isSafeSwobLensRelativePath(manifest.declaration) || manifest.declaration.includes('/')) {
    fail('INVALID_PATH', 'manifest.declaration must be a root-level file')
  }
  if (!Array.isArray(manifest.files) || manifest.files.length !== 1) {
    fail('INVALID_SCHEMA', 'manifest.files must contain exactly the declaration file in schema v1')
  }
  const files = manifest.files.map(manifestFile)
  if (files[0].path !== manifest.declaration) fail('INVALID_SCHEMA', 'manifest.declaration must match manifest.files[0].path')
  return {
    schemaVersion: SWOBLENS_SCHEMA_VERSION,
    id: manifest.id,
    name: localizedText(manifest.name, 'manifest.name'),
    version: manifest.version,
    type: manifest.type as SwobLensPackageType,
    author: stringValue(manifest.author, 'manifest.author', 120),
    minSwobVersion: manifest.minSwobVersion,
    declaration: manifest.declaration,
    files
  }
}

function validateTheme(value: unknown): SwobLensDeclaration {
  const declaration = record(value, 'theme declaration')
  exactKeys(declaration, ['schemaVersion', 'label', 'mode', 'tokens'], 'theme declaration')
  if (declaration.schemaVersion !== SWOBLENS_SCHEMA_VERSION) fail('UNSUPPORTED_SCHEMA', 'Unsupported theme schemaVersion')
  if (declaration.mode !== 'light' && declaration.mode !== 'dark' && declaration.mode !== 'both') {
    fail('INVALID_SCHEMA', 'theme.mode must be light, dark, or both')
  }
  const tokens = record(declaration.tokens, 'theme.tokens')
  const entries = Object.entries(tokens)
  if (entries.length < 4) fail('INVALID_SCHEMA', 'theme.tokens must define at least four tokens')
  for (const [key, token] of entries) {
    if (!THEME_KEYS.has(key)) fail('TOKEN_NOT_ALLOWED', `Theme token is not allowed: ${key}`)
    if (typeof token !== 'string' || !COLOR_PATTERN.test(token)) {
      fail('TOKEN_VALUE_NOT_ALLOWED', `Theme token ${key} must be a six- or eight-digit hex color`)
    }
  }
  return {
    schemaVersion: SWOBLENS_SCHEMA_VERSION,
    label: localizedText(declaration.label, 'theme.label'),
    mode: declaration.mode,
    tokens
  }
}

function uniqueStringArray(value: unknown, label: string, allowed: Set<string>): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !allowed.has(item))) {
    fail('INVALID_SCHEMA', `${label} contains unsupported values`)
  }
  if (new Set(value).size !== value.length) fail('INVALID_SCHEMA', `${label} contains duplicates`)
  return [...value]
}

function validateLensPreset(value: unknown): SwobLensDeclaration {
  const declaration = record(value, 'Lens preset declaration')
  exactKeys(declaration, ['schemaVersion', 'label', 'enabledLenses', 'order', 'sceneTags'], 'Lens preset declaration')
  if (declaration.schemaVersion !== SWOBLENS_SCHEMA_VERSION) fail('UNSUPPORTED_SCHEMA', 'Unsupported Lens preset schemaVersion')
  const enabledLenses = uniqueStringArray(declaration.enabledLenses, 'lens-preset.enabledLenses', LENS_IDS)
  const order = uniqueStringArray(declaration.order, 'lens-preset.order', LENS_IDS)
  if (order.length !== LENS_IDS.size) fail('INVALID_SCHEMA', 'lens-preset.order must list every built-in Lens exactly once')
  const sceneTags = uniqueStringArray(declaration.sceneTags, 'lens-preset.sceneTags', SCENE_TAGS) as Array<'knowledge' | 'developer' | 'team'>
  if (sceneTags.length === 0) fail('INVALID_SCHEMA', 'lens-preset.sceneTags must not be empty')
  return {
    schemaVersion: SWOBLENS_SCHEMA_VERSION,
    label: localizedText(declaration.label, 'lens-preset.label'),
    enabledLenses,
    order,
    sceneTags
  }
}

function validatePlainCopy(value: unknown, label: string): string {
  const text = stringValue(value, label, 80)
  if (/[<>{}`]/.test(text)) fail('COPY_NOT_ALLOWED', `${label} must be plain text`)
  return text
}

function validateShareTemplate(value: unknown): SwobLensDeclaration {
  const declaration = record(value, 'share template declaration')
  exactKeys(declaration, ['schemaVersion', 'label', 'layout', 'watermark', 'colors'], 'share template declaration')
  if (declaration.schemaVersion !== SWOBLENS_SCHEMA_VERSION) fail('UNSUPPORTED_SCHEMA', 'Unsupported share template schemaVersion')
  if (declaration.layout !== 'compact' && declaration.layout !== 'conversation' && declaration.layout !== 'poster') {
    fail('INVALID_SCHEMA', 'share-template.layout is unsupported')
  }
  const colors = record(declaration.colors, 'share-template.colors')
  const colorKeys = ['bg', 'cardBg', 'text', 'textSecondary', 'textMuted', 'userAccent', 'assistantAccent', 'border'] as const
  exactKeys(colors, colorKeys, 'share-template.colors')
  for (const key of colorKeys) {
    if (typeof colors[key] !== 'string' || !SHARE_COLOR_REFERENCES.has(colors[key])) {
      fail('COLOR_REFERENCE_NOT_ALLOWED', `share-template.colors.${key} is unsupported`)
    }
  }
  return {
    schemaVersion: SWOBLENS_SCHEMA_VERSION,
    label: localizedText(declaration.label, 'share-template.label'),
    layout: declaration.layout,
    watermark: validatePlainCopy(declaration.watermark, 'share-template.watermark'),
    colors: colors as unknown as Extract<SwobLensDeclaration, { layout: unknown }>['colors']
  }
}

export function validateSwobLensDeclaration(type: SwobLensPackageType, value: unknown): SwobLensDeclaration {
  if (type === 'theme') return validateTheme(value)
  if (type === 'lens-preset') return validateLensPreset(value)
  return validateShareTemplate(value)
}

function semverParts(value: string): [number, number, number, string | null] {
  const match = SEMVER_PATTERN.exec(value)
  if (!match) fail('INVALID_VERSION', `Invalid semantic version: ${value}`)
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] || null]
}

/** Returns a negative value when left is older than right. */
export function compareSwobLensVersions(left: string, right: string): number {
  const a = semverParts(left)
  const b = semverParts(right)
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return (a[index] as number) - (b[index] as number)
  }
  if (a[3] === b[3]) return 0
  if (a[3] === null) return 1
  if (b[3] === null) return -1
  const leftIds = a[3].split('.')
  const rightIds = b[3].split('.')
  for (let index = 0; index < Math.max(leftIds.length, rightIds.length); index++) {
    const leftId = leftIds[index]
    const rightId = rightIds[index]
    if (leftId === undefined) return -1
    if (rightId === undefined) return 1
    if (leftId === rightId) continue
    const leftNumber = /^\d+$/.test(leftId) ? Number(leftId) : null
    const rightNumber = /^\d+$/.test(rightId) ? Number(rightId) : null
    if (leftNumber !== null && rightNumber !== null) return leftNumber - rightNumber
    if (leftNumber !== null) return -1
    if (rightNumber !== null) return 1
    return leftId.localeCompare(rightId)
  }
  return 0
}
