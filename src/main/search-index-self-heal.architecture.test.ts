import * as fs from 'node:fs'
import * as path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { swobCoreSourceAliases } from '../../packages/core/source-aliases'

/**
 * F1d-3-b: only the desktop app's library worker repairs search.db (moves a
 * corrupt one aside, rebuilds it, prunes backups after it). The CLI — `swob
 * grep`, `swob doctor …`, anything under src/cli — can never reach that: the
 * F1d-3 verification found `swob grep` repairing inside the CLI process,
 * with no log, while a running app kept writing into the moved copy. Pinned
 * here by the sources' syntax trees (TypeScript's parser), not their text:
 * 1. search-index.ts reaches repairCorruptSearchIndex only through
 *    armSearchIndexSelfHeal, and every thread starts unarmed;
 * 2. the one call of armSearchIndexSelfHeal is the library worker thread's
 *    bootstrap (`if (!isMainThread && parentPort)`);
 * 3. the modules the CLI entry and the doctor checkup worker load never
 *    include library-worker.ts; the one lazy edge to it is the worker port's
 *    `import('./library-worker')`, built only on Electron's main thread;
 * 4. in everything the CLI could load, pruning and the check's repair are
 *    called only from inside the repair itself.
 * search-index-corrupt.test.ts (src/cli) shows what the CLI does instead.
 */

const repositoryRoot = path.resolve(__dirname, '..', '..')
const relative = (filePath: string): string => path.relative(repositoryRoot, filePath).split(path.sep).join('/')
const absolute = (relativePath: string): string => path.join(repositoryRoot, relativePath)

const CLI_ENTRIES = ['src/cli/index.ts', 'src/checkup/cli-worker.ts']
const SEARCH_INDEX = 'src/main/search-index.ts'
const LIBRARY_WORKER = 'src/main/library-worker.ts'
const WRITER = 'src/main/search-index-writer.ts'
const APP_MAIN = 'src/main/index.ts'

function productionFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' || entry.name.startsWith('__') ? [] : productionFiles(entryPath)
    }
    if (!/\.(?:ts|tsx|cts|mts|cjs|mjs|js)$/.test(entry.name)) return []
    if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name) || /\.d\.[cm]?ts$/.test(entry.name)) return []
    return [entryPath]
  })
}

const productionSources = [
  ...productionFiles(absolute('src')),
  ...productionFiles(absolute('packages/core/src'))
]

const parsed = new Map<string, ts.SourceFile>()
function sourceFile(filePath: string): ts.SourceFile {
  let file = parsed.get(filePath)
  if (!file) {
    const kind = filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : /\.[cm]?js$/.test(filePath) ? ts.ScriptKind.JS : ts.ScriptKind.TS
    file = ts.createSourceFile(filePath, fs.readFileSync(filePath, 'utf8'), ts.ScriptTarget.ES2022, true, kind)
    parsed.set(filePath, file)
  }
  return file
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node)
  node.forEachChild((child) => walk(child, visit))
}

const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.cjs', '.mjs', '.json']

/** A module file for an import specifier; null for packages and node builtins. */
function resolveModule(from: string, specifier: string): string | null {
  for (const alias of swobCoreSourceAliases()) {
    if (alias.find.test(specifier)) return specifier.replace(alias.find, alias.replacement)
  }
  if (!specifier.startsWith('.')) return null
  const base = path.resolve(path.dirname(from), specifier)
  const candidates = [
    base,
    // An ESM specifier names the emitted file: ./x.js is ./x.ts in the sources.
    ...(/\.[cm]?js$/.test(base) ? ['.ts', '.tsx', '.mts', '.cts'].map((extension) => base.replace(/\.[cm]?js$/, extension)) : []),
    ...EXTENSIONS.map((extension) => base + extension),
    ...EXTENSIONS.map((extension) => path.join(base, `index${extension}`))
  ]
  const found = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile())
  if (!found) throw new Error(`${relative(from)} imports ${specifier}, which does not resolve`)
  return found
}

interface Edge {
  readonly from: string
  readonly to: string
  /** eager: loaded with the module (import / export … from); lazy: import() or require(), when that code runs. */
  readonly kind: 'eager' | 'lazy'
  readonly node: ts.Node
}

const edgeCache = new Map<string, Edge[]>()
function edgesOf(filePath: string): Edge[] {
  const cached = edgeCache.get(filePath)
  if (cached) return cached
  const edges: Edge[] = []
  if (!filePath.endsWith('.json')) {
    walk(sourceFile(filePath), (node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const clause = node.importClause
        const typeOnly = Boolean(clause && (clause.isTypeOnly || (
          !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every((element) => element.isTypeOnly)
        )))
        const to = typeOnly ? null : resolveModule(filePath, node.moduleSpecifier.text)
        if (to) edges.push({ from: filePath, to, kind: 'eager', node })
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && !node.isTypeOnly) {
        const to = resolveModule(filePath, node.moduleSpecifier.text)
        if (to) edges.push({ from: filePath, to, kind: 'eager', node })
      } else if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0])) {
        const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
        const required = ts.isIdentifier(node.expression) && node.expression.text === 'require'
        const to = dynamicImport || required ? resolveModule(filePath, node.arguments[0].text) : null
        if (to) edges.push({ from: filePath, to, kind: 'lazy', node })
      }
    })
  }
  edgeCache.set(filePath, edges)
  return edges
}

function closure(entry: string, kinds: ReadonlyArray<Edge['kind']>): Set<string> {
  const seen = new Set([absolute(entry)])
  const queue = [absolute(entry)]
  while (queue.length > 0) {
    for (const edge of edgesOf(queue.shift()!)) {
      if (!kinds.includes(edge.kind) || seen.has(edge.to)) continue
      seen.add(edge.to)
      queue.push(edge.to)
    }
  }
  return seen
}

/** Calls of a function by its name. */
function callsOf(file: ts.SourceFile, name: string): ts.CallExpression[] {
  const calls: ts.CallExpression[] = []
  walk(file, (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) calls.push(node)
  })
  return calls
}

/** The name of the function or class declaration a node sits in (innermost), or null at the top level. */
function enclosingDeclaration(node: ts.Node, kind: 'function' | 'class'): string | null {
  for (let current = node.parent; current; current = current.parent) {
    if (kind === 'function' && ts.isFunctionDeclaration(current)) return current.name?.text ?? null
    if (kind === 'class' && ts.isClassDeclaration(current)) return current.name?.text ?? null
  }
  return null
}

function functionDeclaration(file: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const found = file.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === name)
  if (!found) throw new Error(`${relative(file.fileName)} declares no function ${name}`)
  return found
}

describe('F1d-3-b: only the desktop app\'s library worker repairs search.db', () => {
  it('search-index.ts reaches the repair only through armSearchIndexSelfHeal, and every thread starts unarmed', () => {
    const file = sourceFile(absolute(SEARCH_INDEX))
    const repair = functionDeclaration(file, 'repairCorruptSearchIndex')
    expect(repair.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false).toBe(false)

    const references: string[] = []
    walk(file, (node) => {
      if (ts.isIdentifier(node) && node.text === 'repairCorruptSearchIndex' && node !== repair.name) {
        references.push(enclosingDeclaration(node, 'function') ?? '<top level>')
      }
    })
    expect(references).toEqual(['armSearchIndexSelfHeal'])

    let initializer: ts.Expression | undefined
    const assignments: string[] = []
    walk(file, (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'selfHeal') initializer = node.initializer
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left) && node.left.text === 'selfHeal') {
        assignments.push(enclosingDeclaration(node, 'function') ?? '<top level>')
      }
    })
    expect(initializer?.kind).toBe(ts.SyntaxKind.NullKeyword)
    expect(assignments).toEqual(['armSearchIndexSelfHeal', 'armSearchIndexSelfHeal'])

    // A write and the check's repair both go through what the thread armed.
    const reads: string[] = []
    walk(file, (node) => {
      if (ts.isIdentifier(node) && node.text === 'selfHeal' &&
        !(ts.isVariableDeclaration(node.parent) && node.parent.name === node) &&
        !(ts.isBinaryExpression(node.parent) && node.parent.left === node)) {
        reads.push(enclosingDeclaration(node, 'function') ?? '<top level>')
      }
    })
    expect(reads.sort()).toEqual(['refuseLeftCorruptIndex', 'repairSearchIndexAfterCheck', 'withSearchIndexRepair'])
  })

  it('the one place that arms it is the library worker thread\'s bootstrap', () => {
    const calls = productionSources.flatMap((filePath) =>
      callsOf(sourceFile(filePath), 'armSearchIndexSelfHeal').map((call) => ({ file: relative(filePath), call })))
    expect(calls.map(({ file }) => file)).toEqual([LIBRARY_WORKER])

    // Inside `if (!isMainThread && parentPort) { … }` at the module's top level: it runs only when
    // library-worker.js is a worker thread's entry, never where the module is merely imported.
    let branch: ts.Node = calls[0].call
    while (branch.parent && !ts.isSourceFile(branch.parent)) branch = branch.parent
    expect(ts.isIfStatement(branch)).toBe(true)
    const bootstrap = branch as ts.IfStatement
    expect(bootstrap.expression.getText()).toBe('!isMainThread && parentPort')
    expect(bootstrap.elseStatement).toBeUndefined()
    expect(calls[0].call.pos >= bootstrap.thenStatement.pos && calls[0].call.end <= bootstrap.thenStatement.end).toBe(true)
  })

  it('the CLI and the doctor checkup worker never load the library worker: one lazy edge, taken only on Electron\'s main thread', () => {
    for (const entry of CLI_ENTRIES) {
      const eager = closure(entry, ['eager'])
      const all = closure(entry, ['eager', 'lazy'])
      expect(eager.has(absolute(SEARCH_INDEX)), entry).toBe(true)
      expect(eager.has(absolute(LIBRARY_WORKER)), entry).toBe(false)
      expect(all.has(absolute(APP_MAIN)), entry).toBe(false)
      const intoWorker = [...all].flatMap((filePath) => edgesOf(filePath))
        .filter((edge) => edge.to === absolute(LIBRARY_WORKER))
        .map((edge) => ({
          from: relative(edge.from),
          kind: edge.kind,
          inside: enclosingDeclaration(edge.node, 'class'),
          text: edge.node.getText()
        }))
      expect(intoWorker, entry).toEqual([
        { from: WRITER, kind: 'lazy', inside: 'WorkerSearchIndexWritePort', text: "import('./library-worker')" }
      ])
    }

    // That port is built in one place, and only where the writer runs off Electron's main thread.
    const constructions = productionSources.flatMap((filePath) => {
      const found: string[] = []
      walk(sourceFile(filePath), (node) => {
        if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'WorkerSearchIndexWritePort') {
          found.push(`${relative(filePath)}:${enclosingDeclaration(node, 'function')}`)
        }
      })
      return found
    })
    expect(constructions).toEqual([`${WRITER}:getSearchIndexWriteCoordinator`])
    const coordinator = functionDeclaration(sourceFile(absolute(WRITER)), 'getSearchIndexWriteCoordinator')
    let dedicated: string | undefined
    let choice: string | undefined
    walk(coordinator, (node) => {
      if (ts.isVariableDeclaration(node) && node.name.getText() === 'useDedicatedWorker') dedicated = node.initializer?.getText()
      if (ts.isConditionalExpression(node) && node.whenTrue.getText().startsWith('new WorkerSearchIndexWritePort')) choice = node.getText()
    })
    expect(dedicated?.replace(/\s+/g, ' ')).toBe(
      "process.env.NODE_ENV !== 'test' && Boolean(process.versions.electron) && isMainThread"
    )
    expect(choice).toBe('useDedicatedWorker ? new WorkerSearchIndexWritePort() : new InProcessSearchIndexWritePort()')
  })

  it('in everything the CLI could load, pruning and the check\'s repair are called only from inside the repair and the worker\'s check', () => {
    for (const entry of CLI_ENTRIES) {
      const callers = [...closure(entry, ['eager', 'lazy'])]
        .filter((filePath) => !filePath.endsWith('.json'))
        .flatMap((filePath) => ['pruneProgramBackups', 'repairSearchIndexAfterCheck'].flatMap((name) =>
          callsOf(sourceFile(filePath), name).map((call) => `${name} @ ${relative(filePath)}:${enclosingDeclaration(call, 'function')}`)))
        .sort()
      expect(callers, entry).toEqual([
        `pruneProgramBackups @ ${SEARCH_INDEX}:repairCorruptSearchIndex`,
        `repairSearchIndexAfterCheck @ ${LIBRARY_WORKER}:checkSearchIndexIntegrityInWorker`
      ])
    }
  })
})
