#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractFile, listPackage } from '@electron/asar'
import { packageNameFromLockPath, productionPackagePaths } from './production-lock-graph.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const requestedAsars = []
let inventoryRoot = path.join(repoRoot, 'dist', 'package-inventory')

for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--asar') {
    if (!args[index + 1]) throw new Error('--asar requires a file path')
    requestedAsars.push(path.resolve(args[++index]))
  } else if (args[index] === '--inventory-dir') {
    if (!args[index + 1]) throw new Error('--inventory-dir requires a directory path')
    inventoryRoot = path.resolve(args[++index])
  } else {
    throw new Error(`Unknown argument: ${args[index]}`)
  }
}

function findFiles(root, basename, results = []) {
  if (!fs.existsSync(root)) return results
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name)
    if (entry.isDirectory()) findFiles(absolute, basename, results)
    else if (entry.isFile() && entry.name === basename) results.push(absolute)
  }
  return results
}

function normalizedAsarPath(entry) {
  return `/${entry.replaceAll('\\', '/').replace(/^\/+/, '')}`
}

const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'))
const productionPackageVersions = new Map()
for (const packagePath of productionPackagePaths(lock)) {
  const metadata = lock.packages[packagePath]
  const name = packageNameFromLockPath(packagePath, metadata)
  const versions = productionPackageVersions.get(name) ?? new Set()
  versions.add(metadata.version)
  productionPackageVersions.set(name, versions)
}

const exactRuntimeFiles = new Set(['/package.json', '/LICENSE', '/NOTICE', '/THIRD_PARTY_NOTICES'])
const runtimeRoots = ['/out/main', '/out/preload', '/out/renderer']
const privateSegments = new Set(['.claude', '.git', '.worktrees', 'worktrees'])
const projectOnlySegments = new Set(['compliance', 'website', 'site', 'e2e', 'test', 'tests', '__tests__', 'docs'])
const sensitiveBasenamePatterns = [
  /^\.env(?:\..+)?$/i,
  /^settings(?:\.local)?\.(?:json|ya?ml|toml)$/i,
  /^(?:credentials?|secrets?)(?:\.[^.]+)?$/i,
  /^(?:cookies?)(?:\.(?:json|sqlite|db|txt))?$/i,
  /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token)(?:\.(?:json|txt|env))?$/i,
  /^(?:id_rsa|id_ed25519|\.npmrc|\.netrc)$/i,
  /\.(?:pem|p12|pfx|key)$/i,
]

function topLevelPackage(entry) {
  const match = entry.startsWith('/node_modules/@')
    ? entry.match(/^\/node_modules\/(@[^/]+\/[^/]+)(?:\/|$)/)
    : entry.match(/^\/node_modules\/([^/]+)(?:\/|$)/)
  if (!match) return null
  const name = match[1]
  return { name, root: `/node_modules/${name}` }
}

function isStructuralParent(entry) {
  return runtimeRoots.some((root) => root.startsWith(`${entry}/`))
    || entry === '/node_modules'
    || /^\/node_modules\/@[^/]+$/.test(entry)
}

function policyViolations(entries, asarPath) {
  const violations = []
  const packagedRoots = new Map()
  for (const entry of entries) {
    const segments = entry.split('/').filter(Boolean)
    const basename = segments.at(-1) ?? ''
    const privateSegment = segments.find((segment) => privateSegments.has(segment))
    if (privateSegment) violations.push(`${entry}: private path segment ${privateSegment}`)
    if (!entry.startsWith('/node_modules/')) {
      const projectOnly = segments.find((segment) => projectOnlySegments.has(segment))
      if (projectOnly) violations.push(`${entry}: non-runtime project segment ${projectOnly}`)
    }
    if (sensitiveBasenamePatterns.some((pattern) => pattern.test(basename))) {
      violations.push(`${entry}: sensitive filename`)
    }

    const packaged = topLevelPackage(entry)
    if (packaged) packagedRoots.set(packaged.root, packaged.name)
    const allowed = exactRuntimeFiles.has(entry)
      || runtimeRoots.some((root) => entry === root || entry.startsWith(`${root}/`))
      || Boolean(packaged && productionPackageVersions.has(packaged.name))
      || isStructuralParent(entry)
    if (!allowed) violations.push(`${entry}: outside runtime allowlist`)
  }

  // electron-builder hoists nested production dependencies into the packaged
  // node_modules root. Verify identity and version, not their lockfile location.
  for (const [packageRoot, expectedName] of packagedRoots) {
    const packageJsonPath = `${packageRoot.slice(1)}/package.json`
    try {
      const metadata = JSON.parse(extractFile(asarPath, packageJsonPath).toString('utf8'))
      const allowedVersions = productionPackageVersions.get(expectedName)
      if (metadata.name !== expectedName || !allowedVersions?.has(metadata.version)) {
        violations.push(`${packageRoot}: package identity ${metadata.name}@${metadata.version} is outside production lock graph`)
      }
    } catch (error) {
      violations.push(`${packageRoot}: cannot verify package.json (${error.message})`)
    }
  }
  return violations
}

function assertRequiredEntries(entries, violations) {
  for (const required of [
    '/package.json',
    '/out/main/index.js',
    '/out/preload/index.js',
    '/out/renderer/index.html',
  ]) {
    if (!entries.includes(required)) violations.push(`${required}: required runtime file missing`)
  }
}

const noticeContract = [
  ['LICENSE.txt', path.join(repoRoot, 'LICENSE'), 100],
  ['NOTICE', path.join(repoRoot, 'NOTICE'), 50],
  ['THIRD_PARTY_NOTICES', path.join(repoRoot, 'THIRD_PARTY_NOTICES'), 100],
  ['LICENSE.electron.txt', path.join(repoRoot, 'node_modules/electron/dist/LICENSE'), 100],
  ['LICENSES.chromium.html', path.join(repoRoot, 'node_modules/electron/dist/LICENSES.chromium.html'), 100_000],
]

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function checkOuterNotices(resourcesRoot, violations) {
  for (const [name, source, minimumBytes] of noticeContract) {
    const packaged = path.join(resourcesRoot, name)
    if (!fs.existsSync(packaged)) {
      violations.push(`${name}: outer notice missing`)
      continue
    }
    if (fs.statSync(packaged).size < minimumBytes) violations.push(`${name}: outer notice is unexpectedly small`)
    if (!fs.existsSync(source)) {
      violations.push(`${name}: local notice source missing`)
      continue
    }
    if (sha256(packaged) !== sha256(source)) violations.push(`${name}: outer notice differs from pinned source`)
  }
}

function listOuterPaths(root, current = '', results = []) {
  for (const entry of fs.readdirSync(path.join(root, current), { withFileTypes: true })) {
    const relative = current ? `${current}/${entry.name}` : entry.name
    results.push(relative)
    if (entry.isDirectory()) listOuterPaths(root, relative, results)
  }
  return results
}

function checkOuterPayload(resourcesRoot, asarEntries, violations) {
  const asarPathsAndParents = new Set()
  for (const entry of asarEntries) {
    let current = entry
    while (current && current !== '/') {
      asarPathsAndParents.add(current)
      current = current.slice(0, current.lastIndexOf('/')) || '/'
    }
  }

  const exact = new Set([
    'app.asar',
    'app.asar.unpacked',
    'app-update.yml',
    'icon.icns',
    'LICENSE.txt',
    'NOTICE',
    'THIRD_PARTY_NOTICES',
    'LICENSE.electron.txt',
    'LICENSES.chromium.html',
    'cli',
    'cli/chunks',
    'cli/cli.js',
  ])

  for (const relative of listOuterPaths(resourcesRoot)) {
    if (fs.lstatSync(path.join(resourcesRoot, relative)).isSymbolicLink()) {
      violations.push(`${relative}: symbolic links are forbidden in outer payload`)
    }
    const segments = relative.split('/')
    const basename = segments.at(-1)
    const privateSegment = segments.find((segment) => privateSegments.has(segment))
    if (privateSegment) violations.push(`${relative}: outer payload contains private segment ${privateSegment}`)
    if (sensitiveBasenamePatterns.some((pattern) => pattern.test(basename))) {
      violations.push(`${relative}: outer payload contains sensitive filename`)
    }

    let allowed = exact.has(relative)
      || /^[A-Za-z0-9_-]+\.lproj(?:\/InfoPlist\.strings)?$/.test(relative)
      || /^cli\/chunks\/[^/]+\.js$/.test(relative)

    if (relative.startsWith('app.asar.unpacked/')) {
      const asarEntry = `/${relative.slice('app.asar.unpacked/'.length)}`
      allowed = asarPathsAndParents.has(asarEntry)
    }
    if (!allowed) violations.push(`${relative}: outside outer payload allowlist`)
  }
}

const asars = requestedAsars.length > 0
  ? requestedAsars
  : findFiles(path.join(repoRoot, 'dist'), 'app.asar')

if (asars.length === 0) {
  console.error('No app.asar found. Build a package first or pass --asar <path>.')
  process.exit(1)
}

let failed = false
for (const asarPath of asars.sort()) {
  const entries = listPackage(asarPath).map(normalizedAsarPath).sort()
  const violations = policyViolations(entries, asarPath)
  assertRequiredEntries(entries, violations)
  const resourcesRoot = path.dirname(asarPath)
  checkOuterPayload(resourcesRoot, entries, violations)
  checkOuterNotices(resourcesRoot, violations)

  if (violations.length > 0) {
    failed = true
    console.error(`Package policy rejected ${asarPath}:`)
    for (const violation of [...new Set(violations)].sort()) console.error(`  - ${violation}`)
    continue
  }

  fs.mkdirSync(inventoryRoot, { recursive: true })
  const archiveHash = sha256(asarPath).slice(0, 16)
  const inventory = path.join(inventoryRoot, `app-${archiveHash}.asar.paths.txt`)
  fs.writeFileSync(inventory, `${entries.join('\n')}\n`)
  console.log(`Package policy passed: ${entries.length} app.asar paths; inventory ${inventory}`)
}

if (failed) process.exit(1)
