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
      preservedGroupCount: 8,
      privatePath: '/private/secret-library/session',
      privateText: 'never persist this transcript'
    } as any)

    const raw = fs.readFileSync(filePath, 'utf8')
    expect(raw).not.toContain(libraryRoot)
    expect(raw).not.toContain('private-library-name')
    expect(raw).not.toContain('canApply')
    expect(raw).not.toContain('privatePath')
    expect(raw).not.toContain('never persist this transcript')
    expect(JSON.parse(raw)).toMatchObject({
      schemaVersion: 1,
      plannerRevision: 1,
      writeGeneration: 42,
      libraryRootHash: expect.stringMatching(/^[0-9a-f]{64}$/)
    })
    const cached = readDuplicateRecoverySummaryCache(filePath, libraryRoot)
    expect(cached).toMatchObject({
      autoRepairablePackageCount: 2,
      completedAt: '2026-08-10T00:00:00.000Z',
      canApply: false
    })
    expect(cached).not.toHaveProperty('privatePath')
    expect(readDuplicateRecoverySummaryCache(filePath, `${libraryRoot}-other`)).toBeNull()
  })

  it('drops unknown fields from a tampered cache before the renderer IPC boundary', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-duplicate-summary-tampered-'))
    roots.push(root)
    const libraryRoot = path.join(root, 'library')
    const filePath = path.join(root, 'diagnostics', 'summary.json')
    writeDuplicateRecoverySummaryCache(filePath, libraryRoot, 7, {
      schemaVersion: 1,
      planId: 'plan:0123456789abcdef01234567',
      completedAt: '2026-08-10T00:00:00.000Z',
      canApply: false,
      packageCount: 1,
      conflictCount: 1,
      autoRepairableGroupCount: 0,
      autoRepairablePackageCount: 0,
      manualMergeGroupCount: 1,
      preservedGroupCount: 0
    })
    const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    persisted.summary.privatePath = '/private/secret-library/session'
    persisted.summary.privateText = 'never cross IPC'
    fs.writeFileSync(filePath, JSON.stringify(persisted))

    const cached = readDuplicateRecoverySummaryCache(filePath, libraryRoot) as any
    expect(cached.privatePath).toBeUndefined()
    expect(cached.privateText).toBeUndefined()
  })
})
