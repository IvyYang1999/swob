export const SWOBLENS_SCHEMA_VERSION = 1 as const

export const SWOBLENS_LIMITS = {
  archiveBytes: 2 * 1024 * 1024,
  entryBytes: 256 * 1024,
  totalUncompressedBytes: 512 * 1024,
  entries: 16,
  compressionRatio: 50,
  manifestBytes: 32 * 1024
} as const

export const SWOBLENS_THEME_TOKEN_KEYS = [
  'base',
  'surface',
  'hover',
  'pressed',
  'bright',
  'primary',
  'body',
  'secondary',
  'muted',
  'faint',
  'edge',
  'edge-subtle',
  'edge-strong',
  'edge-focus',
  'accent',
  'active',
  'soft-blue',
  'soft-green',
  'soft-red',
  'soft-amber',
  'soft-purple',
  'soft-cyan',
  'soft-indigo',
  'soft-pink',
  'soft-orange',
  'soft-emerald'
] as const

export const SWOBLENS_SHARE_COLOR_REFERENCES = [
  'base',
  'surface',
  'primary',
  'secondary',
  'muted',
  'edge',
  'accent',
  'soft-blue',
  'soft-orange'
] as const

export type SwobLensPackageType = 'theme' | 'lens-preset' | 'share-template'
export type SwobLensThemeTokenKey = typeof SWOBLENS_THEME_TOKEN_KEYS[number]
export type SwobLensShareColorReference = typeof SWOBLENS_SHARE_COLOR_REFERENCES[number]

export interface SwobLensLocalizedText {
  readonly 'zh-CN': string
  readonly en: string
}

export interface SwobLensManifestFile {
  readonly path: string
  readonly sha256: string
  readonly bytes: number
}

/**
 * Schema v1 intentionally describes declarations only. It has no entry point,
 * permissions, hooks, URLs, or executable contribution fields.
 */
export interface SwobLensManifest {
  readonly schemaVersion: typeof SWOBLENS_SCHEMA_VERSION
  readonly id: string
  readonly name: SwobLensLocalizedText
  readonly version: string
  readonly type: SwobLensPackageType
  readonly author: string
  readonly minSwobVersion: string
  readonly declaration: string
  readonly files: readonly SwobLensManifestFile[]
}

export interface SwobLensThemeDeclaration {
  readonly schemaVersion: typeof SWOBLENS_SCHEMA_VERSION
  readonly label: SwobLensLocalizedText
  readonly mode: 'light' | 'dark' | 'both'
  readonly tokens: Readonly<Partial<Record<SwobLensThemeTokenKey, string>>>
}

export const SWOBLENS_BUILTIN_LENS_IDS = [
  'highlights',
  'image-index',
  'outputs',
  'token-insights',
  'galaxy',
  'audit',
  'share-templates'
] as const

export interface SwobLensPresetDeclaration {
  readonly schemaVersion: typeof SWOBLENS_SCHEMA_VERSION
  readonly label: SwobLensLocalizedText
  readonly enabledLenses: readonly string[]
  readonly order: readonly string[]
  readonly sceneTags: readonly ('knowledge' | 'developer' | 'team')[]
}

export interface SwobLensShareTemplateDeclaration {
  readonly schemaVersion: typeof SWOBLENS_SCHEMA_VERSION
  readonly label: SwobLensLocalizedText
  readonly layout: 'compact' | 'conversation' | 'poster'
  readonly watermark: string
  readonly colors: {
    readonly bg: SwobLensShareColorReference
    readonly cardBg: SwobLensShareColorReference
    readonly text: SwobLensShareColorReference
    readonly textSecondary: SwobLensShareColorReference
    readonly textMuted: SwobLensShareColorReference
    readonly userAccent: SwobLensShareColorReference
    readonly assistantAccent: SwobLensShareColorReference
    readonly border: SwobLensShareColorReference
  }
}

export type SwobLensDeclaration =
  | SwobLensThemeDeclaration
  | SwobLensPresetDeclaration
  | SwobLensShareTemplateDeclaration

export interface SwobLensPackagePreview {
  readonly sourcePath: string
  readonly digest: string
  readonly compressedBytes: number
  readonly uncompressedBytes: number
  readonly manifest: SwobLensManifest
  readonly declaration: SwobLensDeclaration
}

export interface InstalledSwobLensPackage {
  readonly digest: string
  readonly enabled: boolean
  readonly installedAt: string
  readonly manifest: SwobLensManifest
  readonly declaration: SwobLensDeclaration
}

export interface SwobLensPackageList {
  readonly packages: readonly InstalledSwobLensPackage[]
  readonly errors: readonly { readonly id: string; readonly code: string; readonly message: string }[]
}

export type SwobLensIpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
