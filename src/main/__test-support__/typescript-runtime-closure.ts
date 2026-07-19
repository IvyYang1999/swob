import * as fs from 'node:fs'
import * as path from 'node:path'
import ts from 'typescript'

function importDeclarationIsRuntime(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause
  if (!clause) return true
  if (clause.isTypeOnly) return false
  if (clause.name) return true
  const bindings = clause.namedBindings
  if (bindings && ts.isNamedImports(bindings)) {
    return bindings.elements.some((element) => !element.isTypeOnly)
  }
  return true
}

function exportDeclarationIsRuntime(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return false
  const clause = node.exportClause
  if (clause && ts.isNamedExports(clause)) {
    return clause.elements.some((element) => !element.isTypeOnly)
  }
  return true
}

/** Find every local runtime edge, including re-exports and dynamic import(). */
export function runtimeRelativeImports(sourceText: string, fileName: string): string[] {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true)
  const imports: string[] = []

  const addSpecifier = (specifier: ts.Expression | undefined): void => {
    if (specifier && ts.isStringLiteralLike(specifier) && specifier.text.startsWith('.')) {
      imports.push(specifier.text)
    }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && importDeclarationIsRuntime(node)) {
      addSpecifier(node.moduleSpecifier)
    } else if (ts.isExportDeclaration(node) && exportDeclarationIsRuntime(node)) {
      addSpecifier(node.moduleSpecifier)
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const specifier = node.arguments[0]
      if (!specifier || !ts.isStringLiteralLike(specifier)) {
        throw new Error(`${fileName}: dynamic import must use a static string literal for closure analysis`)
      }
      addSpecifier(specifier)
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return imports
}

export function resolveTypeScriptImport(fromFile: string, specifier: string): string {
  const candidate = path.resolve(path.dirname(fromFile), specifier)
  const choices = [
    candidate,
    `${candidate}.ts`,
    `${candidate}.tsx`,
    `${candidate}.mts`,
    `${candidate}.cts`,
    path.join(candidate, 'index.ts'),
    path.join(candidate, 'index.tsx')
  ]
  const resolved = choices.find((choice) => fs.existsSync(choice) && fs.statSync(choice).isFile())
  if (!resolved) throw new Error(`cannot resolve TypeScript runtime dependency: ${fromFile} -> ${specifier}`)
  return resolved
}

/** Recursively resolve the complete local runtime dependency closure. */
export function typescriptRuntimeDependencyClosure(entryFiles: string | string[]): string[] {
  const pending = Array.isArray(entryFiles) ? [...entryFiles] : [entryFiles]
  const visited = new Set<string>()

  while (pending.length > 0) {
    const fileName = path.resolve(pending.pop()!)
    if (visited.has(fileName)) continue
    visited.add(fileName)
    const sourceText = fs.readFileSync(fileName, 'utf-8')
    for (const specifier of runtimeRelativeImports(sourceText, fileName)) {
      pending.push(resolveTypeScriptImport(fileName, specifier))
    }
  }

  return [...visited]
}
