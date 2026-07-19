import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import ts from 'typescript'

/**
 * Vitest's ESM mocks below guard ESM imports and runtime access, but Node's native
 * CommonJS require/createRequire can bypass that mock boundary. The static closure
 * rule therefore rejects require, createRequire, and fs module literals before code runs.
 */
function forbiddenPuritySyntax(sourceText: string, fileName: string): string[] {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true)
  const violations: string[] = []

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
      violations.push(`${fileName}: CommonJS require is forbidden`)
    }
    if (ts.isIdentifier(node) && node.text === 'createRequire') {
      violations.push(`${fileName}: createRequire is forbidden`)
    }
    if (ts.isStringLiteralLike(node) && [
      'fs',
      'node:fs',
      'fs/promises',
      'node:fs/promises'
    ].includes(node.text)) {
      violations.push(`${fileName}: filesystem module ${node.text} is forbidden`)
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return violations
}

function runtimeRelativeImports(sourceText: string, fileName: string): string[] {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true)
  const imports: string[] = []

  const addSpecifier = (specifier: ts.Expression | undefined, typeOnly: boolean): void => {
    if (!typeOnly && specifier && ts.isStringLiteralLike(specifier) && specifier.text.startsWith('.')) {
      imports.push(specifier.text)
    }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      addSpecifier(node.moduleSpecifier, Boolean(node.importClause?.isTypeOnly))
    } else if (ts.isExportDeclaration(node)) {
      addSpecifier(node.moduleSpecifier, node.isTypeOnly)
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      addSpecifier(node.arguments[0], false)
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return imports
}

function resolveTypeScriptImport(fromFile: string, specifier: string): string {
  const candidate = path.resolve(path.dirname(fromFile), specifier)
  const choices = [candidate, `${candidate}.ts`, path.join(candidate, 'index.ts')]
  const resolved = choices.find((choice) => fs.existsSync(choice))
  if (!resolved) throw new Error(`cannot resolve planner dependency: ${fromFile} -> ${specifier}`)
  return resolved
}

function plannerRuntimeDependencyClosure(entryFile: string): string[] {
  const pending = [entryFile]
  const visited = new Set<string>()

  while (pending.length > 0) {
    const fileName = pending.pop()!
    if (visited.has(fileName)) continue
    visited.add(fileName)
    const sourceText = fs.readFileSync(fileName, 'utf-8')
    for (const specifier of runtimeRelativeImports(sourceText, fileName)) {
      pending.push(resolveTypeScriptImport(fileName, specifier))
    }
  }

  return [...visited]
}

function installFilesystemTripwires(): void {
  const deniedModule = (moduleName: string): object => new Proxy(
    { __esModule: true },
    {
      get(target, property, receiver) {
        if (property === 'then') return undefined
        if (Reflect.has(target, property)) return Reflect.get(target, property, receiver)
        throw new Error(`filesystem side effect denied: ${moduleName}.${String(property)}`)
      }
    }
  )

  vi.doMock('fs', () => deniedModule('fs'))
  vi.doMock('node:fs', () => deniedModule('node:fs'))
  vi.doMock('fs/promises', () => deniedModule('fs/promises'))
  vi.doMock('node:fs/promises', () => deniedModule('node:fs/promises'))
}

afterEach(() => {
  vi.doUnmock('fs')
  vi.doUnmock('node:fs')
  vi.doUnmock('fs/promises')
  vi.doUnmock('node:fs/promises')
  vi.resetModules()
})

describe('recovery planner zero-side-effect boundary', () => {
  it('statically forbids CommonJS and filesystem access across the planner runtime closure', () => {
    const entryFile = path.resolve(process.cwd(), 'src/main/resume-recovery-planner.ts')
    const closure = plannerRuntimeDependencyClosure(entryFile)
    const violations = closure.flatMap((fileName) =>
      forbiddenPuritySyntax(fs.readFileSync(fileName, 'utf-8'), fileName)
    )

    expect(closure.map((fileName) => path.basename(fileName)).sort()).toEqual([
      'resume-recovery-planner.ts',
      'session-remote-state.ts'
    ])
    expect(violations).toEqual([])
  })

  it('proves the static rule catches both required CommonJS mutations', () => {
    expect(forbiddenPuritySyntax("require('fs')", 'require-mutation.ts')).toEqual([
      'require-mutation.ts: CommonJS require is forbidden',
      'require-mutation.ts: filesystem module fs is forbidden'
    ])
    expect(forbiddenPuritySyntax(
      "import { createRequire } from 'node:module'; createRequire(import.meta.url)('node:fs/promises')",
      'create-require-mutation.ts'
    )).toEqual([
      'create-require-mutation.ts: createRequire is forbidden',
      'create-require-mutation.ts: createRequire is forbidden',
      'create-require-mutation.ts: filesystem module node:fs/promises is forbidden'
    ])
  })

  it('installs full-module tripwires before dynamically importing and running the planner', async () => {
    vi.resetModules()
    installFilesystemTripwires()

    await expect(async () => {
      const fsPromises = await import('fs/promises')
      await fsPromises.appendFile('/fixture/forbidden', 'tripwire')
    }).rejects.toThrow(/filesystem side effect denied|No "appendFile" export/)

    const { classifyRecoverySourcePath, planSessionRecovery } = await import('./resume-recovery-planner')
    const result = planSessionRecovery({
      sessionId: '81000000-0000-4000-8000-000000000008',
      libraryMeta: {
        schemaVersion: 2,
        sessionId: '81000000-0000-4000-8000-000000000008',
        sourceFilePaths: [
          '/fixture/home-xx…3002/.claude/projects/-fixture-project-xx…3002/81000000-0000-4000-8000-000000000008.jsonl'
        ],
        createdAt: '2026-07-19T00:00:00.000Z',
        updatedAt: '2026-07-19T00:01:00.000Z',
        projectPath: '/fixture/project-xx…3002',
        origin: {
          deviceId: 'device-xx…3002',
          hostname: 'host-xx…3002',
          username: 'user-xx…3002',
          capturedAt: '2026-07-19T00:00:00.000Z'
        }
      },
      backup: {
        path: '/fixture/library-xx…3002/session-xx…3002/backup.jsonl',
        state: 'ready'
      },
      targetInstances: [{
        id: 'standard-xx…3002',
        kind: 'standard',
        projectsRoot: '/fixture/home-xx…3002/.claude/projects',
        configDir: '/fixture/home-xx…3002/.claude',
        available: true,
        trusted: true,
        existingFiles: []
      }],
      localDeviceId: 'device-xx…3002'
    })

    expect(result.ok).toBe(true)
    expect(classifyRecoverySourcePath(
      '/fixture/home-xx…3002/.claude/projects/-fixture-project-xx…3002/81000000-0000-4000-8000-000000000008.jsonl'
    ).kind).toBe('standard')
  })
})
