import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import ts from 'typescript'
import {
  runtimeRelativeImports,
  typescriptRuntimeDependencyClosure
} from './__test-support__/typescript-runtime-closure'

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
    const closure = typescriptRuntimeDependencyClosure(entryFile)
    const violations = closure.flatMap((fileName) =>
      forbiddenPuritySyntax(fs.readFileSync(fileName, 'utf-8'), fileName)
    )

    expect(closure.map((fileName) => path.basename(fileName)).sort()).toEqual([
      'portable-path.ts',
      'resume-recovery-planner.ts',
      'session-remote-state.ts'
    ])
    expect(violations).toEqual([])
  })

  it('shared AST closure parser includes dynamic imports and excludes type-only edges', () => {
    const sourceText = [
      "import type { TypeOnly } from './type-only'",
      "export type { AnotherType } from './another-type'",
      "export { runtimeValue } from './runtime-export'",
      "void import('./dynamic-helper')"
    ].join('\n')

    expect(runtimeRelativeImports(sourceText, 'synthetic-closure.ts')).toEqual([
      './runtime-export',
      './dynamic-helper'
    ])
    expect(() => runtimeRelativeImports(
      "void import('./' + helperName)",
      'computed-dynamic-import.ts'
    )).toThrow('dynamic import must use a static string literal')
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
