#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/

function validateIdentifiers(value, label, rejectNumericLeadingZero) {
  if (value == null) return
  for (const identifier of value.split('.')) {
    if (!identifier || !/^[0-9A-Za-z-]+$/.test(identifier)) {
      throw new Error(`Invalid semantic version ${label}: ${value}`)
    }
    if (rejectNumericLeadingZero && /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith('0')) {
      throw new Error(`Invalid semantic version ${label}: ${value}`)
    }
  }
}

export function parseSemver(value) {
  const match = SEMVER_PATTERN.exec(value)
  if (!match) throw new Error(`Invalid semantic version: ${value}`)
  validateIdentifiers(match[4], 'prerelease', true)
  validateIdentifiers(match[5], 'build metadata', false)
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null
  }
}

function comparePrereleaseIdentifiers(left, right) {
  const leftIsNumber = /^\d+$/.test(left)
  const rightIsNumber = /^\d+$/.test(right)
  if (leftIsNumber && rightIsNumber) {
    if (left.length !== right.length) return left.length < right.length ? -1 : 1
    return left === right ? 0 : left < right ? -1 : 1
  }
  if (leftIsNumber !== rightIsNumber) return leftIsNumber ? -1 : 1
  return left === right ? 0 : left < right ? -1 : 1
}

export function compareSemver(left, right) {
  const a = parseSemver(left)
  const b = parseSemver(right)
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  if (a.prerelease === b.prerelease) return 0
  if (a.prerelease === null) return 1
  if (b.prerelease === null) return -1
  const leftIdentifiers = a.prerelease.split('.')
  const rightIdentifiers = b.prerelease.split('.')
  for (let index = 0; index < Math.max(leftIdentifiers.length, rightIdentifiers.length); index += 1) {
    if (leftIdentifiers[index] == null) return -1
    if (rightIdentifiers[index] == null) return 1
    const comparison = comparePrereleaseIdentifiers(leftIdentifiers[index], rightIdentifiers[index])
    if (comparison !== 0) return comparison
  }
  return 0
}

export function assertUpgradePath(fromVersion, toVersion) {
  parseSemver(fromVersion)
  parseSemver(toVersion)
  if (compareSemver(fromVersion, toVersion) >= 0) {
    throw new Error(`Update target must be newer than the installed version: ${fromVersion} -> ${toVersion}`)
  }
}

export function assertReleaseVersion({ rootDir, tag, minimumVersion = null, requireStable = false }) {
  if (!tag?.startsWith('v')) throw new Error(`Release tag must start with v: ${tag || '<empty>'}`)
  const tagVersion = tag.slice(1)
  parseSemver(tagVersion)
  if (requireStable && !/^\d+\.\d+\.\d+$/.test(tagVersion)) {
    throw new Error(`Public release version must be stable X.Y.Z: ${tagVersion}`)
  }

  const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'))
  const packageLock = JSON.parse(fs.readFileSync(path.join(rootDir, 'package-lock.json'), 'utf8'))
  const versions = {
    tag: tagVersion,
    package: packageJson.version,
    lock: packageLock.version,
    lockRoot: packageLock.packages?.['']?.version
  }

  for (const [source, version] of Object.entries(versions)) {
    if (typeof version !== 'string') throw new Error(`Missing version in ${source}`)
    parseSemver(version)
  }

  const mismatches = Object.entries(versions).filter(([, version]) => version !== tagVersion)
  if (mismatches.length > 0) {
    const detail = Object.entries(versions).map(([source, version]) => `${source}=${version}`).join(', ')
    throw new Error(`Release version mismatch: ${detail}`)
  }

  if (minimumVersion && compareSemver(tagVersion, minimumVersion) < 0) {
    throw new Error(`Release ${tagVersion} is below signed trust-root minimum ${minimumVersion}`)
  }

  return versions
}

function readOption(name, fallback = null) {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : process.argv[index + 1]
}

async function main() {
  const fromVersion = readOption('--from')
  const toVersion = readOption('--to')
  if (fromVersion || toVersion) {
    if (!fromVersion || !toVersion) throw new Error('Both --from and --to are required for an update-path check')
    assertUpgradePath(fromVersion, toVersion)
    process.stdout.write(`Update path gate passed: ${fromVersion} -> ${toVersion}\n`)
    return
  }

  const rootDir = path.resolve(readOption('--root', process.cwd()))
  const tag = readOption('--tag', process.env.GITHUB_REF_NAME)
  const minimumVersion = readOption('--minimum')
  const versions = assertReleaseVersion({
    rootDir,
    tag,
    minimumVersion,
    requireStable: process.argv.includes('--stable')
  })
  process.stdout.write(`Release version gate passed: v${versions.tag}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
