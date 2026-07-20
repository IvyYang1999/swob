import * as fs from 'node:fs'
import * as path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  runtimeRelativeImports,
  typescriptRuntimeDependencyClosure
} from './__test-support__/typescript-runtime-closure'

const VALIDATION_ENTRY_FILES = [
  'backup-validator.ts',
  'backup-repairer.ts',
  'resume-verifier.ts'
]

const ALL_ENTRY_FILES = [
  ...VALIDATION_ENTRY_FILES,
  'icloud-materializer.ts'
]

const FORBIDDEN_EFFECT_MODULES = new Set([
  'fs', 'node:fs', 'fs/promises', 'node:fs/promises',
  'child_process', 'node:child_process'
])

const FORBIDDEN_MUTATIONS = new Set([
  'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'copyFile', 'copyFileSync',
  'rename', 'renameSync', 'unlink', 'unlinkSync', 'rm', 'rmSync', 'rmdir', 'rmdirSync',
  'mkdir', 'mkdirSync', 'truncate', 'truncateSync', 'createWriteStream', 'link', 'linkSync',
  'symlink', 'symlinkSync', 'chmod', 'chmodSync', 'chown', 'chownSync', 'utimes', 'utimesSync'
])

function source(fileName: string): string {
  const resolved = path.isAbsolute(fileName)
    ? fileName
    : path.resolve(process.cwd(), 'src/main', fileName)
  return fs.readFileSync(resolved, 'utf8')
}

function parse(fileName: string): ts.SourceFile {
  return ts.createSourceFile(fileName, source(fileName), ts.ScriptTarget.Latest, true)
}

function calledNames(fileName: string): string[] {
  const names: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression)) names.push(node.expression.text)
      if (ts.isPropertyAccessExpression(node.expression)) names.push(node.expression.name.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(parse(fileName))
  return names
}

function runtimeModuleSpecifiers(fileName: string): string[] {
  const specifiers: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly &&
      ts.isStringLiteralLike(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text)
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text)
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      specifiers.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(parse(fileName))
  return specifiers
}

function entryPaths(fileNames: string[]): string[] {
  return fileNames.map((fileName) => path.resolve(process.cwd(), 'src/main', fileName))
}

describe('recovery validation layer purity boundary', () => {
  it('递归校验本单四模块的完整本地 runtime import 闭包', () => {
    const closure = typescriptRuntimeDependencyClosure(entryPaths(ALL_ENTRY_FILES))
    const iCloudEntry = path.resolve(process.cwd(), 'src/main/icloud-materializer.ts')

    expect(closure.map((fileName) => path.basename(fileName))).toEqual(expect.arrayContaining(ALL_ENTRY_FILES))
    for (const fileName of closure) {
      const effectModules = runtimeModuleSpecifiers(fileName)
        .filter((specifier) => FORBIDDEN_EFFECT_MODULES.has(specifier))
      if (fileName === iCloudEntry) {
        expect(effectModules, fileName).toEqual(['node:child_process', 'node:fs/promises'])
      } else {
        expect(effectModules, fileName).toEqual([])
      }
      expect(calledNames(fileName).filter((name) => FORBIDDEN_MUTATIONS.has(name)), fileName).toEqual([])
      expect(source(fileName), fileName).not.toMatch(/\brequire\s*\(|\bcreateRequire\b/)
    }
  })

  it('validator、repairer、verifier 的递归闭包没有 fs 或 child_process', () => {
    const closure = typescriptRuntimeDependencyClosure(entryPaths(VALIDATION_ENTRY_FILES))
    for (const fileName of closure) {
      expect(runtimeModuleSpecifiers(fileName).filter((specifier) =>
        FORBIDDEN_EFFECT_MODULES.has(specifier)
      ), fileName).toEqual([])
    }
  })

  it('共享 AST 解析器把 dynamic import 计入 runtime 闭包', () => {
    expect(runtimeRelativeImports(
      "type T = import('./type-query').T; void import('./runtime-helper')",
      'dynamic-import-fixture.ts'
    )).toEqual(['./runtime-helper'])
  })

  it('iCloud 模块只有只读 fs 入口和 execFile 下载入口，不含目标写入与稳定性判据', () => {
    const fileName = 'icloud-materializer.ts'
    const text = source(fileName)
    const imports = parse(fileName).statements
      .filter(ts.isImportDeclaration)
      .map((statement) => ({
        module: ts.isStringLiteralLike(statement.moduleSpecifier) ? statement.moduleSpecifier.text : '',
        names: statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)
          ? statement.importClause.namedBindings.elements.map((element) => element.propertyName?.text || element.name.text)
          : []
      }))

    expect(imports).toContainEqual({ module: 'node:fs/promises', names: ['access', 'readFile'] })
    expect(imports).toContainEqual({ module: 'node:child_process', names: ['execFile'] })
    expect(calledNames(fileName).filter((name) => FORBIDDEN_MUTATIONS.has(name))).toEqual([])
    expect(text).not.toMatch(/\bstat(?:Sync)?\b|\bmtime(?:Ms)?\b/)
    expect(text).toContain("runtime.execFile(BRCTL_PATH, ['download', downloadPath])")
  })

  it('resume-audit 直接复用共享 L3 核，不保留复制实现', () => {
    const text = source('resume-audit.ts')

    expect(text).toContain("from './resume-verifier'")
    expect(text).toContain('classifyResumeL3(expected, target)')
    for (const copiedDeclaration of [
      'function normalizeResumeAuditText',
      'function rawAnchorMessages',
      'function parsedAnchorMessages',
      'function anchorsFromMessages',
      'function selectClaudeDefaultChain',
      'function targetContainsAnchors'
    ]) {
      expect(text).not.toContain(copiedDeclaration)
    }
  })
})
