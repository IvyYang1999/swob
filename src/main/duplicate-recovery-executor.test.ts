import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import {
  buildDuplicateRecoveryReport,
  prepareDuplicateRecoveryExecution
} from './duplicate-recovery-planner'
import {
  executeDuplicateRecoveryPlan,
  recoverInterruptedDuplicateRecoveryTransactions
} from './duplicate-recovery-executor'

let workRoot: string
let libraryRoot: string
let quarantineRoot: string

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function uuid(label: string): string {
  const value = hash(label)
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}-8${value.slice(17, 20)}-${value.slice(20, 32)}`
}

function createPackage(relativePath: string, sessionId: string, packageLabel: string, sourcePath: string): string {
  const directoryPath = path.join(libraryRoot, relativePath)
  const body = `source for ${sessionId}\n`
  fs.mkdirSync(directoryPath, { recursive: true })
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true })
  fs.writeFileSync(sourcePath, body)
  fs.writeFileSync(path.join(directoryPath, 'backup.jsonl'), body)
  fs.writeFileSync(path.join(directoryPath, 'transcript.md'), `# ${sessionId}\n`)
  fs.writeFileSync(path.join(directoryPath, '.swob-session.json'), JSON.stringify({
    schemaVersion: 3,
    packageId: uuid(packageLabel),
    logicalIdentity: {
      schemaVersion: 1,
      sourceFamily: 'claude-code',
      sourceInstance: { kind: 'default', id: 'default' },
      sessionId
    },
    sessionId,
    sourceFilePaths: [sourcePath],
    backupSha256: hash(body),
    backupSize: Buffer.byteLength(body),
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z'
  }))
  return directoryPath
}

function packageCount(root: string): number {
  let count = 0
  if (!fs.existsSync(root)) return count
  const walk = (directoryPath: string) => {
    for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const child = path.join(directoryPath, entry.name)
      if (fs.existsSync(path.join(child, '.swob-session.json'))) count++
      else walk(child)
    }
  }
  walk(root)
  return count
}

beforeEach(() => {
  workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-recovery-executor-'))
  libraryRoot = path.join(workRoot, 'Library')
  quarantineRoot = path.join(workRoot, 'Quarantine')
  fs.mkdirSync(libraryRoot)
  for (const group of ['a', 'b']) {
    const sourcePath = path.join(workRoot, 'sources', `${group}.jsonl`)
    createPackage(`group-${group}/one`, `session-${group}`, `${group}-one`, sourcePath)
    createPackage(`group-${group}/two`, `session-${group}`, `${group}-two`, sourcePath)
  }
})

afterEach(() => {
  fs.chmodSync(path.join(libraryRoot, 'group-a'), 0o700)
  fs.chmodSync(path.join(libraryRoot, 'group-b'), 0o700)
  fs.rmSync(workRoot, { recursive: true, force: true })
})

describe('duplicate recovery executor', () => {
  it('只移动字节等价副本，保留 canonical，并写出可反向恢复的完成 journal', async () => {
    const report = await buildDuplicateRecoveryReport(libraryRoot, {
      quarantineRoot,
      hashSources: true,
      inventoryScope: 'repair-candidates'
    })
    expect(report.summary.classificationCounts['canonical-candidate']).toBe(2)

    const result = await executeDuplicateRecoveryPlan(libraryRoot, report, { quarantineRoot })

    expect(result).toMatchObject({ appliedPackageCount: 2, restartRequired: true })
    expect(packageCount(libraryRoot)).toBe(2)
    expect(packageCount(quarantineRoot)).toBe(2)
    const journalPath = path.join(quarantineRoot, report.planId.replace(/^plan:/, ''), 'recovery-journal.json')
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'))
    expect(journal.state).toBe('complete')
    expect(journal.moves).toHaveLength(2)
    expect(journal.moves.every((move: { state: string }) => move.state === 'quarantined')).toBe(true)
  })

  it('plan 后内容变化会 fail closed，且不创建隔离事务', async () => {
    const report = await buildDuplicateRecoveryReport(libraryRoot, { quarantineRoot, hashSources: true })
    fs.appendFileSync(path.join(libraryRoot, 'group-a', 'one', 'transcript.md'), 'changed\n')

    await expect(executeDuplicateRecoveryPlan(libraryRoot, report, { quarantineRoot }))
      .rejects.toThrow('duplicate-recovery-plan-expired')
    expect(packageCount(libraryRoot)).toBe(4)
    expect(fs.existsSync(quarantineRoot)).toBe(false)
  })

  it('中途移动失败时按逆序回滚，不留下半修复 Library', async () => {
    const report = await buildDuplicateRecoveryReport(libraryRoot, { quarantineRoot, hashSources: true })
    const prepared = await prepareDuplicateRecoveryExecution(libraryRoot, report, { quarantineRoot })
    expect(prepared.moves).toHaveLength(2)
    const blockedParent = path.dirname(prepared.moves[1].fromPath)
    fs.chmodSync(blockedParent, 0o500)
    try {
      await expect(executeDuplicateRecoveryPlan(libraryRoot, report, { quarantineRoot })).rejects.toThrow()
    } finally {
      fs.chmodSync(blockedParent, 0o700)
    }

    expect(packageCount(libraryRoot)).toBe(4)
    expect(packageCount(quarantineRoot)).toBe(0)
    const journalPath = path.join(quarantineRoot, report.planId.replace(/^plan:/, ''), 'recovery-journal.json')
    expect(JSON.parse(fs.readFileSync(journalPath, 'utf8')).state).toBe('rolled-back')
  })

  it('prepare 后路径内容被替换时，先原子认领再复核实际移动对象并回滚', async () => {
    const report = await buildDuplicateRecoveryReport(libraryRoot, { quarantineRoot, hashSources: true })

    await expect(executeDuplicateRecoveryPlan(libraryRoot, report, {
      quarantineRoot,
      beforeMove: (move, index) => {
        if (index === 0) fs.appendFileSync(path.join(move.fromPath, 'transcript.md'), 'replaced after prepare\n')
      }
    })).rejects.toThrow('duplicate-recovery-package-changed-at-rename')

    expect(packageCount(libraryRoot)).toBe(4)
    expect(packageCount(quarantineRoot)).toBe(0)
  })

  it('启动时自动回滚未到达 complete journal 的中断事务', async () => {
    const report = await buildDuplicateRecoveryReport(libraryRoot, { quarantineRoot, hashSources: true })
    const prepared = await prepareDuplicateRecoveryExecution(libraryRoot, report, { quarantineRoot })
    const move = prepared.moves[0]
    const planDirectory = path.dirname(move.quarantinePath)
    fs.mkdirSync(planDirectory, { recursive: true })
    fs.writeFileSync(path.join(planDirectory, 'recovery-journal.json'), JSON.stringify({
      schemaVersion: 1,
      planId: prepared.planId,
      state: 'applying',
      createdAt: '2026-08-09T00:00:00.000Z',
      moves: prepared.moves.map((candidate) => ({
        pathId: candidate.pathId,
        originalPath: candidate.fromPath,
        quarantinePath: candidate.quarantinePath,
        expectedPackageTreeHash: candidate.expectedPackageTreeHash,
        state: candidate.pathId === move.pathId ? 'quarantined' : 'pending'
      }))
    }))
    fs.renameSync(move.fromPath, move.quarantinePath)

    const recovered = await recoverInterruptedDuplicateRecoveryTransactions(libraryRoot, quarantineRoot)

    expect(recovered).toEqual({ recoveredPlanCount: 1, recoveredPackageCount: 1 })
    expect(packageCount(libraryRoot)).toBe(4)
    expect(packageCount(quarantineRoot)).toBe(0)
    expect(JSON.parse(fs.readFileSync(path.join(planDirectory, 'recovery-journal.json'), 'utf8')).state)
      .toBe('rolled-back')
  })

  it('中断后的隔离对象被改动时拒绝回灌 Library', async () => {
    const report = await buildDuplicateRecoveryReport(libraryRoot, { quarantineRoot, hashSources: true })
    const prepared = await prepareDuplicateRecoveryExecution(libraryRoot, report, { quarantineRoot })
    const move = prepared.moves[0]
    const planDirectory = path.dirname(move.quarantinePath)
    fs.mkdirSync(planDirectory, { recursive: true })
    fs.writeFileSync(path.join(planDirectory, 'recovery-journal.json'), JSON.stringify({
      schemaVersion: 1,
      planId: prepared.planId,
      state: 'applying',
      createdAt: '2026-08-09T00:00:00.000Z',
      moves: [{
        pathId: move.pathId,
        originalPath: move.fromPath,
        quarantinePath: move.quarantinePath,
        expectedPackageTreeHash: move.expectedPackageTreeHash,
        state: 'quarantined'
      }]
    }))
    fs.renameSync(move.fromPath, move.quarantinePath)
    fs.appendFileSync(path.join(move.quarantinePath, 'transcript.md'), 'tampered after crash\n')

    await expect(recoverInterruptedDuplicateRecoveryTransactions(libraryRoot, quarantineRoot))
      .rejects.toThrow('duplicate-recovery-rollback-package-changed')
    expect(fs.existsSync(move.fromPath)).toBe(false)
    expect(fs.existsSync(move.quarantinePath)).toBe(true)
  })
})
