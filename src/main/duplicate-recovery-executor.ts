import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  prepareDuplicateRecoveryExecution,
  type DuplicateRecoveryReport
} from './duplicate-recovery-planner'
import type { DuplicateRecoveryApplyResult } from '../shared/duplicate-recovery-contract'

export interface ExecuteDuplicateRecoveryOptions {
  quarantineRoot?: string
  signal?: AbortSignal
}

function nearestExistingAncestor(candidatePath: string): string {
  let current = path.resolve(candidatePath)
  for (;;) {
    try {
      fs.lstatSync(current)
      return current
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = path.dirname(current)
      if (parent === current) throw new Error('path-has-no-readable-existing-ancestor')
      current = parent
    }
  }
}

function fsyncDirectory(directoryPath: string): void {
  const descriptor = fs.openSync(directoryPath, 'r')
  try { fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
}

function writeJsonFileExclusive(filePath: string, value: unknown): void {
  const descriptor = fs.openSync(filePath, 'wx', 0o600)
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
}

function replaceJsonFile(filePath: string, value: unknown): void {
  const temporaryPath = `${filePath}.next`
  const descriptor = fs.openSync(temporaryPath, 'wx', 0o600)
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
  fs.renameSync(temporaryPath, filePath)
  fsyncDirectory(path.dirname(filePath))
}

/**
 * Move only byte-equivalent duplicates into a recoverable local quarantine.
 * The caller must hold the Library maintenance writer lease.
 */
export async function executeDuplicateRecoveryPlan(
  libraryRoot: string,
  accepted: DuplicateRecoveryReport,
  options: ExecuteDuplicateRecoveryOptions = {}
): Promise<DuplicateRecoveryApplyResult> {
  const prepared = await prepareDuplicateRecoveryExecution(libraryRoot, accepted, options)
  if (prepared.moves.length === 0) {
    return { schemaVersion: 1, planId: prepared.planId, appliedPackageCount: 0, restartRequired: false }
  }
  const quarantineDevice = fs.statSync(nearestExistingAncestor(prepared.quarantineRoot)).dev
  for (const move of prepared.moves) {
    if (fs.statSync(move.fromPath).dev !== quarantineDevice) {
      throw new Error('duplicate-recovery-quarantine-must-share-filesystem')
    }
  }

  const planDirectory = path.dirname(prepared.moves[0].quarantinePath)
  fs.mkdirSync(planDirectory, { recursive: true, mode: 0o700 })
  const journalPath = path.join(planDirectory, 'recovery-journal.json')
  const journal = {
    schemaVersion: 1,
    planId: prepared.planId,
    state: 'prepared',
    createdAt: new Date().toISOString(),
    moves: prepared.moves.map((move) => ({
      pathId: move.pathId,
      originalPath: move.fromPath,
      quarantinePath: move.quarantinePath,
      expectedPackageTreeHash: move.expectedPackageTreeHash,
      state: 'pending'
    }))
  }
  writeJsonFileExclusive(journalPath, journal)
  fsyncDirectory(planDirectory)

  const completed: typeof prepared.moves = []
  try {
    for (const move of prepared.moves) {
      if (options.signal?.aborted) throw new Error('duplicate-recovery-apply-cancelled')
      if (fs.existsSync(move.quarantinePath)) throw new Error('duplicate-recovery-target-already-exists')
      fs.renameSync(move.fromPath, move.quarantinePath)
      completed.push(move)
      const journalMove = journal.moves.find((item) => item.pathId === move.pathId)
      if (journalMove) journalMove.state = 'quarantined'
      replaceJsonFile(journalPath, { ...journal, state: 'applying' })
      fsyncDirectory(path.dirname(move.fromPath))
      fsyncDirectory(planDirectory)
    }
  } catch (error) {
    let rollbackFailed = false
    for (const move of [...completed].reverse()) {
      try {
        if (fs.existsSync(move.fromPath) || !fs.existsSync(move.quarantinePath)) {
          rollbackFailed = true
          continue
        }
        fs.renameSync(move.quarantinePath, move.fromPath)
        const journalMove = journal.moves.find((item) => item.pathId === move.pathId)
        if (journalMove) journalMove.state = 'rolled-back'
        fsyncDirectory(path.dirname(move.fromPath))
        fsyncDirectory(planDirectory)
      } catch {
        rollbackFailed = true
      }
    }
    replaceJsonFile(journalPath, {
      ...journal,
      state: rollbackFailed ? 'rollback-incomplete' : 'rolled-back',
      failedAt: new Date().toISOString()
    })
    if (rollbackFailed) throw new Error('duplicate-recovery-rollback-incomplete')
    throw error
  }

  replaceJsonFile(journalPath, {
    ...journal,
    state: 'complete',
    completedAt: new Date().toISOString()
  })
  return {
    schemaVersion: 1,
    planId: prepared.planId,
    appliedPackageCount: completed.length,
    restartRequired: true
  }
}
