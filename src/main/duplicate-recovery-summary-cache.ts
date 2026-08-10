import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  DUPLICATE_RECOVERY_PLANNER_REVISION,
  type DuplicateRecoverySummary
} from '../shared/duplicate-recovery-contract'

interface PersistedDuplicateRecoverySummary {
  schemaVersion: 1
  plannerRevision: typeof DUPLICATE_RECOVERY_PLANNER_REVISION
  libraryRootHash: string
  writeGeneration: number
  completedAt: string
  summary: Omit<DuplicateRecoverySummary, 'completedAt' | 'canApply'>
}

function libraryRootHash(libraryRoot: string): string {
  return createHash('sha256').update(path.resolve(libraryRoot)).digest('hex')
}

function validCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function redactedSummary(summary: PersistedDuplicateRecoverySummary['summary']): PersistedDuplicateRecoverySummary['summary'] {
  return {
    schemaVersion: 1,
    planId: summary.planId,
    packageCount: summary.packageCount,
    conflictCount: summary.conflictCount,
    autoRepairableGroupCount: summary.autoRepairableGroupCount,
    autoRepairablePackageCount: summary.autoRepairablePackageCount,
    manualMergeGroupCount: summary.manualMergeGroupCount,
    preservedGroupCount: summary.preservedGroupCount
  }
}

function parsePersisted(value: unknown): PersistedDuplicateRecoverySummary | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Partial<PersistedDuplicateRecoverySummary>
  const summary = candidate.summary as Partial<PersistedDuplicateRecoverySummary['summary']> | undefined
  if (candidate.schemaVersion !== 1 ||
    candidate.plannerRevision !== DUPLICATE_RECOVERY_PLANNER_REVISION ||
    typeof candidate.libraryRootHash !== 'string' || !/^[0-9a-f]{64}$/.test(candidate.libraryRootHash) ||
    !Number.isSafeInteger(candidate.writeGeneration) ||
    typeof candidate.completedAt !== 'string' || !Number.isFinite(Date.parse(candidate.completedAt)) ||
    !summary || summary.schemaVersion !== 1 ||
    typeof summary.planId !== 'string' || !/^plan:[0-9a-f]{24}$/.test(summary.planId) ||
    !validCount(summary.packageCount) || !validCount(summary.conflictCount) ||
    !validCount(summary.autoRepairableGroupCount) || !validCount(summary.autoRepairablePackageCount) ||
    !validCount(summary.manualMergeGroupCount) || !validCount(summary.preservedGroupCount)) return null
  return candidate as PersistedDuplicateRecoverySummary
}

export function readDuplicateRecoverySummaryCache(
  filePath: string,
  libraryRoot: string
): DuplicateRecoverySummary | null {
  try {
    const metadata = fs.lstatSync(filePath)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 64 * 1024) return null
    const persisted = parsePersisted(JSON.parse(fs.readFileSync(filePath, 'utf8')))
    if (!persisted || persisted.libraryRootHash !== libraryRootHash(libraryRoot)) return null
    return {
      ...redactedSummary(persisted.summary),
      completedAt: persisted.completedAt,
      canApply: false
    }
  } catch {
    return null
  }
}

export function writeDuplicateRecoverySummaryCache(
  filePath: string,
  libraryRoot: string,
  writeGeneration: number,
  summary: DuplicateRecoverySummary
): void {
  const { completedAt } = summary
  const persisted: PersistedDuplicateRecoverySummary = {
    schemaVersion: 1,
    plannerRevision: DUPLICATE_RECOVERY_PLANNER_REVISION,
    libraryRootHash: libraryRootHash(libraryRoot),
    writeGeneration,
    completedAt,
    summary: redactedSummary(summary)
  }
  const parent = path.dirname(filePath)
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 })
  const temporary = path.join(parent, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(persisted)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    fs.renameSync(temporary, filePath)
    try {
      const descriptor = fs.openSync(parent, 'r')
      try { fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
    } catch { /* best-effort directory durability */ }
  } finally {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary) } catch { /* preserve final result */ }
  }
}
