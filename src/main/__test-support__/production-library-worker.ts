import * as fs from 'node:fs'
import * as path from 'node:path'
import { build as viteBuild } from 'vite'

/**
 * Bundle src/main/library-worker.ts as the app does and return a loader for a
 * real worker thread, so a test crosses the same thread boundary as the app
 * (F1d-3: repairs and PRAGMA quick_check run there, never on the main
 * thread). Same recipe as library-worker.test.ts.
 */
export async function buildProductionLibraryWorker(root: string): Promise<string> {
  const bundlePath = path.join(root, 'production-worker.cjs')
  const workerPath = path.join(root, 'production-worker-loader.cjs')
  await viteBuild({
    configFile: false,
    logLevel: 'error',
    build: {
      ssr: path.join(__dirname, '..', 'library-worker.ts'),
      outDir: root,
      emptyOutDir: false,
      minify: false,
      sourcemap: false,
      target: 'node22',
      rollupOptions: {
        external: (id) => id.startsWith('node:') || (!id.startsWith('.') && !path.isAbsolute(id)),
        output: {
          format: 'cjs',
          entryFileNames: path.basename(bundlePath),
          inlineDynamicImports: true
        }
      }
    }
  })
  fs.writeFileSync(workerPath, `
    const path = require('node:path')
    const Module = require('node:module')
    process.env.NODE_PATH = [
      ${JSON.stringify(path.join(process.cwd(), 'node_modules'))},
      process.env.NODE_PATH
    ].filter(Boolean).join(path.delimiter)
    Module._initPaths()
    require(${JSON.stringify(bundlePath)})
  `)
  return workerPath
}
