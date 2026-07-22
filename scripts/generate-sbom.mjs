#!/usr/bin/env node

import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'

function run(command, args) {
  execFileSync(command, args, { cwd: repoRoot, stdio: 'inherit' })
}

// Prove the complete lock graph first. No command in this script uses
// --ignore-npm-errors; a broken graph must stop SBOM generation.
run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ls', '--package-lock-only', '--all'])

const common = [
  '--yes',
  '@cyclonedx/cyclonedx-npm@4.1.1',
  '--package-lock-only',
  '--spec-version', '1.6',
  '--output-format', 'JSON',
  '--output-reproducible',
  '--validate',
  '--mc-type', 'application',
]

run(npx, [
  ...common,
  '--omit', 'dev',
  '--output-file', 'compliance/t131/sbom-production.cdx.json',
  'package.json',
])
run(npx, [
  ...common,
  '--output-file', 'compliance/t131/sbom-development.cdx.json',
  'package.json',
])

console.log('Regenerated production and development CycloneDX 1.6 SBOMs without ignored npm errors.')
