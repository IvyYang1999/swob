import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  buildDuplicateRecoveryReport,
  renderDuplicateRecoveryMarkdown,
  verifyDuplicateRecoveryPlan,
  type DuplicateRecoveryReport
} from './duplicate-recovery-planner'
import type { LogicalSessionIdentity } from './library-session-identity'

let workRoot: string
let libraryRoot: string
let quarantineRoot: string
let sourcePath: string

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function identity(sessionId: string): LogicalSessionIdentity {
  return {
    schemaVersion: 1,
    sourceFamily: 'claude-code',
    sourceInstance: { kind: 'default', id: 'default' },
    sessionId
  }
}

function stableUuid(label: string): string {
  const digest = hash(label)
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`
}

function createPackage(
  name: string,
  sessionId: string,
  packageId: string,
  files: Record<string, string>,
  manifestPatch: Record<string, unknown> = {}
): string {
  const dirPath = path.join(libraryRoot, name)
  fs.mkdirSync(dirPath, { recursive: true })
  const manifest = {
    schemaVersion: 3,
    packageId: stableUuid(packageId),
    logicalIdentity: identity(sessionId),
    sessionId,
    sourceFilePaths: [sourcePath],
    customTitle: '绝不能出现在报告里的标题',
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-21T00:00:00.000Z',
    projectPath: '/secret/project/path',
    ...manifestPatch
  }
  fs.writeFileSync(path.join(dirPath, '.swob-session.json'), JSON.stringify(manifest, null, 2))
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(dirPath, relativePath)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, content)
  }
  return dirPath
}

function snapshotTree(root: string): string {
  const values: Array<Record<string, unknown>> = []
  function walk(dirPath: string): void {
    for (const name of fs.readdirSync(dirPath).sort()) {
      const filePath = path.join(dirPath, name)
      const relativePath = path.relative(root, filePath).split(path.sep).join('/')
      const stat = fs.lstatSync(filePath)
      if (stat.isSymbolicLink()) {
        values.push({ relativePath, kind: 'symlink', target: fs.readlinkSync(filePath), mtimeMs: stat.mtimeMs })
      } else if (stat.isDirectory()) {
        values.push({ relativePath, kind: 'directory', mtimeMs: stat.mtimeMs })
        walk(filePath)
      } else {
        values.push({
          relativePath,
          kind: 'file',
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          sha256: hash(fs.readFileSync(filePath, 'utf-8'))
        })
      }
    }
  }
  walk(root)
  return JSON.stringify(values)
}

function conflict(report: DuplicateRecoveryReport, classification: string) {
  return report.conflicts.find((item) => item.classification === classification)
}

beforeEach(() => {
  workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-recovery-planner-'))
  libraryRoot = path.join(workRoot, 'Synthetic Library')
  quarantineRoot = path.join(workRoot, 'External Quarantine')
  sourcePath = path.join(workRoot, 'sources', 'canonical.jsonl')
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true })
  fs.mkdirSync(libraryRoot, { recursive: true })
  fs.writeFileSync(sourcePath, 'canonical-source-body\n')

  const canonicalBackup = fs.readFileSync(sourcePath, 'utf-8')
  createPackage('canonical-A-SECRET-TITLE', 'canonical-session', 'pkg-canonical-a', {
    'backup.jsonl': canonicalBackup,
    'transcript.md': '# PRIVATE TRANSCRIPT BODY\n'
  }, { backupSha256: hash(canonicalBackup), backupSize: Buffer.byteLength(canonicalBackup) })
  createPackage('canonical-B-SECRET-TITLE', 'canonical-session', 'pkg-canonical-b', {
    'backup.jsonl': canonicalBackup,
    'transcript.md': '# PRIVATE TRANSCRIPT BODY\n'
  }, { backupSha256: hash(canonicalBackup), backupSize: Buffer.byteLength(canonicalBackup) })

  const missingSource = path.join(workRoot, 'sources', 'missing.jsonl')
  for (const suffix of ['a', 'b']) {
    createPackage(`missing-${suffix}`, 'missing-session', `pkg-missing-${suffix}`, {
      'backup.jsonl': 'only-backup-survives\n',
      'transcript.md': '# missing source transcript\n'
    }, { sourceFilePaths: [missingSource] })
  }

  createPackage('merge-A', 'merge-session', 'pkg-merge-a', {
    'backup.jsonl': 'shared\nleft-only\n',
    'transcript.md': '# merge transcript\n',
    'transcript-intra-0.md': '# UNIQUE BRANCH BODY\n'
  }, {
    notes: 'PRIVATE NOTE LEFT',
    highlights: [{ id: 'h-left', text: 'PRIVATE HIGHLIGHT LEFT' }]
  })
  createPackage('merge-B', 'merge-session', 'pkg-merge-b', {
    'backup.jsonl': 'shared\nright-only\n',
    'transcript.md': '# merge transcript\n',
    'attachments/private-name.bin': 'ATTACHMENT_SECRET_BYTES'
  }, {
    notes: 'PRIVATE NOTE RIGHT',
    highlights: [{ id: 'h-right', text: 'PRIVATE HIGHLIGHT RIGHT' }]
  })

  for (const suffix of ['a', 'b']) {
    createPackage(`legacy-${suffix}`, 'legacy-session', `legacy-package-${suffix}`, {
      'backup.jsonl': canonicalBackup,
      'transcript.md': '# legacy transcript\n'
    }, {
      schemaVersion: 2,
      packageId: undefined,
      customTitle: 'LEGACY PRIVATE TITLE'
    })
  }

  createPackage('package-id-collision-A', 'collision-session-a', 'shared-collision-package-id', {
    'backup.jsonl': canonicalBackup
  })
  createPackage('package-id-collision-B', 'collision-session-b', 'shared-collision-package-id', {
    'backup.jsonl': canonicalBackup
  })

  const corruptDir = path.join(libraryRoot, 'corrupt-marker')
  fs.mkdirSync(corruptDir)
  fs.writeFileSync(path.join(corruptDir, '.swob-session.json'), '{not-json')
  fs.writeFileSync(path.join(corruptDir, 'backup.jsonl'), 'corrupt package backup remains')

  const cloudDir = path.join(libraryRoot, 'cloud-placeholder')
  fs.mkdirSync(cloudDir)
  fs.writeFileSync(path.join(cloudDir, '..swob-session.json.icloud'), '')

  const externalPackage = path.join(workRoot, 'external-package')
  fs.mkdirSync(externalPackage)
  fs.writeFileSync(path.join(externalPackage, '.swob-session.json'), JSON.stringify({
    schemaVersion: 3,
    packageId: stableUuid('pkg-symlink'),
    logicalIdentity: identity('symlink-session'),
    sessionId: 'symlink-session',
    sourceFilePaths: [],
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-21T00:00:00.000Z',
    projectPath: '/not-reported'
  }))
  fs.writeFileSync(path.join(externalPackage, 'backup.jsonl'), 'symlink backup')
  fs.symlinkSync(externalPackage, path.join(libraryRoot, 'symlink-only-package'))
})

afterEach(() => {
  fs.rmSync(workRoot, { recursive: true, force: true })
})

describe('duplicate recovery planner', () => {
  it('生成稳定、脱敏、完整文件 inventory，且 dry-run 对 Library 零写', async () => {
    const before = snapshotTree(libraryRoot)
    const first = await buildDuplicateRecoveryReport(libraryRoot, { quarantineRoot, hashSources: true })
    const after = snapshotTree(libraryRoot)
    const second = await buildDuplicateRecoveryReport(libraryRoot, { quarantineRoot, hashSources: true })

    expect(after).toBe(before)
    expect(second).toEqual(first)
    expect(first.mode).toBe('dry-run')
    expect(first.summary).toMatchObject({
      packageCount: 13,
      conflictCount: 8,
      unresolvedCount: 2,
      classificationCounts: {
        'canonical-candidate': 1,
        'merge-required': 1,
        'manual-review': 4,
        'missing-source': 1,
        corrupt: 1
      }
    })
    expect(first.quarantine).toMatchObject({ outsideLibraryRequired: true, verifiedOutsideLibrary: true })

    const serialized = JSON.stringify(first)
    for (const secret of [
      'canonical-A-SECRET-TITLE',
      '绝不能出现在报告里的标题',
      sourcePath,
      '/secret/project/path',
      'PRIVATE TRANSCRIPT BODY',
      'PRIVATE NOTE LEFT',
      'PRIVATE HIGHLIGHT LEFT',
      'ATTACHMENT_SECRET_BYTES',
      'LEGACY PRIVATE TITLE'
    ]) expect(serialized).not.toContain(secret)
    expect(serialized).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/)
  })

  it('只在能证明字节等价且 backup 匹配源时给 canonical；计划仅外部 quarantine 且可反向恢复', async () => {
    const report = await buildDuplicateRecoveryReport(libraryRoot, { quarantineRoot, hashSources: true })
    const canonical = conflict(report, 'canonical-candidate')
    expect(canonical).toBeTruthy()
    expect(canonical!.packages.map((item) => item.role).sort()).toEqual(['canonical', 'quarantine-candidate'])
    expect(canonical!.recovery).toMatchObject({
      action: 'quarantine-equivalent-duplicates',
      moves: [{ action: 'future-quarantine' }],
      reverse: [{ action: 'restore-from-quarantine' }]
    })
    expect(canonical!.recovery.moves[0].fromPathId).toBe(canonical!.recovery.reverse[0].originalPathId)
    expect(JSON.stringify(canonical)).not.toMatch(/delete|overwrite|rename/i)
  })

  it('分叉 backup、branch transcript、notes/highlights 与附件一律 merge-required，绝不建议丢包', async () => {
    const report = await buildDuplicateRecoveryReport(libraryRoot, { quarantineRoot, hashSources: true })
    const merge = conflict(report, 'merge-required')
    expect(merge?.reasons).toEqual(expect.arrayContaining([
      'backup-content-diverges',
      'highlights-diverge',
      'notes-diverge',
      'unique-branch-transcripts',
      'unique-user-files'
    ]))
    expect(merge?.packages.some((item) => item.uniqueEvidence.branchTranscripts.length > 0)).toBe(true)
    expect(merge?.packages.some((item) => item.uniqueEvidence.userFiles.includes('attachments/private-name.bin'))).toBe(true)
    expect(merge?.recovery).toMatchObject({ action: 'manual-merge', moves: [], reverse: [] })
    expect(merge?.packages.every((item) => item.role === 'preserve')).toBe(true)
  })

  it('缺源、坏 marker、云占位、symlink 都 fail closed', async () => {
    const report = await buildDuplicateRecoveryReport(libraryRoot, { quarantineRoot, hashSources: true })
    expect(conflict(report, 'missing-source')).toMatchObject({ recovery: { action: 'preserve-all', moves: [] } })
    expect(conflict(report, 'corrupt')).toMatchObject({
      registryReason: 'unresolved-manifest',
      recovery: { action: 'preserve-all', moves: [] }
    })
    expect(report.conflicts.some((item) => item.reasons.includes('icloud-placeholder-not-materialized'))).toBe(true)
    expect(report.conflicts.some((item) => item.registryReason === 'symlink-only' &&
      item.classification === 'manual-review' && item.packages[0].isSymlink)).toBe(true)
  })

  it('legacy 重复包和跨逻辑会话 packageId 碰撞都不会被选为 canonical', async () => {
    const report = await buildDuplicateRecoveryReport(libraryRoot, { quarantineRoot, hashSources: true })
    const legacy = report.conflicts.find((item) => item.reasons.includes('legacy-package-identity'))
    expect(legacy).toMatchObject({
      registryReason: 'duplicate-packages',
      classification: 'manual-review',
      recovery: { action: 'preserve-all', moves: [], reverse: [] }
    })
    expect(legacy?.packages.every((item) => item.manifest.packageState === 'legacy')).toBe(true)

    const collision = report.conflicts.find((item) => item.registryReason === 'package-id-collision')
    expect(collision).toMatchObject({
      classification: 'manual-review',
      reasons: ['package-id-collision-across-logical-identities'],
      recovery: { action: 'preserve-all', moves: [], reverse: [] }
    })
    expect(collision?.logicalSessionKeyHashes).toHaveLength(2)
  })

  it('默认不读 Library 外的源文件，也绝不会在缺少源 hash 证据时推荐 canonical', async () => {
    const report = await buildDuplicateRecoveryReport(libraryRoot, { quarantineRoot })
    expect(report.sourceHashing).toBe('disabled')
    expect(report.conflicts.some((item) => item.classification === 'canonical-candidate')).toBe(false)
    expect(report.conflicts.some((item) => item.reasons.includes('source-hashing-not-requested'))).toBe(true)
    expect(report.conflicts.flatMap((item) => item.packages)
      .flatMap((item) => item.sources)
      .every((item) => item.state === 'not-requested' && item.sha256 === undefined)).toBe(true)
  })

  it('未知或未来 manifest 字段不一致时 fail closed，不误判为 canonical', async () => {
    const markerPath = path.join(libraryRoot, 'canonical-B-SECRET-TITLE', '.swob-session.json')
    const manifest = JSON.parse(fs.readFileSync(markerPath, 'utf-8'))
    manifest.futurePluginState = { privateValue: 'must-not-be-reported' }
    fs.writeFileSync(markerPath, JSON.stringify(manifest, null, 2))

    const report = await buildDuplicateRecoveryReport(libraryRoot, { quarantineRoot, hashSources: true })
    const canonicalHash = hash('canonical-session')
    const candidate = report.conflicts.find((item) =>
      item.packages.some((pkg) => pkg.manifest.sessionIdHash === canonicalHash))
    expect(candidate).toMatchObject({
      classification: 'merge-required',
      recovery: { action: 'manual-merge', moves: [], reverse: [] }
    })
    expect(candidate?.reasons).toContain('manifest-fields-diverge')
    expect(JSON.stringify(report)).not.toContain('must-not-be-reported')
  })

  it('文件变化使旧 plan 明确 expired；未变化则 current', async () => {
    const report = await buildDuplicateRecoveryReport(libraryRoot, { quarantineRoot, hashSources: true })
    await expect(verifyDuplicateRecoveryPlan(libraryRoot, report, { quarantineRoot }))
      .resolves.toMatchObject({ status: 'current' })
    fs.appendFileSync(path.join(libraryRoot, 'merge-A', 'backup.jsonl'), 'changed-after-plan\n')
    const status = await verifyDuplicateRecoveryPlan(libraryRoot, report, { quarantineRoot })
    expect(status.status).toBe('expired')
    expect(status.currentSnapshotFingerprint).not.toBe(status.previousSnapshotFingerprint)
  })

  it('拒绝把 quarantine 放进 Library，Markdown 同样不泄露路径或正文', async () => {
    await expect(buildDuplicateRecoveryReport(libraryRoot, {
      quarantineRoot: path.join(libraryRoot, '.trash')
    })).rejects.toThrow('quarantine-root-must-be-outside-library')
    const report = await buildDuplicateRecoveryReport(libraryRoot, { quarantineRoot, hashSources: true })
    const markdown = renderDuplicateRecoveryMarkdown(report)
    expect(markdown).toContain('no apply capability')
    expect(markdown).toContain('Future quarantine / reverse map')
    expect(markdown).not.toContain(sourcePath)
    expect(markdown).not.toContain('PRIVATE TRANSCRIPT BODY')
    expect(markdown).not.toContain('canonical-A-SECRET-TITLE')
  })

  it('拒绝词法上在 Library 外、但经祖先 symlink 实际落回 Library 内的 quarantine', async () => {
    const internalTarget = path.join(libraryRoot, 'internal-quarantine-target')
    const outsideAlias = path.join(workRoot, 'outside-looking-alias')
    fs.mkdirSync(internalTarget)
    fs.symlinkSync(internalTarget, outsideAlias)
    await expect(buildDuplicateRecoveryReport(libraryRoot, {
      quarantineRoot: path.join(outsideAlias, 'future-plan')
    })).rejects.toThrow('quarantine-root-must-be-outside-library')
  })

  it('离线 CLI 只向 stdout 输出；无 apply 模式', () => {
    const cliPath = path.resolve('scripts/recovery/inventory.mjs')
    const invocation = spawnSync(process.execPath, [cliPath, '--library', libraryRoot, '--format', 'json'], {
      encoding: 'utf-8'
    })
    expect(invocation.status, invocation.stderr).toBe(0)
    expect(JSON.parse(invocation.stdout)).toMatchObject({ schemaVersion: 1, mode: 'dry-run' })

    const rejected = spawnSync(process.execPath, [cliPath, '--library', libraryRoot, '--apply'], {
      encoding: 'utf-8'
    })
    expect(rejected.status).toBe(64)
    expect(rejected.stderr).toContain('no apply command exists')
  })

  it('交付的 JSON schema 声明严格顶层和全部五类 classification', () => {
    const schema = JSON.parse(fs.readFileSync(path.resolve('scripts/recovery/inventory.schema.json'), 'utf-8'))
    expect(schema.additionalProperties).toBe(false)
    expect(schema.$defs.classification.enum).toEqual([
      'canonical-candidate',
      'merge-required',
      'manual-review',
      'missing-source',
      'corrupt'
    ])
  })
})
