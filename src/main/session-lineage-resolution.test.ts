import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyLineageResolution,
  writeLineageResolution,
  type SessionLineageRegistry
} from './session-lineage'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function ambiguousRegistry(root: string): SessionLineageRegistry {
  return {
    version: 1,
    generatedAt: '2026-07-21T10:00:00.000Z',
    libraryRoot: root,
    aliases: {},
    latestByRoot: { parent: 'parent', child: 'child', other: 'other' },
    sessions: {
      parent: {
        sessionId: 'parent', rootSessionId: 'parent', latestResumeId: 'parent',
        isAlias: false, source: 'claude-code', createdAt: '2026-07-21T09:00:00.000Z', updatedAt: '2026-07-21T09:10:00.000Z'
      },
      other: {
        sessionId: 'other', rootSessionId: 'other', latestResumeId: 'other',
        isAlias: false, source: 'claude-code', createdAt: '2026-07-21T09:00:00.000Z', updatedAt: '2026-07-21T09:11:00.000Z'
      },
      child: {
        sessionId: 'child', rootSessionId: 'child', latestResumeId: 'child',
        isAlias: false, source: 'claude-code', createdAt: '2026-07-21T10:00:00.000Z', updatedAt: '2026-07-21T10:10:00.000Z'
      }
    },
    relations: [],
    broken: [],
    ambiguous: [{
      sessionId: 'child',
      reason: 'multiple-exact-lineage-parents',
      candidates: [
        { sessionId: 'parent', updatedAt: '', overlapCount: 0, parentCoverage: 0 },
        { sessionId: 'other', updatedAt: '', overlapCount: 0, parentCoverage: 0 }
      ]
    }],
    resolutions: []
  }
}

describe('lineage manual ambiguity resolution', () => {
  it('records an explicit decision, applies one manual edge, and is idempotent', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-lineage-resolution-'))
    roots.push(root)
    const input = {
      ambiguitySessionId: 'child',
      parentSessionId: 'parent',
      childSessionId: 'child',
      type: 'continuation' as const,
      decidedAt: '2026-07-21T11:00:00.000Z',
      note: 'confirmed from user evidence'
    }
    const once = applyLineageResolution(ambiguousRegistry(root), input)
    const twice = applyLineageResolution(once, input)

    expect(twice.ambiguous).toEqual([])
    expect(twice.relations).toEqual([expect.objectContaining({
      parent: 'parent',
      child: 'child',
      type: 'continuation',
      provenance: 'manual'
    })])
    expect(twice.resolutions).toHaveLength(1)
    expect(twice.aliases).toEqual({ parent: 'child' })
    expect(twice.latestByRoot).toEqual({ parent: 'child', other: 'other' })
  })

  it('atomically persists the decision and rejects a candidate not shown by the ambiguity', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-lineage-resolution-write-'))
    roots.push(root)
    const registryPath = path.join(root, '.session-lineage.json')
    fs.writeFileSync(registryPath, JSON.stringify(ambiguousRegistry(root)), 'utf-8')

    expect(() => writeLineageResolution(registryPath, {
      ambiguitySessionId: 'child',
      parentSessionId: 'missing',
      childSessionId: 'child',
      type: 'continuation',
      decidedAt: '2026-07-21T11:00:00.000Z'
    })).toThrow(/candidate|候选/i)

    const result = writeLineageResolution(registryPath, {
      ambiguitySessionId: 'child',
      parentSessionId: 'parent',
      childSessionId: 'child',
      type: 'continuation',
      decidedAt: '2026-07-21T11:00:00.000Z'
    })
    const disk = JSON.parse(fs.readFileSync(registryPath, 'utf-8'))
    expect(disk).toEqual(result)
    expect(disk.resolutions).toHaveLength(1)
  })

  it('refuses a symlinked registry instead of replacing or reading its target', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-lineage-resolution-link-'))
    roots.push(root)
    const targetPath = path.join(root, 'target.json')
    const registryPath = path.join(root, '.session-lineage.json')
    fs.writeFileSync(targetPath, JSON.stringify(ambiguousRegistry(root)), 'utf-8')
    fs.symlinkSync(targetPath, registryPath)

    expect(() => writeLineageResolution(registryPath, {
      ambiguitySessionId: 'child',
      parentSessionId: 'parent',
      childSessionId: 'child',
      type: 'continuation',
      decidedAt: '2026-07-21T11:00:00.000Z'
    })).toThrow(/regular file/i)
    expect(JSON.parse(fs.readFileSync(targetPath, 'utf-8')).resolutions).toEqual([])
  })
})
