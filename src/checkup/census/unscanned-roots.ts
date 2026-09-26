/**
 * Known tool directories that Swob does not scan (C1a registers two):
 * - `~/.kimi/sessions/<workspace>/<session>/context.jsonl` (legacy Kimi CLI);
 * - `~/.zcode/v2` (ZCode v2 task index; whether it holds sessions is unverified).
 * Only directory listings are read.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { isDirectory } from './files'

export interface UnscannedRootsCensus {
  kimiLegacy: { present: boolean; units: number }
  zcodeV2: { present: boolean }
}

function childDirectories(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name))
  } catch {
    return []
  }
}

export function censusUnscannedRoots(homeDir: string): UnscannedRootsCensus {
  const kimiRoot = path.join(homeDir, '.kimi', 'sessions')
  let kimiUnits = 0
  for (const workspace of childDirectories(kimiRoot)) {
    for (const session of childDirectories(workspace)) {
      try {
        if (fs.lstatSync(path.join(session, 'context.jsonl')).isFile()) kimiUnits++
      } catch { /* not a legacy session directory */ }
    }
  }
  return {
    kimiLegacy: { present: isDirectory(kimiRoot), units: kimiUnits },
    zcodeV2: { present: isDirectory(path.join(homeDir, '.zcode', 'v2')) }
  }
}
