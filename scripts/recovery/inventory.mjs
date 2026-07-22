#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

if (process.argv.includes('--apply') || process.argv.some((arg) => arg === 'apply')) {
  process.stderr.write('This tool is read-only: no apply command exists.\n')
  process.exitCode = 64
} else {
  const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'inventory-entry.ts')
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    write: false,
    logLevel: 'silent'
  })
  const source = result.outputFiles[0]?.text
  if (!source) throw new Error('Unable to build the read-only inventory tool')
  await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
}
