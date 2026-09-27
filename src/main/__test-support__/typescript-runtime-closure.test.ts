import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveTypeScriptImport, typescriptRuntimeDependencyClosure } from './typescript-runtime-closure'

const temporaryRoots: string[] = []

function fixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-ts-closure-'))
  temporaryRoots.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of temporaryRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('resolveTypeScriptImport / typescriptRuntimeDependencyClosure', () => {
  // No source file in this repo currently imports a relative sibling with a
  // '.js' specifier (an ESM-style specifier naming compiled output while the
  // real source is .ts/.tsx), so this path was latent: it throws rather than
  // silently missing an edge, but nothing exercised it (S1 small fix #2).
  it('resolves a relative ".js" specifier to its ".ts" sibling', () => {
    const dir = fixture()
    const entryFile = path.join(dir, 'entry.ts')
    const siblingFile = path.join(dir, 'sibling.ts')
    fs.writeFileSync(entryFile, "import { value } from './sibling.js'\nexport { value }\n")
    fs.writeFileSync(siblingFile, 'export const value = 1\n')

    expect(resolveTypeScriptImport(entryFile, './sibling.js')).toBe(siblingFile)
    expect(typescriptRuntimeDependencyClosure(entryFile).sort()).toEqual([entryFile, siblingFile].sort())
  })

  it('resolves a relative ".js" specifier to its ".tsx" sibling when there is no ".ts" one', () => {
    const dir = fixture()
    const entryFile = path.join(dir, 'entry.ts')
    const siblingFile = path.join(dir, 'widget.tsx')
    fs.writeFileSync(entryFile, "import { Widget } from './widget.js'\nexport { Widget }\n")
    fs.writeFileSync(siblingFile, 'export const Widget = 1\n')

    expect(resolveTypeScriptImport(entryFile, './widget.js')).toBe(siblingFile)
  })

  it('still resolves an extensionless specifier and still throws for a truly missing one', () => {
    const dir = fixture()
    const entryFile = path.join(dir, 'entry.ts')
    const siblingFile = path.join(dir, 'sibling.ts')
    fs.writeFileSync(siblingFile, 'export const value = 1\n')

    expect(resolveTypeScriptImport(entryFile, './sibling')).toBe(siblingFile)
    expect(() => resolveTypeScriptImport(entryFile, './does-not-exist.js'))
      .toThrow(/cannot resolve TypeScript runtime dependency/)
  })
})
