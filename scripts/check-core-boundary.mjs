#!/usr/bin/env node
/**
 * List every import edge that leaves a kernel candidate set.
 *
 *   node scripts/check-core-boundary.mjs --mode=type|runtime --list <path>... [--json] [--tsconfig=<file>]
 *
 * --list takes files and directories (directories contribute their non-test
 * .ts/.tsx/.mts/.cts files, skipping node_modules/dist/out) and `@file` arguments that
 * name a newline-separated list (`#` starts a comment; entries resolve against
 * the working directory like plain arguments). Every file inside a
 * listed directory counts as a member, so a JSON import that stays inside the
 * package is not an edge.
 *
 * An edge is an import from a scanned file to a repository file outside the
 * set. Node built-ins and node_modules packages are dependencies, not edges,
 * except the blacklisted host packages (electron, @electron-toolkit/*).
 * Imports that resolve to nothing (neither a file nor an installed package) are
 * reported as UNRESOLVED edges, so a broken path never passes silently.
 *
 * Edges are classified syntactically. Type edges: `import type`, `export type`,
 * imports/exports whose bindings are all inline `type`, and `import('x').T`
 * type nodes. Everything else (value or side-effect imports, `export *`,
 * dynamic `import()`, `require()`) is a runtime edge.
 *
 * Exit status: 0 when the selected mode has no edges, 1 when it has any,
 * 2 on usage or I/O errors.
 */
import fs from 'node:fs'
import { builtinModules, createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ts = createRequire(path.join(repoRoot, 'package.json'))('typescript')

const HOST_BLACKLIST = [
  /^src\/main\/library-manager\.ts$/,
  /^src\/main\/llm-profiles\.ts$/,
  /^src\/main\/config-store\.ts$/,
  /^src\/main\/provider-runtime\.ts$/,
  /^src\/main\/usage-fact-store\.ts$/,
  /^src\/main\/library-writer-lease\.ts$/,
  /^src\/main\/canonical-store\.ts$/,
  /^src\/main\/resume-[^/]+$/,
  /^src\/main\/index\.ts$/,
  /^src\/main\/types\.ts$/,
  /^src\/shared\/i18n(?:\.ts$|[-/])/,
  /^src\/shared\/settings-capabilities\.ts$/,
  /^src\/shared\/contracts\/truth-kernel\//
]
const PACKAGE_BLACKLIST = [/^electron$/, /^@electron-toolkit\//]
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'out', '.git'])
const SOURCE_FILE = /\.(?:ts|tsx|mts|cts)$/
const TEST_FILE = /\.(?:test|spec)\.(?:ts|tsx|mts|cts)$/
const USAGE = 'Usage: node scripts/check-core-boundary.mjs --mode=type|runtime --list <file|dir|@listfile>... [--json] [--tsconfig=<file>]'

class UsageError extends Error {}

function parseArguments(argv) {
  const options = { mode: null, list: [], json: false, tsconfig: path.join(repoRoot, 'tsconfig.node.json') }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const [flag, inlineValue] = argument.startsWith('--') && argument.includes('=')
      ? [argument.slice(0, argument.indexOf('=')), argument.slice(argument.indexOf('=') + 1)]
      : [argument, undefined]
    if (flag === '--help' || flag === '-h') {
      console.log(USAGE)
      process.exit(0)
    } else if (flag === '--mode') {
      options.mode = inlineValue ?? argv[++index]
    } else if (flag === '--json') {
      options.json = true
    } else if (flag === '--tsconfig') {
      const value = inlineValue ?? argv[++index]
      if (!value) throw new UsageError('--tsconfig requires a file')
      options.tsconfig = path.resolve(value)
    } else if (flag === '--list') {
      if (inlineValue !== undefined) options.list.push(inlineValue)
      while (index + 1 < argv.length && !argv[index + 1].startsWith('--')) options.list.push(argv[++index])
    } else {
      throw new UsageError(`Unknown argument: ${argument}`)
    }
  }
  if (options.mode !== 'type' && options.mode !== 'runtime') throw new UsageError('--mode must be type or runtime')
  if (options.list.length === 0) throw new UsageError('--list requires at least one file or directory')
  return options
}

function expandListArguments(entries) {
  return entries.flatMap((entry) => {
    if (!entry.startsWith('@')) return [entry]
    return fs.readFileSync(path.resolve(entry.slice(1)), 'utf8')
      .split(/\r?\n/)
      .map((line) => line.replace(/#.*/, '').trim())
      .filter(Boolean)
  })
}

function sourceFilesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) return SKIPPED_DIRECTORIES.has(entry.name) ? [] : sourceFilesUnder(fullPath)
    if (!entry.isFile() || !SOURCE_FILE.test(entry.name) || TEST_FILE.test(entry.name)) return []
    return [fullPath]
  })
}

function collectCandidateSet(entries) {
  const memberFiles = new Set()
  const memberDirectories = []
  const scanned = new Set()
  for (const entry of expandListArguments(entries)) {
    const absolute = path.resolve(entry)
    if (!fs.existsSync(absolute)) throw new UsageError(`--list entry does not exist: ${entry}`)
    const real = fs.realpathSync(absolute)
    if (fs.statSync(real).isDirectory()) {
      memberDirectories.push(real)
      for (const file of sourceFilesUnder(real)) scanned.add(fs.realpathSync(file))
    } else {
      memberFiles.add(real)
      if (SOURCE_FILE.test(real)) scanned.add(real)
    }
  }
  const isMember = (file) => memberFiles.has(file) ||
    memberDirectories.some((directory) => file === directory || file.startsWith(`${directory}${path.sep}`))
  return { scanned: [...scanned].sort(), isMember }
}

function compilerOptionsFrom(tsconfigPath) {
  const read = ts.readConfigFile(tsconfigPath, ts.sys.readFile)
  if (read.error) throw new UsageError(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'))
  return ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(tsconfigPath)).options
}

function allTypeOnly(elements) {
  return elements.length > 0 && elements.every((element) => element.isTypeOnly)
}

/** Every module reference in one file, classified as a type or runtime edge. */
function moduleReferences(file) {
  const sourceFile = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const references = []
  const add = (specifierNode, kind, syntax) => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(specifierNode.getStart(sourceFile))
    references.push({ specifier: specifierNode.text, kind, syntax, line: line + 1 })
  }
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause
      let kind = 'runtime'
      if (clause?.isTypeOnly) kind = 'type'
      else if (clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings) &&
        allTypeOnly(clause.namedBindings.elements)) kind = 'type'
      add(node.moduleSpecifier, kind, clause ? (kind === 'type' ? 'import type' : 'import') : 'side-effect import')
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const typeOnly = node.isTypeOnly ||
        Boolean(node.exportClause && ts.isNamedExports(node.exportClause) && allTypeOnly(node.exportClause.elements))
      add(node.moduleSpecifier, typeOnly ? 'type' : 'runtime', typeOnly ? 'export type' : 'export')
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)) {
      add(node.moduleReference.expression, node.isTypeOnly ? 'type' : 'runtime', 'import = require')
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      add(node.argument.literal, 'type', "import('…') type")
    } else if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0])) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node.arguments[0], 'runtime', 'dynamic import()')
      else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') add(node.arguments[0], 'runtime', 'require()')
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  for (const reference of sourceFile.referencedFiles) {
    const { line } = sourceFile.getLineAndCharacterOfPosition(reference.pos)
    references.push({ specifier: reference.fileName, kind: 'type', syntax: '/// <reference path>', line: line + 1, referencePath: true })
  }
  return references
}

function packageNameOf(specifier) {
  const segments = specifier.split('/')
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
}

function isBuiltin(specifier) {
  return specifier.startsWith('node:') || builtinModules.includes(specifier) ||
    builtinModules.includes(specifier.split('/')[0])
}

function repoRelative(file) {
  return path.relative(repoRoot, file).split(path.sep).join('/')
}

/** Implementation files a declaration file stands for (x.d.ts → x.js, x.d.cts → x.cjs, …). */
function implementationSiblings(file) {
  const match = file.match(/^(.*)\.d\.(c|m)?ts$/)
  if (!match) return []
  const extension = match[2] === 'c' ? 'cjs' : match[2] === 'm' ? 'mjs' : 'js'
  const sibling = `${match[1]}.${extension}`
  return fs.existsSync(sibling) ? [sibling] : []
}

function main() {
  const options = parseArguments(process.argv.slice(2))
  const { scanned, isMember } = collectCandidateSet(options.list)
  const compilerOptions = compilerOptionsFrom(options.tsconfig)
  const resolutionCache = ts.createModuleResolutionCache(repoRoot, (name) => name, compilerOptions)
  const edges = new Map()

  for (const file of scanned) {
    for (const reference of moduleReferences(file)) {
      let target
      if (reference.referencePath) {
        target = { file: path.resolve(path.dirname(file), reference.specifier) }
      } else if (isBuiltin(reference.specifier)) {
        continue
      } else {
        const resolved = ts.resolveModuleName(reference.specifier, file, compilerOptions, ts.sys, resolutionCache).resolvedModule
        const bare = !reference.specifier.startsWith('.') && !path.isAbsolute(reference.specifier)
        if (resolved) {
          const real = fs.realpathSync(resolved.resolvedFileName)
          const external = resolved.isExternalLibraryImport || real.split(path.sep).includes('node_modules') ||
            !real.startsWith(`${repoRoot}${path.sep}`)
          target = external ? { package: packageNameOf(reference.specifier) } : { file: real }
        } else if (bare && fs.existsSync(path.join(repoRoot, 'node_modules', packageNameOf(reference.specifier)))) {
          target = { package: packageNameOf(reference.specifier) }
        } else {
          target = { unresolved: reference.specifier }
        }
      }

      let to
      let blacklisted = false
      if (target.package) {
        blacklisted = PACKAGE_BLACKLIST.some((pattern) => pattern.test(target.package))
        if (!blacklisted) continue
        to = target.package
      } else if (target.file) {
        const candidates = [target.file, ...implementationSiblings(target.file)]
        if (candidates.some(isMember)) continue
        to = repoRelative(target.file)
        blacklisted = HOST_BLACKLIST.some((pattern) => pattern.test(to))
      } else {
        to = reference.specifier
      }

      const from = repoRelative(file)
      const key = `${reference.kind}\u0000${from}\u0000${to}`
      const edge = edges.get(key) ?? {
        kind: reference.kind, from, to, blacklisted, unresolved: Boolean(target.unresolved), syntax: new Set(), lines: []
      }
      edge.syntax.add(reference.syntax)
      edge.lines.push(reference.line)
      edges.set(key, edge)
    }
  }

  const all = [...edges.values()]
    .map((edge) => ({ ...edge, syntax: [...edge.syntax].sort(), lines: [...new Set(edge.lines)].sort((a, b) => a - b) }))
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
  const byKind = { type: all.filter((edge) => edge.kind === 'type'), runtime: all.filter((edge) => edge.kind === 'runtime') }
  const selected = byKind[options.mode]
  const other = options.mode === 'type' ? 'runtime' : 'type'

  if (options.json) {
    console.log(JSON.stringify({
      mode: options.mode,
      scannedFiles: scanned.map(repoRelative),
      edges: selected,
      counts: {
        type: byKind.type.length,
        runtime: byKind.runtime.length,
        blacklisted: selected.filter((edge) => edge.blacklisted).length
      }
    }, null, 2))
  } else {
    console.log(`core boundary: mode=${options.mode}, scanned ${scanned.length} file(s)`)
    for (const edge of selected) {
      const flags = [edge.blacklisted ? 'BLACKLIST' : '', edge.unresolved ? 'UNRESOLVED' : ''].filter(Boolean).join(' ')
      console.log(`  ${edge.from}:${edge.lines.join(',')} -> ${edge.to}  [${edge.syntax.join(', ')}]${flags ? `  ${flags}` : ''}`)
    }
    console.log(`${options.mode} edges: ${selected.length} (blacklisted: ${selected.filter((edge) => edge.blacklisted).length}); ` +
      `${other} edges (not selected): ${byKind[other].length}`)
  }
  return selected.length > 0 ? 1 : 0
}

try {
  process.exitCode = main()
} catch (error) {
  console.error(error instanceof UsageError ? `${error.message}\n${USAGE}` : error)
  process.exitCode = 2
}
