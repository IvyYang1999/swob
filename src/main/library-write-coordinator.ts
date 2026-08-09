import * as fs from 'node:fs'
import * as path from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import {
  acquireLibraryWriterArbiter,
  acquireLibraryWriterArbiterSync,
  acquireLibraryWriterLease,
  acquireLibraryWriterLeaseSync,
  assertLibraryWriterArbiterOpen,
  closeLibraryWriterArbiter,
  emitLibraryWriterEvent,
  hashLibraryRoot,
  LibraryWriterCoordinatorClosedError,
  resetLibraryWriterArbiterForTests,
  type LibraryWriterEvent,
  type LibraryWriterLeaseOptions,
  type LibraryWriterMode
} from './library-writer-lease'

export { LibraryWriterCoordinatorClosedError }
import {
  ensureSafeLibraryDirectory,
  fsyncDirectorySync,
  writeSafeLibraryFileSync
} from './library-path-safety'

interface LibraryWriteContext {
  root: string
  deviceId: string
}

const writeContext = new AsyncLocalStorage<LibraryWriteContext>()
const LEGACY_GENERATION_FILE = path.join('.swob', 'library-generation.json')
const GENERATION_SLOTS = [
  path.join('.swob', 'library-generation-a.json'),
  path.join('.swob', 'library-generation-b.json')
] as const

export interface LibraryGenerationRecord {
  schemaVersion: 1
  generation: number
  updatedAt: string
}

function readGenerationRecord(filePath: string): number | null {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<LibraryGenerationRecord>
    return value.schemaVersion === 1 && Number.isSafeInteger(value.generation) && value.generation! >= 0 &&
      typeof value.updatedAt === 'string' && Number.isFinite(Date.parse(value.updatedAt))
      ? value.generation!
      : null
  } catch {
    return null
  }
}

export function readLibraryWriteGeneration(root: string): number {
  const candidates = [
    readGenerationRecord(path.join(root, LEGACY_GENERATION_FILE)),
    ...GENERATION_SLOTS.map((relativePath) => readGenerationRecord(path.join(root, relativePath)))
  ].filter((value): value is number => value !== null)
  return candidates.length > 0 ? Math.max(...candidates) : 0
}

function bumpLibraryWriteGeneration(root: string): number {
  const next = readLibraryWriteGeneration(root) + 1
  const metadataDir = path.join(root, '.swob')
  ensureSafeLibraryDirectory(root, metadataDir)
  // Alternate slots so a process/power loss while writing one record leaves a
  // previous valid generation. The write is verified before Library mutation.
  const filePath = path.join(root, GENERATION_SLOTS[next % GENERATION_SLOTS.length])
  writeSafeLibraryFileSync(root, filePath, JSON.stringify({
    schemaVersion: 1,
    generation: next,
    updatedAt: new Date().toISOString()
  } satisfies LibraryGenerationRecord), { mode: 0o600 })
  fsyncDirectorySync(metadataDir)
  if (readGenerationRecord(filePath) !== next) {
    throw new Error('library-generation-write-unverifiable')
  }
  return next
}

function isReentrant(root: string, deviceId: string): boolean {
  const active = writeContext.getStore()
  return Boolean(active && active.root === path.resolve(root) && active.deviceId === deviceId)
}

export function assertLibraryWriterHeld(root: string): void {
  const active = writeContext.getStore()
  if (!active || active.root !== path.resolve(root)) throw new Error('library-write-outside-coordinator')
}

export async function runWithLibraryWriter<T>(
  root: string,
  deviceId: string,
  mode: LibraryWriterMode,
  operation: () => Promise<T> | T,
  options: LibraryWriterLeaseOptions = {}
): Promise<T> {
  assertLibraryWriterArbiterOpen()
  if (isReentrant(root, deviceId)) return operation()
  const resolvedRoot = path.resolve(root)
  const arbiter = await acquireLibraryWriterArbiter()
  try {
    const lease = await acquireLibraryWriterLease(resolvedRoot, deviceId, mode, {
      ...options,
      arbiterOwnerId: arbiter.ownerId
    })
    try {
      assertLibraryWriterArbiterOpen()
      // Reserve the generation durably before any mutation. A process killed in
      // the operation still invalidates scans that started before this writer.
      bumpLibraryWriteGeneration(resolvedRoot)
      return await writeContext.run({ root: resolvedRoot, deviceId }, operation)
    } finally {
      lease.release()
    }
  } finally {
    arbiter.release()
  }
}

export function runWithLibraryWriterSync<T>(
  root: string,
  deviceId: string,
  mode: LibraryWriterMode,
  operation: () => T,
  options: LibraryWriterLeaseOptions = {}
): T {
  assertLibraryWriterArbiterOpen()
  if (isReentrant(root, deviceId)) return operation()
  const resolvedRoot = path.resolve(root)
  const arbiter = acquireLibraryWriterArbiterSync()
  try {
    const lease = acquireLibraryWriterLeaseSync(resolvedRoot, deviceId, mode, {
      ...options,
      arbiterOwnerId: arbiter.ownerId
    })
    try {
      bumpLibraryWriteGeneration(resolvedRoot)
      return writeContext.run({ root: resolvedRoot, deviceId }, operation)
    } finally {
      lease.release()
    }
  } finally {
    arbiter.release()
  }
}

export function closeLibraryWriterCoordinator(): void {
  closeLibraryWriterArbiter()
}

export function resetLibraryWriterCoordinatorForTests(): void {
  resetLibraryWriterArbiterForTests()
}

export function staleScanEvent(
  root: string,
  incomingGeneration: number,
  currentGeneration: number,
  sink: (event: LibraryWriterEvent & { incomingGeneration: number; currentGeneration: number }) => void = emitLibraryWriterEvent
): void {
  sink({
    component: 'library-writer',
    event: 'stale-scan-rejected',
    libraryHash: hashLibraryRoot(root),
    mode: 'maintenance',
    incomingGeneration,
    currentGeneration
  })
}
