import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildSessionLineageRegistryFromClaudeFiles,
  getSessionLineagePath,
  writeSessionLineageRegistry
} from './session-lineage'

const tmpRoots: string[] = []

function makeTmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-lineage-'))
  tmpRoots.push(root)
  return root
}

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function writeJsonl(root: string, sessionId: string, rows: unknown[]): string {
  const filePath = path.join(root, `${sessionId}.jsonl`)
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf-8')
  return filePath
}

function message(
  sessionId: string,
  uuid: string,
  parentUuid: string | null,
  timestamp: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    parentUuid,
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content: `prompt ${uuid}` },
    uuid,
    timestamp,
    userType: 'external',
    entrypoint: 'cli',
    cwd: '/tmp/project',
    sessionId,
    version: 'test',
    ...overrides
  }
}

describe('session-lineage', () => {
  it('【血统】有共享 uuid 与 parentUuid 续链时把旧 id 指向新 id', async () => {
    const root = makeTmpRoot()
    const oldId = '99999999-1111-4111-8111-111111111111'
    const newId = '22222222-2222-4222-8222-222222222222'
    const oldFile = writeJsonl(root, oldId, [
      { type: 'mode', sessionId: oldId },
      message(oldId, 'u1', null, '2026-07-09T10:00:00.000Z'),
      message(oldId, 'u2', 'u1', '2026-07-09T10:01:00.000Z')
    ])
    const newFile = writeJsonl(root, newId, [
      { type: 'mode', sessionId: newId },
      message(newId, 'u1', null, '2026-07-09T10:00:00.000Z'),
      message(newId, 'u2', 'u1', '2026-07-09T10:01:00.000Z'),
      message(newId, 'u3', 'u2', '2026-07-09T10:02:00.000Z')
    ])

    const registry = await buildSessionLineageRegistryFromClaudeFiles([oldFile, newFile], {
      libraryRoot: root,
      generatedAt: '2026-07-09T10:03:00.000Z'
    })

    expect(registry.aliases[oldId]).toBe(newId)
    expect(registry.sessions[oldId]).toMatchObject({
      rootSessionId: oldId,
      latestResumeId: newId,
      isAlias: true
    })
    expect(registry.latestByRoot[oldId]).toBe(newId)
    expect(registry.relations[0]).toMatchObject({
      from: oldId,
      to: newId,
      evidence: {
        type: 'uuid-parent-chain',
        overlapCount: 2,
        parentUuid: 'u2',
        childFirstNewUuid: 'u3'
      }
    })
  })

  it('【血统】只有 cwd 和时间线相近但无结构链时不硬连', async () => {
    const root = makeTmpRoot()
    const oldId = '33333333-3333-4333-8333-333333333333'
    const newId = '44444444-4444-4444-8444-444444444444'
    const oldFile = writeJsonl(root, oldId, [
      message(oldId, 'old-1', null, '2026-07-09T10:00:00.000Z'),
      message(oldId, 'old-2', 'old-1', '2026-07-09T10:01:00.000Z')
    ])
    const newFile = writeJsonl(root, newId, [
      message(newId, 'new-1', null, '2026-07-09T10:01:30.000Z'),
      message(newId, 'new-2', 'new-1', '2026-07-09T10:02:00.000Z')
    ])

    const registry = await buildSessionLineageRegistryFromClaudeFiles([oldFile, newFile], {
      libraryRoot: root,
      generatedAt: '2026-07-09T10:03:00.000Z'
    })

    expect(registry.aliases).toEqual({})
    expect(registry.latestByRoot[oldId]).toBe(oldId)
    expect(registry.latestByRoot[newId]).toBe(newId)
  })

  it('【血统】forkedFrom 出现在新 tail 时不把分支当转世', async () => {
    const root = makeTmpRoot()
    const oldId = '55555555-5555-4555-8555-555555555555'
    const forkId = '66666666-6666-4666-8666-666666666666'
    const oldFile = writeJsonl(root, oldId, [
      message(oldId, 'u1', null, '2026-07-09T10:00:00.000Z'),
      message(oldId, 'u2', 'u1', '2026-07-09T10:01:00.000Z')
    ])
    const forkFile = writeJsonl(root, forkId, [
      message(forkId, 'u1', null, '2026-07-09T10:00:00.000Z'),
      message(forkId, 'u2', 'u1', '2026-07-09T10:01:00.000Z'),
      message(forkId, 'u3', 'u2', '2026-07-09T10:02:00.000Z', {
        forkedFrom: { sessionId: oldId, messageUuid: 'u2' }
      })
    ])

    const registry = await buildSessionLineageRegistryFromClaudeFiles([oldFile, forkFile], {
      libraryRoot: root,
      generatedAt: '2026-07-09T10:03:00.000Z'
    })

    expect(registry.aliases).toEqual({})
  })

  it('【血统】forkedFrom 出现在 child 非首个新行时也不把 fork 当转世', async () => {
    const root = makeTmpRoot()
    const oldId = '51515151-5151-4515-8515-515151515151'
    const forkId = '61616161-6161-4616-8616-616161616161'
    const oldFile = writeJsonl(root, oldId, [
      message(oldId, 'u1', null, '2026-07-09T10:00:00.000Z'),
      message(oldId, 'u2', 'u1', '2026-07-09T10:01:00.000Z')
    ])
    const forkFile = writeJsonl(root, forkId, [
      message(forkId, 'u1', null, '2026-07-09T10:00:00.000Z'),
      message(forkId, 'u2', 'u1', '2026-07-09T10:01:00.000Z'),
      message(forkId, 'u3', 'u2', '2026-07-09T10:02:00.000Z'),
      message(forkId, 'u4', 'u3', '2026-07-09T10:03:00.000Z', {
        forkedFrom: { sessionId: oldId, messageUuid: 'u2' }
      })
    ])

    const registry = await buildSessionLineageRegistryFromClaudeFiles([oldFile, forkFile], {
      libraryRoot: root,
      generatedAt: '2026-07-09T10:04:00.000Z'
    })

    expect(registry.aliases).toEqual({})
    expect(registry.ambiguous).toEqual([])
  })

  it('【血统】任一侧 cwd 缺失时不连并进入 ambiguous', async () => {
    const root = makeTmpRoot()
    const oldId = '71717171-7171-4717-8717-717171717171'
    const newId = '81818181-8181-4818-8818-818181818181'
    const oldFile = writeJsonl(root, oldId, [
      message(oldId, 'u1', null, '2026-07-09T10:00:00.000Z', { cwd: undefined }),
      message(oldId, 'u2', 'u1', '2026-07-09T10:01:00.000Z', { cwd: undefined })
    ])
    const newFile = writeJsonl(root, newId, [
      message(newId, 'u1', null, '2026-07-09T10:00:00.000Z'),
      message(newId, 'u2', 'u1', '2026-07-09T10:01:00.000Z'),
      message(newId, 'u3', 'u2', '2026-07-09T10:02:00.000Z')
    ])

    const registry = await buildSessionLineageRegistryFromClaudeFiles([oldFile, newFile], {
      libraryRoot: root,
      generatedAt: '2026-07-09T10:03:00.000Z'
    })

    expect(registry.aliases).toEqual({})
    expect(registry.ambiguous).toEqual([
      {
        sessionId: oldId,
        reason: 'missing-cwd-cannot-confirm-lineage',
        candidates: [
          {
            sessionId: newId,
            updatedAt: '2026-07-09T10:02:00.000Z',
            overlapCount: 2,
            parentCoverage: 1
          }
        ]
      }
    ])
  })

  it('【血统】多个无关 parent 命中同一 child 时进入 ambiguous 而不是 aliases', async () => {
    const root = makeTmpRoot()
    const parentA = '91919191-9191-4919-8919-919191919191'
    const parentB = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1'
    const childId = 'b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2'
    const fileA = writeJsonl(root, parentA, [
      message(parentA, 'shared', null, '2026-07-09T10:00:00.000Z'),
      message(parentA, 'a-tail', 'shared', '2026-07-09T10:01:00.000Z')
    ])
    const fileB = writeJsonl(root, parentB, [
      message(parentB, 'shared', null, '2026-07-09T10:00:00.000Z'),
      message(parentB, 'b-tail', 'shared', '2026-07-09T10:01:00.000Z')
    ])
    const childFile = writeJsonl(root, childId, [
      message(childId, 'shared', null, '2026-07-09T10:00:00.000Z'),
      message(childId, 'a-tail', 'shared', '2026-07-09T10:01:00.000Z'),
      message(childId, 'b-tail', 'a-tail', '2026-07-09T10:02:00.000Z'),
      message(childId, 'child-tail', 'b-tail', '2026-07-09T10:03:00.000Z')
    ])

    const registry = await buildSessionLineageRegistryFromClaudeFiles([fileA, fileB, childFile], {
      libraryRoot: root,
      generatedAt: '2026-07-09T10:04:00.000Z'
    })

    expect(registry.aliases).toEqual({})
    expect(registry.relations).toEqual([])
    expect(registry.ambiguous).toEqual([
      {
        sessionId: childId,
        reason: 'multiple-unrelated-lineage-parents',
        candidates: [
          {
            sessionId: parentA,
            updatedAt: '2026-07-09T10:01:00.000Z',
            overlapCount: 2,
            parentCoverage: 1
          },
          {
            sessionId: parentB,
            updatedAt: '2026-07-09T10:01:00.000Z',
            overlapCount: 2,
            parentCoverage: 1
          }
        ]
      }
    ])
  })

  it('【血统】合法多跳转世链里多个 parent 指向最新 child 时不误判 ambiguous', async () => {
    const root = makeTmpRoot()
    const firstId = 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3'
    const secondId = 'd4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4'
    const latestId = 'e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e5e5'
    const firstFile = writeJsonl(root, firstId, [
      message(firstId, 'u1', null, '2026-07-09T10:00:00.000Z'),
      message(firstId, 'u2', 'u1', '2026-07-09T10:01:00.000Z')
    ])
    const secondFile = writeJsonl(root, secondId, [
      message(secondId, 'u1', null, '2026-07-09T10:00:00.000Z'),
      message(secondId, 'u2', 'u1', '2026-07-09T10:01:00.000Z'),
      message(secondId, 'u3', 'u2', '2026-07-09T10:02:00.000Z')
    ])
    const latestFile = writeJsonl(root, latestId, [
      message(latestId, 'u1', null, '2026-07-09T10:00:00.000Z'),
      message(latestId, 'u2', 'u1', '2026-07-09T10:01:00.000Z'),
      message(latestId, 'u3', 'u2', '2026-07-09T10:02:00.000Z'),
      message(latestId, 'u4', 'u3', '2026-07-09T10:03:00.000Z')
    ])

    const registry = await buildSessionLineageRegistryFromClaudeFiles([firstFile, secondFile, latestFile], {
      libraryRoot: root,
      generatedAt: '2026-07-09T10:04:00.000Z'
    })

    expect(registry.aliases[firstId]).toBe(latestId)
    expect(registry.aliases[secondId]).toBe(latestId)
    expect(registry.ambiguous).toEqual([])
  })

  it('【血统】注册表写入 Library 根的格式稳定', async () => {
    const root = makeTmpRoot()
    const oldId = '77777777-7777-4777-8777-777777777777'
    const newId = '88888888-8888-4888-8888-888888888888'
    const oldFile = writeJsonl(root, oldId, [
      message(oldId, 'u1', null, '2026-07-09T10:00:00.000Z'),
      message(oldId, 'u2', 'u1', '2026-07-09T10:01:00.000Z')
    ])
    const newFile = writeJsonl(root, newId, [
      message(newId, 'u1', null, '2026-07-09T10:00:00.000Z'),
      message(newId, 'u2', 'u1', '2026-07-09T10:01:00.000Z'),
      message(newId, 'u3', 'u2', '2026-07-09T10:02:00.000Z')
    ])

    const registry = await buildSessionLineageRegistryFromClaudeFiles([oldFile, newFile], {
      libraryRoot: root,
      generatedAt: '2026-07-09T10:03:00.000Z'
    })
    const registryPath = getSessionLineagePath(root)
    writeSessionLineageRegistry(registry, registryPath)
    const written = JSON.parse(fs.readFileSync(registryPath, 'utf-8'))

    expect(path.basename(registryPath)).toBe('.session-lineage.json')
    expect(written).toMatchObject({
      version: 1,
      generatedAt: '2026-07-09T10:03:00.000Z',
      libraryRoot: root,
      aliases: { [oldId]: newId },
      latestByRoot: { [oldId]: newId }
    })
    expect(written.sessions[oldId].latestResumeId).toBe(newId)
  })
})
