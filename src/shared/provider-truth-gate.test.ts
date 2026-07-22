import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(import.meta.dirname, '../..')

function productionTypeScriptFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) return productionTypeScriptFiles(fullPath)
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) return []
    return [fullPath]
  })
}

describe('provider capability static truth gate', () => {
  it('main/shared production code never derives parser/search/usage/resume support from a source count', () => {
    const files = [
      ...productionTypeScriptFiles(path.join(root, 'src/main')),
      ...productionTypeScriptFiles(path.join(root, 'src/shared'))
    ]
    const forbidden = [
      /supportedSources\.length/,
      /LEGACY_SESSION_SOURCES\.length/,
      /BUILTIN_PROVIDER_DEFINITIONS\.length/,
      /ALL_SOURCES/
    ]
    const violations = files.flatMap((file) => {
      const source = fs.readFileSync(file, 'utf8')
      return forbidden
        .filter((pattern) => pattern.test(source))
        .map((pattern) => `${path.relative(root, file)} matches ${pattern}`)
    })
    expect(violations).toEqual([])
  })

  it('the closed SessionSource compatibility type is derived from the provider registry', () => {
    const source = fs.readFileSync(path.join(root, 'src/main/types.ts'), 'utf8')
    expect(source).toContain('export type SessionSource = LegacySessionSource')
    expect(source).not.toMatch(/export type SessionSource\s*=\s*'claude-code'/)
  })

  it('platform and Insights source inventories consume the capability registry', () => {
    const platform = fs.readFileSync(path.join(root, 'src/main/platform-support.ts'), 'utf8')
    const insights = fs.readFileSync(path.join(root, 'src/main/insights.ts'), 'utf8')
    expect(platform).toContain('BUILTIN_PROVIDER_DEFINITIONS')
    expect(platform).toContain('discoverableSources')
    expect(insights).toContain('sessionHasParsedTranscript')
    expect(insights).not.toContain('providerCanParseTranscript')
    expect(insights).toContain('BUILTIN_PROVIDER_DEFINITIONS.map')
  })

  it('canonical schema excludes Library/Vault identity and user state', () => {
    const schema = fs.readFileSync(path.join(root, 'schema/provider-protocol-v1.schema.json'), 'utf8')
    for (const forbidden of [
      'LogicalSessionKey', 'logicalSessionKey', 'packageId', 'customTitle',
      'userFolder', 'userTags', 'resumeCommand'
    ]) {
      expect(schema, forbidden).not.toContain(forbidden)
    }
    expect(schema).toContain('providerTitle')
    expect(schema).toContain('"lossy": { "const": true }')
  })
})
