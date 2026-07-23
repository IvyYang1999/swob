#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseSemver } from './assert-release-version.mjs'

export function expectedPublishedAssets(version) {
  parseSemver(version)
  return [
    `swob-${version}-arm64.dmg`,
    `swob-${version}-arm64.zip`,
    `swob-${version}-arm64.zip.blockmap`,
    `swob-${version}-x64.dmg`,
    `swob-${version}-x64.zip`,
    `swob-${version}-x64.zip.blockmap`
  ].sort()
}

export function expectedBuildAssets(version) {
  return expectedPublishedAssets(version)
}

export function expectedCandidateAssets(version) {
  const installers = expectedPublishedAssets(version)
  return version === '1.3.0'
    ? installers
    : [...installers, 'swob-canary-mac.yml'].sort()
}

export function assertExactNames(actualNames, expectedNames, label) {
  const actual = [...new Set(actualNames)].sort()
  const expected = [...new Set(expectedNames)].sort()
  if (actual.length !== actualNames.length) {
    throw new Error(`${label} contains duplicate asset names`)
  }
  const missing = expected.filter((name) => !actual.includes(name))
  const unexpected = actual.filter((name) => !expected.includes(name))
  if (missing.length || unexpected.length) {
    throw new Error(`${label} mismatch; missing=[${missing.join(', ')}], unexpected=[${unexpected.join(', ')}]`)
  }
  if (actual.some((name) => name === 'latest-mac.yml')) {
    throw new Error(`${label} must never contain retired latest-mac.yml`)
  }
  return actual
}

export function assertBuildAssets({ releaseDir, version, channel }) {
  const releaseLike = fs.readdirSync(releaseDir).filter((name) =>
    name.endsWith('.dmg') || name.endsWith('.zip') || name.endsWith('.blockmap') || name.endsWith('-mac.yml')
  )
  assertExactNames(releaseLike, expectedBuildAssets(version), 'Local release asset inventory')
}

function sha256Hex(fileName) {
  const hash = crypto.createHash('sha256')
  hash.update(fs.readFileSync(fileName))
  return hash.digest('hex')
}

export function assertRemoteAssets({ inventory, releaseDir, version, channel, promoted }) {
  if (!inventory || !Array.isArray(inventory.assets)) {
    throw new Error('Remote release inventory must contain an assets array')
  }
  if (promoted && version === '1.3.0') {
    throw new Error('v1.3.0 is the manual trust-root release and must never contain update metadata')
  }
  const expectedNames = promoted
    ? [...expectedPublishedAssets(version), `${channel}-mac.yml`]
    : expectedCandidateAssets(version)
  assertExactNames(inventory.assets.map((asset) => asset.name), expectedNames, 'Published release asset inventory')

  for (const asset of inventory.assets) {
    const localFile = path.join(releaseDir, asset.name)
    if (!fs.statSync(localFile, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Missing local source for published asset: ${asset.name}`)
    }
    if (asset.state !== 'uploaded') {
      throw new Error(`Published asset is not fully uploaded: ${asset.name}`)
    }
    const localSize = fs.statSync(localFile).size
    if (asset.size !== localSize) {
      throw new Error(`Published asset size mismatch: ${asset.name}`)
    }
    const expectedDigest = `sha256:${sha256Hex(localFile)}`
    if (asset.digest !== expectedDigest) {
      throw new Error(`Published asset digest mismatch: ${asset.name}`)
    }
  }
}

function readOption(name, fallback = null) {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : process.argv[index + 1]
}

async function main() {
  const version = readOption('--version')
  const channel = readOption('--channel', 'swob-signed')
  const namesFile = readOption('--names-file')
  const inventoryJson = readOption('--inventory-json')
  const promoted = process.argv.includes('--promoted')

  if (inventoryJson) {
    const inventory = JSON.parse(fs.readFileSync(path.resolve(inventoryJson), 'utf8'))
    assertRemoteAssets({
      inventory,
      releaseDir: path.resolve(readOption('--dir', 'dist')),
      version,
      channel,
      promoted
    })
    process.stdout.write(`Published asset name, size and digest gate passed: ${inventory.assets.length} assets\n`)
    return
  }

  if (namesFile) {
    const names = fs.readFileSync(path.resolve(namesFile), 'utf8').split(/\r?\n/).filter(Boolean)
    if (promoted && version === '1.3.0') {
      throw new Error('v1.3.0 is the manual trust-root release and must never contain update metadata')
    }
    const expected = promoted
      ? [...expectedPublishedAssets(version), `${channel}-mac.yml`]
      : expectedCandidateAssets(version)
    assertExactNames(names, expected, 'Published release asset inventory')
    process.stdout.write(`Published asset gate passed: ${names.length} immutable assets\n`)
    return
  }

  const releaseDir = path.resolve(readOption('--dir', 'dist'))
  assertBuildAssets({ releaseDir, version, channel })
  process.stdout.write(`Local asset gate passed for ${version}: exactly six immutable assets and no update metadata\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
