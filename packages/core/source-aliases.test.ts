import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { swobCoreSourceAliases, type SourceAlias } from './source-aliases'

const packageRoot = import.meta.dirname
const repoRoot = path.resolve(packageRoot, '../..')
const entriesDirectory = path.join(packageRoot, 'src/entries')
const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
  name: string
  exports: Record<string, string | { types: string; import: string }>
}

interface ExportCase {
  specifier: string
  source: string
}

function filesUnder(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name)
    return entry.isDirectory() ? filesUnder(fullPath) : [fullPath]
  })
}

/** One case per public specifier; a wildcard export expands to every file it exposes. */
function exportCases(): ExportCase[] {
  return Object.entries(manifest.exports).flatMap(([key, target]) => {
    const specifier = key === '.' ? manifest.name : `${manifest.name}/${key.slice(2)}`
    if (typeof target !== 'string') {
      const entry = /^\.\/dist\/entries\/([\w-]+)\.js$/.exec(target.import)?.[1]
      if (!entry || target.types !== `./dist/entries/${entry}.d.ts`) {
        throw new Error(`${key} must map dist/entries/<name>.{js,d.ts} built from src/entries/<name>.ts`)
      }
      return [{ specifier, source: path.join(entriesDirectory, `${entry}.ts`) }]
    }
    if (!key.endsWith('/*')) return [{ specifier, source: path.join(packageRoot, target) }]
    const directory = path.join(packageRoot, target.slice(0, -1))
    return filesUnder(directory).map((file) => ({
      specifier: `${specifier.slice(0, -1)}${path.relative(directory, file).split(path.sep).join('/')}`,
      source: file
    }))
  })
}

function viteResolve(aliases: SourceAlias[], specifier: string): string | undefined {
  const alias = aliases.find((entry) => entry.find.test(specifier))
  return alias && path.normalize(specifier.replace(alias.find, alias.replacement))
}

function typeScriptResolver(tsconfig: string): (specifier: string) => string | undefined {
  const configPath = path.join(repoRoot, tsconfig)
  const { config } = ts.readConfigFile(configPath, ts.sys.readFile)
  const { options } = ts.parseJsonConfigFileContent(config, ts.sys, repoRoot, undefined, configPath)
  const importer = path.join(repoRoot, 'src/shared/importer.ts')
  return (specifier) => {
    const resolved = ts.resolveModuleName(specifier, importer, options, ts.sys).resolvedModule
    return resolved && fs.realpathSync(resolved.resolvedFileName)
  }
}

function coreAliases(aliases: unknown): Array<{ find: string; replacement: string }> {
  return (aliases as SourceAlias[])
    .map((alias) => ({ find: String(alias.find), replacement: alias.replacement }))
    .filter((alias) => alias.find.includes('@swob'))
}

describe('@swob/core source aliases', () => {
  const cases = exportCases()

  it('every export has a source file and every entry module is exported', () => {
    for (const entry of cases) expect(fs.existsSync(entry.source), entry.specifier).toBe(true)
    const exportedEntries = cases
      .filter((entry) => path.dirname(entry.source) === entriesDirectory)
      .map((entry) => path.basename(entry.source))
    const entryModules = fs.readdirSync(entriesDirectory)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    expect([...entryModules].sort()).toEqual([...exportedEntries].sort())
  })

  it('the Vite aliases send every export to its source file', () => {
    const aliases = swobCoreSourceAliases()
    for (const entry of cases) expect(viteResolve(aliases, entry.specifier), entry.specifier).toBe(entry.source)
  })

  it.each(['tsconfig.node.json', 'tsconfig.web.json'])('%s paths send every export to its source file', (tsconfig) => {
    const resolve = typeScriptResolver(tsconfig)
    for (const entry of cases.filter((candidate) => /\.(?:ts|json)$/.test(candidate.source))) {
      expect(resolve(entry.specifier), entry.specifier).toBe(fs.realpathSync(entry.source))
    }
  })

  it('electron-vite main, preload, renderer and vitest all wire the shared aliases', async () => {
    const expected = coreAliases(swobCoreSourceAliases())
    const electronConfigPath = path.join(repoRoot, 'electron.vite.config.ts')
    const vitestConfigPath = path.join(repoRoot, 'vitest.config.ts')
    const electronConfig = (await import(/* @vite-ignore */ electronConfigPath)).default
    const vitestConfig = (await import(/* @vite-ignore */ vitestConfigPath)).default
    for (const target of ['main', 'preload', 'renderer']) {
      expect(coreAliases(electronConfig[target].resolve.alias), target).toEqual(expected)
    }
    expect(coreAliases(vitestConfig.resolve.alias)).toEqual(expected)
  })
})
