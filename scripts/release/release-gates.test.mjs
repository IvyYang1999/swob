import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { assertReleaseRef, assertReleaseVersion, assertUpgradePath, compareSemver } from './assert-release-version.mjs'
import { assertBuildAssets, assertExactNames, assertRemoteAssets, expectedPublishedAssets } from './assert-release-assets.mjs'
import { buildUpdateMetadata } from './generate-update-metadata.mjs'

const temporaryDirectories = []
const releaseScriptsDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(releaseScriptsDirectory, '../..')

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

function createReleaseFixture(version = '1.3.1') {
  const releaseDir = temporaryDirectory()
  for (const arch of ['arm64', 'x64']) {
    fs.writeFileSync(path.join(releaseDir, `swob-${version}-${arch}.zip`), `zip-${arch}`)
    fs.writeFileSync(path.join(releaseDir, `swob-${version}-${arch}.dmg`), `dmg-${arch}`)
    fs.writeFileSync(path.join(releaseDir, `swob-${version}-${arch}.zip.blockmap`), `blockmap-${arch}`)
  }
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

  it('binds the checked-out release commit to the current remote master tip', () => {
    expect(() => assertReleaseRef({
      rootDir: repositoryRoot,
      tag: 'HEAD',
      remoteBranch: 'HEAD'
    })).not.toThrow()
    expect(() => assertReleaseRef({
      rootDir: repositoryRoot,
      tag: 'HEAD',
      remoteBranch: 'HEAD^'
    })).toThrow(/not the current .* tip/)
    expect(() => assertReleaseRef({
      rootDir: repositoryRoot,
      tag: 'HEAD^',
      remoteBranch: 'HEAD'
    })).toThrow(/HEAD is not the release tag commit/)
  })

  it('rejects a stale release commit even when it is an ancestor of remote master', () => {
    const rootDir = temporaryDirectory()
    const isolatedEnvironment = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))
    )
    const runGit = (...args) => {
      const result = spawnSync('git', args, {
        cwd: rootDir,
        encoding: 'utf8',
        env: isolatedEnvironment
      })
      if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
      }
      return result.stdout.trim()
    }

    runGit('init', '--quiet')
    const emptyHooks = path.join(rootDir, 'empty-hooks')
    fs.mkdirSync(emptyHooks)
    runGit('config', 'core.hooksPath', emptyHooks)
    runGit('config', 'user.name', 'Release Gate Test')
    runGit('config', 'user.email', 'release-gate@example.invalid')
    fs.writeFileSync(path.join(rootDir, 'release.txt'), 'stale\n')
    runGit('add', 'release.txt')
    runGit('commit', '--quiet', '-m', 'stale release candidate')
    const staleCommit = runGit('rev-parse', 'HEAD')

    fs.writeFileSync(path.join(rootDir, 'release.txt'), 'current\n')
    runGit('commit', '--quiet', '-am', 'current master tip')
    const currentTip = runGit('rev-parse', 'HEAD')
    runGit('update-ref', 'refs/remotes/origin/master', currentTip)
    runGit('checkout', '--quiet', '--detach', staleCommit)

    expect(() => assertReleaseRef({
      rootDir,
      tag: 'HEAD',
      remoteBranch: 'origin/master'
    })).toThrow(/not the current .* tip/)
  })
})

describe('notarization credential preflight', () => {
  it('rejects invisible CR/LF characters before calling Apple', () => {
    const result = spawnSync('bash', [
      path.join(releaseScriptsDirectory, 'preflight-notarization.sh')
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        APPLE_ID: 'release@example.com',
        APPLE_APP_SPECIFIC_PASSWORD: 'abcd-efgh-ijkl-mnop\n',
        APPLE_TEAM_ID: 'ZPTA4LP594'
      }
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('contains a CR/LF character: APPLE_APP_SPECIFIC_PASSWORD')
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
  it('accepts exactly two DMGs, ZIPs and ZIP blockmaps with no metadata', () => {
    const releaseDir = createReleaseFixture()
    expect(() => assertBuildAssets({ releaseDir, version: '1.3.1', channel: 'swob-signed' })).not.toThrow()

    fs.writeFileSync(path.join(releaseDir, 'latest-mac.yml'), 'forbidden')
    expect(() => assertBuildAssets({ releaseDir, version: '1.3.1', channel: 'swob-signed' }))
      .toThrow(/latest-mac\.yml/)

    fs.rmSync(path.join(releaseDir, 'latest-mac.yml'))
    fs.writeFileSync(path.join(releaseDir, 'swob-1.3.1-arm64.dmg.blockmap'), 'forbidden')
    expect(() => assertBuildAssets({ releaseDir, version: '1.3.1', channel: 'swob-signed' }))
      .toThrow(/dmg\.blockmap/)
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
    expect(() => assertExactNames([...expected, expected[0]], expected, 'remote'))
      .toThrow(/duplicate asset names/)
  })

  it('forbids all update metadata on the v1.3.0 manual trust-root release', () => {
    const releaseDir = createReleaseFixture('1.3.0')
    const inventory = {
      assets: [
        ...expectedPublishedAssets('1.3.0').map((name) => ({
          name,
          state: 'uploaded',
          size: fs.statSync(path.join(releaseDir, name)).size,
          digest: `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(releaseDir, name))).digest('hex')}`
        })),
        { name: 'swob-signed-mac.yml', state: 'uploaded', size: 0, digest: 'sha256:0' }
      ]
    }
    expect(() => assertRemoteAssets({
      inventory,
      releaseDir,
      version: '1.3.0',
      channel: 'swob-signed',
      promoted: true
    })).toThrow(/must never contain update metadata/)
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

describe('shared macOS artifact verifier contract', () => {
  it('routes release and signing smoke through the same comprehensive verifier', () => {
    const releaseWorkflow = fs.readFileSync(path.join(repositoryRoot, '.github/workflows/release.yml'), 'utf8')
    const smokeWorkflow = fs.readFileSync(path.join(repositoryRoot, '.github/workflows/signing-smoke.yml'), 'utf8')
    const dryRunWorkflow = fs.readFileSync(path.join(repositoryRoot, '.github/workflows/release-gates-dry-run.yml'), 'utf8')
    const qualityWorkflow = fs.readFileSync(path.join(repositoryRoot, '.github/workflows/quality.yml'), 'utf8')
    const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'))
    const artifactVerifier = fs.readFileSync(path.join(releaseScriptsDirectory, 'verify-macos-artifacts.sh'), 'utf8')
    const appVerifier = fs.readFileSync(path.join(releaseScriptsDirectory, 'verify-signed-app.sh'), 'utf8')
    const builderConfig = fs.readFileSync(path.join(repositoryRoot, 'electron-builder.yml'), 'utf8')

    expect(packageJson.scripts.test).toContain('npm run check')
    for (const workflow of [qualityWorkflow, dryRunWorkflow, releaseWorkflow]) {
      expect(workflow).toContain('npm test')
    }
    expect(smokeWorkflow).toContain('npm run check')
    expect(releaseWorkflow).toContain('scripts/release/verify-macos-artifacts.sh')
    expect(releaseWorkflow).toContain('--bind-ref origin/master')
    expect(smokeWorkflow).toContain('scripts/release/verify-macos-artifacts.sh')
    expect(smokeWorkflow).not.toContain('codesign --verify')
    for (const workflow of [releaseWorkflow, smokeWorkflow]) {
      expect(workflow).toContain('xcrun notarytool submit "$dmg_file"')
      expect(workflow).toContain('xcrun stapler staple "$dmg_file"')
    }
    expect(artifactVerifier).toContain('ditto -x -k')
    expect(artifactVerifier).toContain('hdiutil attach -readonly -nobrowse')
    expect(artifactVerifier).toContain('xcrun stapler validate "$dmg_file"')
    expect(artifactVerifier).not.toContain('spctl --assess --type open')
    expect(artifactVerifier).toContain('verify_app "$zip_app"')
    expect(artifactVerifier).toContain('verify_app "$dmg_app"')
    expect(appVerifier).toContain('scripts/check-package.mjs')
    expect(builderConfig).toMatch(/dmg:\s+[\s\S]*writeUpdateInfo: false/)
  })

  if (process.platform === 'darwin') {
    it('uses real codesign to reject an unsigned application fixture without credentials', () => {
      const fixtureRoot = temporaryDirectory()
      const appBundle = path.join(fixtureRoot, 'Swob.app')
      const executable = path.join(appBundle, 'Contents/MacOS/Swob')
      fs.mkdirSync(path.dirname(executable), { recursive: true })
      fs.mkdirSync(path.join(appBundle, 'Contents/Resources'), { recursive: true })
      fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n')
      fs.chmodSync(executable, 0o755)
      fs.writeFileSync(path.join(appBundle, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Swob</string>
<key>CFBundleIdentifier</key><string>com.swob.app</string>
<key>CFBundleShortVersionString</key><string>1.3.0</string>
</dict></plist>
`)

      const result = spawnSync('bash', [
        path.join(releaseScriptsDirectory, 'verify-signed-app.sh'),
        appBundle,
        '1.3.0',
        'swob-signed',
        'ZPTA4LP594',
        'arm64'
      ], { encoding: 'utf8' })

      expect(result.status).not.toBe(0)
      expect(`${result.stdout}\n${result.stderr}`).toMatch(/not signed|code object is not signed|invalid signature/i)
    })
  }
})
