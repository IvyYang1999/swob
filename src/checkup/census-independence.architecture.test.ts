import * as fs from 'node:fs'
import * as path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { typescriptRuntimeDependencyClosure } from '../main/__test-support__/typescript-runtime-closure'

const ROOT = process.cwd()
const CHECKUP = path.join(ROOT, 'src', 'checkup')

// Same list as src/main/resume-validation-purity.test.ts FORBIDDEN_MUTATIONS.
const FORBIDDEN_MUTATIONS = new Set([
  'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'copyFile', 'copyFileSync',
  'rename', 'renameSync', 'unlink', 'unlinkSync', 'rm', 'rmSync', 'rmdir', 'rmdirSync',
  'mkdir', 'mkdirSync', 'truncate', 'truncateSync', 'createWriteStream', 'link', 'linkSync',
  'symlink', 'symlinkSync', 'chmod', 'chmodSync', 'chown', 'chownSync', 'utimes', 'utimesSync'
])

const READING_PATH_MODULES = /(?:^|\/)(?:session-loader|codex-loader|cursor-loader|opencode-loader|zcode-loader|session-source|sqlite-agent-usage|token-accounting|session-lineage|canonical-[^/]*|backup-validator)\.ts$|\/providers\//

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

function calledNames(fileName: string): string[] {
  const names: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = node.expression
      if (ts.isIdentifier(callee)) names.push(callee.text)
      if (ts.isPropertyAccessExpression(callee)) names.push(callee.name.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(parse(fileName))
  return names
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

const relative = (fileName: string): string => path.relative(ROOT, fileName).split(path.sep).join('/')

describe('checkup architecture: independent oracle', () => {
  const censusEntries = listTs(path.join(CHECKUP, 'census'))
  const closure = typescriptRuntimeDependencyClosure(censusEntries)

  it('census runtime closure stays inside src/checkup (+ the pure capability table)', () => {
    expect(censusEntries.length).toBeGreaterThanOrEqual(7)
    for (const fileName of closure.map(relative)) {
      expect(fileName.startsWith('src/checkup/') || fileName === 'src/shared/provider-capabilities.ts' || fileName === 'packages/core/src/shared/provider-capabilities.ts', fileName).toBe(true)
      expect(READING_PATH_MODULES.test(fileName), fileName).toBe(false)
    }
    expect(closure.map(relative).some((fileName) => fileName.startsWith('src/main/'))).toBe(false)
  })

  it('the allowed shared table is itself a closed, import-free declaration module', () => {
    const table = path.join(ROOT, 'src', 'shared', 'provider-capabilities.ts')
    expect(typescriptRuntimeDependencyClosure(table).map(relative)).toEqual(['src/shared/provider-capabilities.ts', 'packages/core/src/shared/provider-capabilities.ts'])
  })

  it('census closure has no fs write API, no child_process and no dynamic require', () => {
    for (const fileName of closure) {
      expect(calledNames(fileName).filter((name) => FORBIDDEN_MUTATIONS.has(name)), relative(fileName)).toEqual([])
      expect(moduleSpecifiers(fileName).filter((specifier) => /child_process/.test(specifier)), relative(fileName)).toEqual([])
      expect(fs.readFileSync(fileName, 'utf8'), relative(fileName)).not.toMatch(/\brequire\s*\(|\bcreateRequire\b/)
    }
  })

  it('isolated-home.ts (evaluated before the kernel) imports no kernel module at all', () => {
    const closure = typescriptRuntimeDependencyClosure(path.join(CHECKUP, 'isolated-home.ts')).map(relative)
    expect(closure).toEqual(['src/checkup/isolated-home.ts'])
  })
})
