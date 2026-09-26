import * as fs from 'node:fs'
import * as path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { resolveTypeScriptImport, runtimeRelativeImports } from '../main/__test-support__/typescript-runtime-closure'

const ROOT = process.cwd()
const CHECKUP = path.join(ROOT, 'src', 'checkup')

/** Kernel entries the checkup must never reference (task C1a red line). */
const FORBIDDEN_ENTRIES = [
  /^loadAllSessionsWithProviderStatus$/,
  /^loadCachedClaudeLineageMetadata$/,
  /^loadSessionDetail/,
  /^loadResumeAuditSessions$/,
  /^runResumeAudit$/,
  /^scanLibrary$/,
  /^refreshCanonicalProviders$/,
  /^getCanonicalSessionStore$/,
  /^buildSessionLineageRegistryFromClaudeFiles$/,
  /^saveAdditionalCodexHomes$/,
  /^migrateLegacyDiskCacheToSqlite$/
]
const FORBIDDEN_MODULES = /(?:session-lineage|canonical-store|canonical-package|search-index|usage-fact-store|library-manager|resume-audit|provider-runtime|config-store)$/

/**
 * The only runtime kernel imports allowed, all in readout.ts. C1c (task book, explicit exception to the
 * C1a red line): the per-file reads with stats, parseSessionFileWithStats (replaces parseSessionFile)
 * and parseCodexFileWithStats.
 */
const ALLOWED_KERNEL_IMPORTS: Record<string, string[]> = {
  'src/main/session-loader.ts': ['findClaudeSessionFiles', 'loadAllSessions', 'parseSessionFileWithStats'],
  'src/main/codex-loader.ts': ['findCodexSessionFiles', 'parseCodexFileWithStats'],
  'src/main/runtime-home.ts': ['runtimeHome']
}

function listTs(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listTs(full))
    else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full)
  }
  return out.sort()
}

function parse(fileName: string): ts.SourceFile {
  return ts.createSourceFile(fileName, fs.readFileSync(fileName, 'utf8'), ts.ScriptTarget.Latest, true)
}

function moduleSpecifiers(fileName: string): string[] {
  const specifiers: string[] = []
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(parse(fileName))
  return specifiers
}

function identifiers(fileName: string): string[] {
  const names: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) names.push(node.text)
    ts.forEachChild(node, visit)
  }
  visit(parse(fileName))
  return names
}

const relative = (fileName: string): string => path.relative(ROOT, fileName).split(path.sep).join('/')

describe('checkup architecture: read-only kernel gateway', () => {
  const files = listTs(CHECKUP)

  it('only readout.ts imports the kernel at runtime, and only the allowed entries', () => {
    for (const fileName of files) {
      const source = parse(fileName)
      for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue
        const specifier = statement.moduleSpecifier.text
        if (!specifier.startsWith('.')) continue
        const target = relative(resolveTypeScriptImport(fileName, specifier))
        if (!target.startsWith('src/main/')) continue
        const clause = statement.importClause
        if (!clause || clause.isTypeOnly) continue
        const names = clause.namedBindings && ts.isNamedImports(clause.namedBindings)
          ? clause.namedBindings.elements.filter((element) => !element.isTypeOnly).map((element) => (element.propertyName ?? element.name).text)
          : ['*']
        if (names.length === 0) continue
        expect(relative(fileName), `${relative(fileName)} imports ${target}`).toBe('src/checkup/readout.ts')
        expect(ALLOWED_KERNEL_IMPORTS[target], target).toBeDefined()
        for (const name of names) expect(ALLOWED_KERNEL_IMPORTS[target], `${target}#${name}`).toContain(name)
      }
    }
  })

  it('no checkup file references a forbidden kernel entry or writer module', () => {
    for (const fileName of files) {
      const hits = identifiers(fileName).filter((name) => FORBIDDEN_ENTRIES.some((pattern) => pattern.test(name)))
      expect(hits, relative(fileName)).toEqual([])
      for (const specifier of moduleSpecifiers(fileName)) {
        expect(FORBIDDEN_MODULES.test(specifier), `${relative(fileName)} -> ${specifier}`).toBe(false)
      }
      const dynamic = runtimeRelativeImports(fs.readFileSync(fileName, 'utf8'), fileName)
      for (const specifier of dynamic) expect(FORBIDDEN_MODULES.test(specifier), specifier).toBe(false)
    }
  })

  it('every loadAllSessions( call passes an object literal with readOnly: true', () => {
    let calls = 0
    for (const fileName of files) {
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'loadAllSessions') {
          calls++
          const [argument] = node.arguments
          expect(argument && ts.isObjectLiteralExpression(argument), relative(fileName)).toBe(true)
          const readOnly = (argument as ts.ObjectLiteralExpression).properties.find((property) =>
            ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === 'readOnly')
          expect(readOnly && ts.isPropertyAssignment(readOnly) && readOnly.initializer.kind === ts.SyntaxKind.TrueKeyword, relative(fileName)).toBe(true)
        }
        ts.forEachChild(node, visit)
      }
      visit(parse(fileName))
    }
    expect(calls).toBe(1)
  })
})
