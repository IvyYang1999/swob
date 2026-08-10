import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  readDuplicateRecoverySummaryCache,
  writeDuplicateRecoverySummaryCache
} from './duplicate-recovery-summary-cache'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('duplicate recovery summary cache', () => {
  it('persists only a root hash and redacted counts, and never authorizes Apply after restart', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-duplicate-summary-'))
    roots.push(root)
    const libraryRoot = path.join(root, 'private-library-name')
    const filePath = path.join(root, 'diagnostics', 'summary.json')
    writeDuplicateRecoverySummaryCache(filePath, libraryRoot, 42, {
      schemaVersion: 1,
      planId: 'plan:0123456789abcdef01234567',
      completedAt: '2026-08-10T00:00:00.000Z',
      canApply: true,
      packageCount: 440,
      conflictCount: 12,
      autoRepairableGroupCount: 1,
      autoRepairablePackageCount: 2,
      manualMergeGroupCount: 3,
      preservedGroupCount: 8
    })

    const raw = fs.readFileSync(filePath, 'utf8')
    expect(raw).not.toContain(libraryRoot)
    expect(raw).not.toContain('private-library-name')
    expect(raw).not.toContain('canApply')
    expect(JSON.parse(raw)).toMatchObject({
      schemaVersion: 1,
      plannerRevision: 1,
      writeGeneration: 42,
      libraryRootHash: expect.stringMatching(/^[0-9a-f]{64}$/)
    })
    expect(readDuplicateRecoverySummaryCache(filePath, libraryRoot)).toMatchObject({
      autoRepairablePackageCount: 2,
      completedAt: '2026-08-10T00:00:00.000Z',
      canApply: false
    })
    expect(readDuplicateRecoverySummaryCache(filePath, `${libraryRoot}-other`)).toBeNull()
  })
})
