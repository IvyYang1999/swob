import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Inside this repository @swob/core is compiled from source, never from dist,
 * so no build step has to run before the app, tests or pre-commit hook.
 *
 * electron-vite (main, preload, renderer) and vitest use these aliases; the
 * `paths` in tsconfig.node.json and tsconfig.web.json mirror them.
 * source-aliases.test.ts checks every package.json export resolves to the same
 * source file through all of them.
 */
export interface SourceAlias {
  find: RegExp
  replacement: string
}

const packageRoot = dirname(fileURLToPath(import.meta.url))

export function swobCoreSourceAliases(): SourceAlias[] {
  return [
    { find: /^@swob\/core$/, replacement: resolve(packageRoot, 'src/entries/index.ts') },
    { find: /^@swob\/core\/package\.json$/, replacement: resolve(packageRoot, 'package.json') },
    { find: /^@swob\/core\/schema\/(.+)$/, replacement: `${resolve(packageRoot, 'schema')}/$1` },
    { find: /^@swob\/core\/([^/]+)$/, replacement: `${resolve(packageRoot, 'src/entries')}/$1.ts` }
  ]
}
