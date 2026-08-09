import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  calculateRecoveryPackageTreeHash,
  prepareDuplicateRecoveryExecution,
  type DuplicateRecoveryReport
} from './duplicate-recovery-planner'
import type { DuplicateRecoveryApplyResult } from '../shared/duplicate-recovery-contract'

export interface ExecuteDuplicateRecoveryOptions {
  quarantineRoot?: string
  signal?: AbortSignal
  /** Deterministic test seam for prepare-to-rename replacement races. */
  beforeMove?: (move: { fromPath: string; quarantinePath: string }, index: number) => void
}

interface RecoveryJournalMove {
  pathId: string
  originalPath: string
  quarantinePath: string
  expectedPackageTreeHash: string
  state: 'pending' | 'quarantined' | 'rolled-back'
}

interface RecoveryJournal {
  schemaVersion: 1
  planId: string
  state: 'prepared' | 'applying' | 'complete' | 'rolled-back' | 'rollback-incomplete'
  createdAt: string
  completedAt?: string
  failedAt?: string
  recoveredAt?: string
  moves: RecoveryJournalMove[]
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

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate))
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function readRecoveryJournal(filePath: string, planDirectory: string, libraryRoot: string): RecoveryJournal {
  const journalStat = fs.lstatSync(filePath)
  if (!journalStat.isFile() || journalStat.isSymbolicLink()) {
    throw new Error('duplicate-recovery-journal-not-physical-file')
  }
  const value: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('duplicate-recovery-journal-invalid')
  }
  const journal = value as Partial<RecoveryJournal>
  const planToken = path.basename(planDirectory)
  if (journal.schemaVersion !== 1 || journal.planId !== `plan:${planToken}` ||
    !['prepared', 'applying', 'complete', 'rolled-back', 'rollback-incomplete'].includes(String(journal.state)) ||
    !Array.isArray(journal.moves)) {
    throw new Error('duplicate-recovery-journal-invalid')
  }
  for (const move of journal.moves) {
    if (!move || !/^path:[0-9a-f]{24}$/.test(move.pathId) ||
      !/^[0-9a-f]{64}$/.test(move.expectedPackageTreeHash) ||
      !['pending', 'quarantined', 'rolled-back'].includes(move.state)) {
      throw new Error('duplicate-recovery-journal-move-invalid')
    }
    const originalPath = path.resolve(move.originalPath)
    const quarantinePath = path.resolve(move.quarantinePath)
    if (!isInside(libraryRoot, originalPath) || originalPath === path.resolve(libraryRoot)) {
      throw new Error('duplicate-recovery-journal-original-path-invalid')
    }
    const originalParent = fs.realpathSync(path.dirname(originalPath))
    if (!isInside(libraryRoot, originalParent)) {
      throw new Error('duplicate-recovery-journal-original-parent-invalid')
    }
    if (path.dirname(quarantinePath) !== path.resolve(planDirectory)) {
      throw new Error('duplicate-recovery-journal-quarantine-parent-invalid')
    }
    if (path.basename(quarantinePath) !== move.pathId.replace(/^path:/, '')) {
      throw new Error('duplicate-recovery-journal-quarantine-name-invalid')
    }
  }
  return journal as RecoveryJournal
}

/** Roll back transactions that never reached a durable `complete` journal. */
export async function recoverInterruptedDuplicateRecoveryTransactions(
  libraryRootInput: string,
  quarantineRootInput: string
): Promise<{ recoveredPlanCount: number; recoveredPackageCount: number }> {
  const libraryRoot = fs.realpathSync(path.resolve(libraryRootInput))
  const requestedQuarantineRoot = path.resolve(quarantineRootInput)
  if (!fs.existsSync(requestedQuarantineRoot)) return { recoveredPlanCount: 0, recoveredPackageCount: 0 }
  const quarantineRoot = fs.realpathSync(requestedQuarantineRoot)
  if (isInside(libraryRoot, quarantineRoot)) throw new Error('quarantine-root-must-be-outside-library')
  let recoveredPlanCount = 0
  let recoveredPackageCount = 0
  const entries = fs.readdirSync(quarantineRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[0-9a-f]{24}$/.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of entries) {
    const planDirectory = path.join(quarantineRoot, entry.name)
    const journalPath = path.join(planDirectory, 'recovery-journal.json')
    const nextJournalPath = `${journalPath}.next`
    if (fs.existsSync(nextJournalPath)) {
      readRecoveryJournal(nextJournalPath, planDirectory, libraryRoot)
      fs.renameSync(nextJournalPath, journalPath)
      fsyncDirectory(planDirectory)
    }
    if (!fs.existsSync(journalPath)) continue
    const journal = readRecoveryJournal(journalPath, planDirectory, libraryRoot)
    if (journal.state === 'complete' || journal.state === 'rolled-back') continue
    for (const move of [...journal.moves].reverse()) {
      const originalExists = fs.existsSync(move.originalPath)
      const quarantineExists = fs.existsSync(move.quarantinePath)
      if (originalExists && quarantineExists) {
        throw new Error('duplicate-recovery-rollback-target-collision')
      }
      if (!originalExists && !quarantineExists) {
        throw new Error('duplicate-recovery-rollback-artifact-missing')
      }
      if (quarantineExists) {
        const movedTreeHash = await calculateRecoveryPackageTreeHash(
          libraryRoot,
          move.originalPath,
          move.quarantinePath
        )
        if (movedTreeHash !== move.expectedPackageTreeHash) {
          throw new Error('duplicate-recovery-rollback-package-changed')
        }
        if (fs.statSync(move.quarantinePath).dev !== fs.statSync(path.dirname(move.originalPath)).dev) {
          throw new Error('duplicate-recovery-rollback-must-share-filesystem')
        }
        fs.renameSync(move.quarantinePath, move.originalPath)
        fsyncDirectory(path.dirname(move.originalPath))
        fsyncDirectory(planDirectory)
        recoveredPackageCount++
      }
      move.state = 'rolled-back'
    }
    replaceJsonFile(journalPath, {
      ...journal,
      state: 'rolled-back',
      recoveredAt: new Date().toISOString()
    })
    recoveredPlanCount++
  }
  return { recoveredPlanCount, recoveredPackageCount }
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
  const journal: RecoveryJournal = {
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
    for (const [index, move] of prepared.moves.entries()) {
      if (options.signal?.aborted) throw new Error('duplicate-recovery-apply-cancelled')
      if (fs.existsSync(move.quarantinePath)) throw new Error('duplicate-recovery-target-already-exists')
      const sourceParent = fs.realpathSync(path.dirname(move.fromPath))
      if (!isInside(prepared.libraryRoot, sourceParent)) {
        throw new Error('duplicate-recovery-source-parent-outside-library')
      }
      options.beforeMove?.(move, index)
      fs.renameSync(move.fromPath, move.quarantinePath)
      completed.push(move)
      const movedTreeHash = await calculateRecoveryPackageTreeHash(
        prepared.libraryRoot,
        move.fromPath,
        move.quarantinePath,
        options.signal
      )
      if (movedTreeHash !== move.expectedPackageTreeHash) {
        throw new Error('duplicate-recovery-package-changed-at-rename')
      }
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
