import { describe, expect, it } from 'vitest'
import { collapseLibrarySessionsByLogicalKey, type LibrarySession, type SessionMeta } from './library-manager'

function packageFixture(
  dirPath: string,
  sessionId: string,
  updatedAt: string,
  sourcePath: string,
  isSymlink = false
): LibrarySession {
  const meta: SessionMeta = {
    sessionId,
    sourceFilePaths: [sourcePath],
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt,
    projectPath: '/repo'
  }
  return {
    sessionId,
    dirPath,
    mdPath: `${dirPath}/transcript.md`,
    jsonlPath: `${dirPath}/backup.jsonl`,
    meta,
    isSymlink
  }
}

describe('collapseLibrarySessionsByLogicalKey', () => {
  it('folds only identical LogicalSessionKey packages to the newest manifest', () => {
    const older = packageFixture(
      '/library/older',
      'same-session',
      '2026-07-20T00:00:00.000Z',
      '/Users/test/.claude/projects/repo/same-session.jsonl'
    )
    const newer = packageFixture(
      '/library/newer',
      'same-session',
      '2026-07-22T00:00:00.000Z',
      '/Users/test/.claude/projects/repo/same-session.jsonl'
    )
    const unrelated = packageFixture(
      '/library/unrelated',
      'same-title-is-not-identity',
      '2026-07-23T00:00:00.000Z',
      '/Users/test/.claude/projects/repo/same-title-is-not-identity.jsonl'
    )

    const result = collapseLibrarySessionsByLogicalKey([older, unrelated, newer])

    expect(result).toHaveLength(2)
    expect(result.find((item) => item.sessionId === 'same-session')).toMatchObject({
      dirPath: '/library/newer',
      duplicate: true,
      duplicatePackageCount: 2
    })
    expect(result.find((item) => item.sessionId === 'same-title-is-not-identity')).toMatchObject({
      duplicate: false,
      duplicatePackageCount: 1
    })
  })

  it('does not mislabel a package and its folder-view symlink as duplicates', () => {
    const canonical = packageFixture(
      '/library/canonical',
      'linked-session',
      '2026-07-22T00:00:00.000Z',
      '/Users/test/.claude/projects/repo/linked-session.jsonl'
    )
    canonical.meta.packageId = 'same-immutable-package'
    const linkedView = {
      ...canonical,
      dirPath: '/library/folder-view',
      isSymlink: true,
      meta: { ...canonical.meta }
    }

    expect(collapseLibrarySessionsByLogicalKey([linkedView, canonical])).toEqual([
      expect.objectContaining({
        dirPath: '/library/canonical',
        duplicate: false,
        duplicatePackageCount: 1
      })
    ])
  })
})
