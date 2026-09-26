/**
 * Test-only (never imported by production code): bundle the checkup worker
 * entry (src/checkup/cli-worker.ts) into one CommonJS file with esbuild, the way
 * scripts/checkup-dev.mjs bundles the kernel, so tests can spawn it with
 * process.execPath. The gate runs Vitest before `npm run build`, so tests must
 * not depend on the built worker in out/main. better-sqlite3 and electron stay
 * external; the spawned worker finds better-sqlite3 through NODE_PATH
 * (repositoryNodeModules()).
 */
import * as path from 'node:path'
import { build } from 'esbuild'

export function repositoryNodeModules(): string {
  return path.join(process.cwd(), 'node_modules')
}

/** Writes `<outDir>/checkup-worker-bundle.cjs` and returns its path. */
export async function bundleCheckupWorker(outDir: string): Promise<string> {
  const outfile = path.join(outDir, 'checkup-worker-bundle.cjs')
  await build({
    entryPoints: [path.join(process.cwd(), 'src', 'checkup', 'cli-worker.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['better-sqlite3', 'electron'],
    outfile,
    logLevel: 'silent',
    legalComments: 'none'
  })
  return outfile
}
