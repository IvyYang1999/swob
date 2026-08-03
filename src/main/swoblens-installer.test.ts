import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  installSwobLensPackage,
  listInstalledSwobLensPackages,
  previewSwobLensPackage,
  recoverSwobLensTransactions,
  setSwobLensPackageEnabled,
  uninstallSwobLensPackage
} from './swoblens-installer'

const examples = path.join(process.cwd(), 'docs', 'swoblens', 'examples')
const malicious = path.join(process.cwd(), 'testdata', 'swoblens', 'malicious')

describe('.swoblens installer', () => {
  let temporary: string
  let libraryRoot: string

  beforeEach(async () => {
    temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'swoblens-test-'))
    libraryRoot = path.join(temporary, 'Library')
    await fs.promises.mkdir(libraryRoot)
  })

  afterEach(async () => {
    await fs.promises.rm(temporary, { recursive: true, force: true })
  })

  it('previews all three official zero-code package types with fixed digests', async () => {
    const expected = new Map(
      (await fs.promises.readFile(path.join(examples, 'SHA256SUMS'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => line.split(/\s{2}/) as [string, string])
        .map(([digest, name]) => [name, digest])
    )
    const cases = [
      ['aurora-calm.swoblens', 'theme'],
      ['research-kit.swoblens', 'lens-preset'],
      ['field-notes-card.swoblens', 'share-template']
    ] as const
    for (const [name, type] of cases) {
      const preview = await previewSwobLensPackage(path.join(examples, name), '1.4.0')
      expect(preview.manifest.type).toBe(type)
      expect(preview.digest).toBe(expected.get(name))
      expect(preview.uncompressedBytes).toBeGreaterThan(0)
    }
  })

  it('installs, lists, disables, enables, and uninstalls through atomic package directories', async () => {
    for (const name of ['aurora-calm.swoblens', 'research-kit.swoblens', 'field-notes-card.swoblens']) {
      const sourcePath = path.join(examples, name)
      const preview = await previewSwobLensPackage(sourcePath, '1.4.0')
      const installed = await installSwobLensPackage(sourcePath, preview.digest, libraryRoot, '1.4.0')
      expect(installed.enabled).toBe(true)
    }
    expect((await listInstalledSwobLensPackages(libraryRoot)).packages).toHaveLength(3)

    const disabled = await setSwobLensPackageEnabled(libraryRoot, 'swob.research-kit', false)
    expect(disabled.enabled).toBe(false)
    const enabled = await setSwobLensPackageEnabled(libraryRoot, 'swob.research-kit', true)
    expect(enabled.enabled).toBe(true)

    await uninstallSwobLensPackage(libraryRoot, 'swob.research-kit')
    const listed = await listInstalledSwobLensPackages(libraryRoot)
    expect(listed.packages.map((item) => item.manifest.id)).toEqual([
      'swob.aurora-calm',
      'swob.field-notes-card'
    ])
    expect(listed.errors).toEqual([])
  })

  it('revalidates the digest at install time to close preview/install replacement races', async () => {
    const sourcePath = path.join(temporary, 'selected.swoblens')
    await fs.promises.copyFile(path.join(examples, 'aurora-calm.swoblens'), sourcePath)
    const preview = await previewSwobLensPackage(sourcePath, '1.4.0')
    await fs.promises.copyFile(path.join(examples, 'research-kit.swoblens'), sourcePath)
    await expect(installSwobLensPackage(sourcePath, preview.digest, libraryRoot, '1.4.0'))
      .rejects.toMatchObject({ code: 'PACKAGE_CHANGED' })
    expect((await listInstalledSwobLensPackages(libraryRoot)).packages).toEqual([])
  })

  it('rejects same-version conflicts, downgrade attempts, and unmet app versions without replacing the installed package', async () => {
    const sourcePath = path.join(examples, 'aurora-calm.swoblens')
    const preview = await previewSwobLensPackage(sourcePath, '1.4.0')
    await installSwobLensPackage(sourcePath, preview.digest, libraryRoot, '1.4.0')
    await expect(installSwobLensPackage(sourcePath, preview.digest, libraryRoot, '1.4.0'))
      .rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
    await expect(previewSwobLensPackage(sourcePath, '1.3.0'))
      .rejects.toMatchObject({ code: 'APP_VERSION_TOO_OLD' })
    expect((await listInstalledSwobLensPackages(libraryRoot)).packages[0].digest).toBe(preview.digest)
  })

  it.each([
    ['path-traversal.swoblens', 'INVALID_PATH'],
    ['javascript-entry.swoblens', 'EXECUTABLE_NOT_ALLOWED'],
    ['bad-schema.swoblens', 'UNKNOWN_FIELD'],
    ['compression-bomb.swoblens', 'COMPRESSION_BOMB'],
    ['symlink-entry.swoblens', 'LINK_ENTRY'],
    ['unix-link-metadata.swoblens', 'LINK_ENTRY'],
    ['css-network.swoblens', 'TOKEN_VALUE_NOT_ALLOWED'],
    ['malformed-central-directory.swoblens', 'MALFORMED_CENTRAL_DIRECTORY']
  ])('fails closed for malicious fixture %s', async (name, code) => {
    await expect(previewSwobLensPackage(path.join(malicious, name), '1.4.0'))
      .rejects.toMatchObject({ code })
  })

  it('does not follow a symlink chosen as the package source', async () => {
    const link = path.join(temporary, 'linked.swoblens')
    await fs.promises.symlink(path.join(examples, 'aurora-calm.swoblens'), link)
    await expect(previewSwobLensPackage(link, '1.4.0')).rejects.toMatchObject({ code: 'LINK_SOURCE' })
  })

  it('fails closed when an installed declaration is modified after installation', async () => {
    const sourcePath = path.join(examples, 'aurora-calm.swoblens')
    const preview = await previewSwobLensPackage(sourcePath, '1.4.0')
    await installSwobLensPackage(sourcePath, preview.digest, libraryRoot, '1.4.0')
    await fs.promises.writeFile(path.join(libraryRoot, '.swob', 'packages', 'swob.aurora-calm', 'theme.json'), '{}')
    const listed = await listInstalledSwobLensPackages(libraryRoot)
    expect(listed.packages).toEqual([])
    expect(listed.errors).toMatchObject([{ id: 'swob.aurora-calm', code: 'FILE_DIGEST_MISMATCH' }])
  })

  it('rolls interrupted install and uninstall renames back to the last complete package', async () => {
    const sourcePath = path.join(examples, 'aurora-calm.swoblens')
    const preview = await previewSwobLensPackage(sourcePath, '1.4.0')
    await installSwobLensPackage(sourcePath, preview.digest, libraryRoot, '1.4.0')
    const root = path.join(libraryRoot, '.swob', 'packages')
    const destination = path.join(root, 'swob.aurora-calm')
    const backup = path.join(root, '.backup-swob.aurora-calm-interrupted')
    const staging = path.join(root, '.install-swob.aurora-calm-interrupted')
    await fs.promises.rename(destination, backup)
    await fs.promises.mkdir(staging)
    await fs.promises.writeFile(path.join(staging, 'partial'), 'partial')

    await recoverSwobLensTransactions(libraryRoot)
    expect(fs.existsSync(destination)).toBe(true)
    expect(fs.existsSync(backup)).toBe(false)
    expect(fs.existsSync(staging)).toBe(false)

    const tombstone = path.join(root, '.remove-swob.aurora-calm-interrupted')
    await fs.promises.rename(destination, tombstone)
    await recoverSwobLensTransactions(libraryRoot)
    expect(fs.existsSync(destination)).toBe(true)
    expect(fs.existsSync(tombstone)).toBe(false)
    expect((await listInstalledSwobLensPackages(libraryRoot)).packages).toHaveLength(1)
  })
})
