#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { packageNameFromLockPath, productionPackagePaths } from './production-lock-graph.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const lockPath = path.join(repoRoot, 'package-lock.json')
const defaultOutput = path.join(repoRoot, 'THIRD_PARTY_NOTICES')
const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const outputIndex = args.indexOf('--output')
const outputPath = outputIndex >= 0 ? path.resolve(args[outputIndex + 1]) : defaultOutput

if (outputIndex >= 0 && !args[outputIndex + 1]) {
  throw new Error('--output requires a file path')
}

const lockBytes = fs.readFileSync(lockPath)
const lock = JSON.parse(lockBytes)

const unique = new Map()
for (const packagePath of productionPackagePaths(lock)) {
  const metadata = lock.packages[packagePath]
  const name = packageNameFromLockPath(packagePath, metadata)
  const version = metadata.version ?? 'UNKNOWN'
  const license = typeof metadata.license === 'string' ? metadata.license : 'UNKNOWN'
  unique.set(`${name}\u0000${version}\u0000${license}`, { name, version, license })
}

const packages = [...unique.values()].sort((a, b) =>
  a.license.localeCompare(b.license) || a.name.localeCompare(b.name) || a.version.localeCompare(b.version)
)
const groups = new Map()
for (const entry of packages) {
  const group = groups.get(entry.license) ?? []
  group.push(entry)
  groups.set(entry.license, group)
}
const lines = [
  'SWOB THIRD-PARTY NOTICES',
  '',
  'This file is generated. Do not edit it by hand.',
  'Source: package-lock.json production dependency graph.',
  `Generator: scripts/generate-third-party-notices.mjs`,
  `package-lock.json SHA-256: ${crypto.createHash('sha256').update(lockBytes).digest('hex')}`,
  `Unique production packages: ${packages.length}`,
  '',
  'Electron and Chromium notices are distributed separately as',
  'LICENSE.electron.txt and LICENSES.chromium.html. Where an npm publisher',
  'ships package-specific license files, electron-builder preserves them',
  'alongside the corresponding packaged module.',
  '',
]

for (const [license, entries] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  lines.push(`=== ${license} ===`, '')
  for (const { name, version } of entries) {
    lines.push(`- ${name}@${version}  https://www.npmjs.com/package/${name}/v/${version}`)
  }
  lines.push('')
}

const generated = `${lines.join('\n').trimEnd()}\n`
if (checkOnly) {
  const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : ''
  if (current !== generated) {
    console.error(`${path.relative(repoRoot, outputPath)} is stale; run npm run notices:generate`)
    process.exit(1)
  }
  console.log(`${path.relative(repoRoot, outputPath)} is reproducible and current (${packages.length} packages)`)
} else {
  fs.writeFileSync(outputPath, generated)
  console.log(`Wrote ${path.relative(repoRoot, outputPath)} (${packages.length} packages)`)
}
