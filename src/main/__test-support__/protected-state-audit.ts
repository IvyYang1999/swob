import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  protectedRealStateTargets,
  type IsolationEnvironment,
  type RuntimeIsolationOptions
} from '../e2e-library-isolation'

export interface ProtectedStateSnapshot {
  entries: Array<{ label: string; digest: string }>
}

function metadataDigest(root: string): string {
  const hash = createHash('sha256')
  const visit = (target: string, relativePath: string): void => {
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(target)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      hash.update(`${relativePath}\0${code === 'ENOENT' ? 'missing' : `error:${code || 'unknown'}`}\0`)
      return
    }
    const kind = stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'file'
    hash.update([
      relativePath,
      kind,
      String(stat.size),
      String(stat.mode),
      String(stat.mtimeMs),
      String(stat.ctimeMs),
      String(stat.ino)
    ].join('\0'))
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

export function snapshotProtectedRealState(
  environment: IsolationEnvironment = process.env,
  options: RuntimeIsolationOptions = {}
): ProtectedStateSnapshot {
  return {
    entries: protectedRealStateTargets(environment, options).map((target, index) => ({
      label: `${target.label}-${index + 1}`,
      digest: metadataDigest(target.targetPath)
    }))
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
    if (before.entries[index].label !== after.entries[index].label ||
      before.entries[index].digest !== after.entries[index].digest) {
      throw new Error(`Test isolation violation: protected ${before.entries[index].label} changed`)
    }
  }
}
