/**
 * Build the public source matrix from Swob's capability registry.
 *
 * The website is a separate repository, so the destination is explicit:
 *   node scripts/generate-source-matrix.mjs /path/to/swob-website/public/source-matrix.json
 */
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, '..')
const destination = process.argv[2]

if (!destination) {
  throw new Error('Output path required: node scripts/generate-source-matrix.mjs <source-matrix.json>')
}

const registryFile = resolve(repositoryRoot, 'src/shared/provider-capabilities.ts')
const outputFile = resolve(process.cwd(), destination)
if (outputFile === repositoryRoot || outputFile.startsWith(`${repositoryRoot}${sep}`)) {
  throw new Error('Output must be outside the desktop repository; publish into the standalone website repository')
}
const repositoryRequire = createRequire(resolve(repositoryRoot, 'package.json'))
const ts = repositoryRequire('typescript')

const registrySource = readFileSync(registryFile, 'utf8')
const transpiled = ts.transpileModule(registrySource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true
  },
  fileName: registryFile,
  reportDiagnostics: true
})

if (transpiled.diagnostics?.length) {
  const messages = transpiled.diagnostics.map((diagnostic) =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
  )
  throw new Error(`Cannot compile provider capability registry:\n${messages.join('\n')}`)
}

const evaluatedModule = { exports: {} }
const evaluate = new Function('module', 'exports', transpiled.outputText)
evaluate(evaluatedModule, evaluatedModule.exports)
const registry = evaluatedModule.exports

if (!Array.isArray(registry.BUILTIN_PROVIDER_DEFINITIONS)) {
  throw new Error('BUILTIN_PROVIDER_DEFINITIONS was not exported by the registry')
}

const capabilities = [
  'discover', 'summary', 'transcript', 'tools', 'thinking',
  'usage', 'relationships', 'subagents', 'live-watch', 'search',
  'archive', 'terminal-resume', 'native-resume', 'format-provenance'
]

const publicDeclaration = (declaration) => ({
  status: declaration.status,
  reason: declaration.reason
})

const sources = registry.BUILTIN_PROVIDER_DEFINITIONS.map((definition) => ({
  sourceId: definition.sourceId,
  displayName: definition.manifest.displayName,
  tier: definition.tier,
  columns: {
    measurement: publicDeclaration(definition.manifest.capabilities.usage),
    valuation: publicDeclaration(definition.valuation)
  },
  capabilities: Object.fromEntries(capabilities.map((capability) => [
    capability,
    definition.manifest.capabilities[capability].status
  ]))
}))

if (sources.length !== 14) {
  throw new Error(`Expected 14 built-in sources for v1.4.0, received ${sources.length}`)
}

const output = {
  schemaVersion: 2,
  generatedFrom: 'src/shared/provider-capabilities.ts',
  columns: [
    { id: 'measurement', label: { 'zh-CN': '计量', en: 'Measurement' } },
    { id: 'valuation', label: { 'zh-CN': '计价', en: 'Valuation' } }
  ],
  capabilities,
  sources
}

mkdirSync(dirname(outputFile), { recursive: true })
writeFileSync(outputFile, `${JSON.stringify(output, null, 2)}\n`)
console.log(`Generated ${outputFile}: ${sources.length} sources`)
