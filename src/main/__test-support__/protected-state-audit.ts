import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  protectedRealStateTargets,
  type IsolationEnvironment,
  type RuntimeIsolationOptions
} from '../e2e-library-isolation'

export interface ProtectedStateSnapshot {
  entries: Array<{
    label: string
    digest: string
    contentDigest: string
    concurrentCacheDigest: string
    concurrentCacheDigests: string[]
  }>
}

export type ProtectedStateSnapshotPhase =
  | 'after-leading-cache-scan'
  | 'after-stable-metadata-cache-scan'
  | 'after-stable-content-cache-scan'

export interface ProtectedStateSnapshotInstrumentation {
  onPhase?: (event: { label: string; phase: ProtectedStateSnapshotPhase }) => void
}

const CONCURRENT_PRODUCTION_CACHE = /^summary-cache\.(?:json(?:\.\d+\.\d+\.tmp)?|sqlite(?:-journal|-wal|-shm)?)$/

function isConcurrentProductionCache(label: string, relativePath: string): boolean {
  return label.startsWith('user-config-') &&
    path.dirname(relativePath) === '.' &&
    CONCURRENT_PRODUCTION_CACHE.test(path.basename(relativePath))
}

function metadataDigest(
  root: string,
  label: string,
  options: { ignoreRootDirectoryMetadata?: boolean } = {}
): string {
  const hash = createHash('sha256')
  const visit = (target: string, relativePath: string): void => {
    if (isConcurrentProductionCache(label, relativePath)) return
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(target)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      hash.update(`${relativePath}\0${code === 'ENOENT' ? 'missing' : `error:${code || 'unknown'}`}\0`)
      return
    }
    const kind = stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'file'
    hash.update([relativePath, kind, String(stat.mode)].join('\0'))
    if (!stat.isDirectory() || !(options.ignoreRootDirectoryMetadata && relativePath === '.')) {
      hash.update([
        String(stat.size),
        String(stat.mtimeMs),
        String(stat.ctimeMs),
        String(stat.ino)
      ].join('\0'))
    }
    if (!stat.isDirectory()) return

    let names: string[]
    try {
      names = fs.readdirSync(target).sort()
    } catch (error) {
      hash.update(`readdir-error:${(error as NodeJS.ErrnoException).code || 'unknown'}\0`)
      return
    }
    for (const name of names) visit(path.join(target, name), path.join(relativePath, name))
  }
  visit(root, '.')
  return hash.digest('hex')
}

function concurrentCacheDigest(root: string, label: string): string {
  const hash = createHash('sha256')
  if (!label.startsWith('user-config-')) return hash.digest('hex')
  let names: string[]
  try {
    names = fs.readdirSync(root).filter((name) => CONCURRENT_PRODUCTION_CACHE.test(name)).sort()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    hash.update(code === 'ENOENT' ? 'missing' : `error:${code || 'unknown'}`)
    return hash.digest('hex')
  }
  for (const name of names) {
    const target = path.join(root, name)
    try {
      const stat = fs.lstatSync(target)
      hash.update([
        name,
        stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'file',
        String(stat.size),
        String(stat.mode),
        String(stat.mtimeMs),
        String(stat.ctimeMs),
        String(stat.ino)
      ].join('\0'))
    } catch (error) {
      hash.update(`${name}\0error:${(error as NodeJS.ErrnoException).code || 'unknown'}\0`)
    }
  }
  return hash.digest('hex')
}

export function snapshotProtectedRealState(
  environment: IsolationEnvironment = process.env,
  options: RuntimeIsolationOptions = {},
  instrumentation: ProtectedStateSnapshotInstrumentation = {}
): ProtectedStateSnapshot {
  return {
    entries: protectedRealStateTargets(environment, options).map((target, index) => {
      const label = `${target.label}-${index + 1}`
      const concurrentCacheDigests: string[] = []
      const sampleConcurrentCache = (phase: ProtectedStateSnapshotPhase): void => {
        concurrentCacheDigests.push(concurrentCacheDigest(target.targetPath, label))
        instrumentation.onPhase?.({ label, phase })
      }
      sampleConcurrentCache('after-leading-cache-scan')
      const digest = metadataDigest(target.targetPath, label)
      sampleConcurrentCache('after-stable-metadata-cache-scan')
      const contentDigest = metadataDigest(
        target.targetPath,
        label,
        { ignoreRootDirectoryMetadata: true }
      )
      sampleConcurrentCache('after-stable-content-cache-scan')
      return {
        label,
        digest,
        contentDigest,
        concurrentCacheDigest: concurrentCacheDigests[concurrentCacheDigests.length - 1],
        concurrentCacheDigests
      }
    })
  }
}

export function assertProtectedRealStateUnchanged(
  before: ProtectedStateSnapshot,
  environment: IsolationEnvironment = process.env,
  options: RuntimeIsolationOptions = {}
): void {
  const after = snapshotProtectedRealState(environment, options)
  if (before.entries.length !== after.entries.length) {
    throw new Error('Test isolation violation: protected real-state target set changed')
  }
  for (let index = 0; index < before.entries.length; index++) {
    if (before.entries[index].label !== after.entries[index].label) {
      throw new Error('Test isolation violation: protected real-state target set changed')
    }
    const stableChanged = before.entries[index].digest !== after.entries[index].digest
    const contentChanged = before.entries[index].contentDigest !== after.entries[index].contentDigest
    const concurrentCacheDigests = [
      ...before.entries[index].concurrentCacheDigests,
      ...after.entries[index].concurrentCacheDigests
    ]
    const concurrentCacheChanged = concurrentCacheDigests.some(
      (digest) => digest !== concurrentCacheDigests[0]
    )
    if (contentChanged || (stableChanged && !concurrentCacheChanged)) {
      throw new Error(`Test isolation violation: protected ${before.entries[index].label} changed`)
    }
    if (concurrentCacheChanged) {
      console.warn(
        `Test isolation audit: excluded concurrent production summary-cache mutation from ${before.entries[index].label}`
      )
    }
  }
}
