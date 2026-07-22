import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertReleaseVersion, assertUpgradePath, compareSemver } from './assert-release-version.mjs'
import { assertBuildAssets, assertExactNames, assertRemoteAssets, expectedPublishedAssets } from './assert-release-assets.mjs'
import { buildUpdateMetadata, writeUpdateMetadata } from './generate-update-metadata.mjs'

const temporaryDirectories = []

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-release-gates-'))
  temporaryDirectories.push(directory)
  return directory
}

function writeJson(fileName, value) {
  fs.writeFileSync(fileName, `${JSON.stringify(value, null, 2)}\n`)
}

function createVersionFixture(version = '1.3.0') {
  const rootDir = temporaryDirectory()
  writeJson(path.join(rootDir, 'package.json'), { name: 'swob', version })
  writeJson(path.join(rootDir, 'package-lock.json'), {
    name: 'swob',
    version,
    lockfileVersion: 3,
    packages: { '': { name: 'swob', version } }
  })
  return rootDir
}

function createReleaseFixture(version = '1.3.1', channel = 'swob-signed') {
  const releaseDir = temporaryDirectory()
  for (const arch of ['arm64', 'x64']) {
    fs.writeFileSync(path.join(releaseDir, `swob-${version}-${arch}.zip`), `zip-${arch}`)
    fs.writeFileSync(path.join(releaseDir, `swob-${version}-${arch}.dmg`), `dmg-${arch}`)
    fs.writeFileSync(path.join(releaseDir, `swob-${version}-${arch}.zip.blockmap`), `blockmap-${arch}`)
  }
  writeUpdateMetadata({ releaseDir, version, channel, releaseDate: '2026-07-22T00:00:00.000Z' })
  return releaseDir
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('release version gate', () => {
  it('requires tag, package and both lockfile versions to match', () => {
    const rootDir = createVersionFixture()
    expect(assertReleaseVersion({ rootDir, tag: 'v1.3.0', minimumVersion: '1.3.0' }).tag).toBe('1.3.0')

    const lock = JSON.parse(fs.readFileSync(path.join(rootDir, 'package-lock.json'), 'utf8'))
    lock.packages[''].version = '1.2.0'
    writeJson(path.join(rootDir, 'package-lock.json'), lock)

    expect(() => assertReleaseVersion({ rootDir, tag: 'v1.3.0' })).toThrow(/lockRoot=1\.2\.0/)
  })

  it('rejects tags below the signed trust-root minimum', () => {
    const rootDir = createVersionFixture('1.2.1')
    expect(() => assertReleaseVersion({ rootDir, tag: 'v1.2.1', minimumVersion: '1.3.0' }))
      .toThrow(/below signed trust-root minimum/)
    expect(compareSemver('1.3.0', '1.3.0-rc.1')).toBeGreaterThan(0)
    expect(compareSemver('1.3.0-rc.2', '1.3.0-rc.10')).toBeLessThan(0)
    expect(compareSemver('1.3.0-alpha', '1.3.0-alpha.1')).toBeLessThan(0)
  })

  it('rejects malformed prerelease identifiers', () => {
    const rootDir = createVersionFixture('1.3.0-alpha..1')
    expect(() => assertReleaseVersion({ rootDir, tag: 'v1.3.0-alpha..1' }))
      .toThrow(/Invalid semantic version/)
  })

  it('requires a real version increase for update E2E', () => {
    expect(() => assertUpgradePath('1.3.0', '1.3.1')).not.toThrow()
    expect(() => assertUpgradePath('1.3.1', '1.3.1')).toThrow(/must be newer/)
    expect(() => assertUpgradePath('1.3.2', '1.3.1')).toThrow(/must be newer/)
  })

  it('rejects prerelease and build metadata on a public stable release', () => {
    for (const version of ['1.3.1-rc.1', '1.3.1+build.7']) {
      const rootDir = createVersionFixture(version)
      expect(() => assertReleaseVersion({ rootDir, tag: `v${version}`, requireStable: true }))
        .toThrow(/must be stable X\.Y\.Z/)
    }
  })
})

describe('promotion metadata', () => {
  it('hashes both architecture ZIPs and never emits the retired latest channel', () => {
    const releaseDir = temporaryDirectory()
    fs.writeFileSync(path.join(releaseDir, 'swob-1.3.1-arm64.zip'), 'arm64 payload')
    fs.writeFileSync(path.join(releaseDir, 'swob-1.3.1-x64.zip'), 'x64 payload')

    const metadata = buildUpdateMetadata({
      releaseDir,
      version: '1.3.1',
      channel: 'swob-canary',
      releaseDate: '2026-07-22T00:00:00.000Z'
    })

    const expectedArmHash = crypto.createHash('sha512').update('arm64 payload').digest('base64')
    expect(metadata.fileName).toBe('swob-canary-mac.yml')
    expect(metadata.content).toContain(`sha512: ${expectedArmHash}`)
    expect(metadata.content).toContain('swob-1.3.1-x64.zip')
    expect(metadata.content).not.toContain('latest-mac.yml')
  })
})

describe('release asset gate', () => {
  it('accepts only the two DMGs, ZIPs, blockmaps and local promotion metadata', () => {
    const releaseDir = createReleaseFixture()
    expect(() => assertBuildAssets({ releaseDir, version: '1.3.1', channel: 'swob-signed' })).not.toThrow()

    fs.writeFileSync(path.join(releaseDir, 'latest-mac.yml'), 'forbidden')
    expect(() => assertBuildAssets({ releaseDir, version: '1.3.1', channel: 'swob-signed' }))
      .toThrow(/latest-mac\.yml/)
  })

  it('fails closed when a published asset is missing or metadata leaks into the release', () => {
    const expected = expectedPublishedAssets('1.3.1')
    expect(() => assertExactNames(expected.slice(1), expected, 'remote')).toThrow(/missing=/)
    expect(() => assertExactNames([...expected, 'swob-signed-mac.yml'], expected, 'remote'))
      .toThrow(/unexpected=/)
    expect(() => assertExactNames(
      [...expected, 'swob-signed-mac.yml'],
      [...expected, 'swob-signed-mac.yml'],
      'promoted remote'
    )).not.toThrow()
  })

  it('binds every published asset to the locally verified size and sha256 digest', () => {
    const releaseDir = createReleaseFixture()
    const names = expectedPublishedAssets('1.3.1')
    const inventory = {
      assets: names.map((name) => {
        const contents = fs.readFileSync(path.join(releaseDir, name))
        return {
          name,
          state: 'uploaded',
          size: contents.length,
          digest: `sha256:${crypto.createHash('sha256').update(contents).digest('hex')}`
        }
      })
    }

    expect(() => assertRemoteAssets({
      inventory,
      releaseDir,
      version: '1.3.1',
      channel: 'swob-signed',
      promoted: false
    })).not.toThrow()

    inventory.assets[0].digest = 'sha256:deadbeef'
    expect(() => assertRemoteAssets({
      inventory,
      releaseDir,
      version: '1.3.1',
      channel: 'swob-signed',
      promoted: false
    })).toThrow(/digest mismatch/)
  })
})
