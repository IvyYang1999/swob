import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  formatResolveCliOutput,
  resolveSessionId,
  resolveSessionIdFromRegistry
} from './resolve-command'
import {
  getSessionLineagePath,
  type SessionLineageRegistry,
  writeSessionLineageRegistry
} from '../main/session-lineage'

const oldId = '932a47c4-e021-4cbc-826f-debe943d0517'
const latestId = '8ef78213-1111-4abc-9111-123456789abc'

function sessionEntry(sessionId: string, rootSessionId: string, latestResumeId: string, isAlias: boolean) {
  return {
    sessionId,
    rootSessionId,
    latestResumeId,
    isAlias,
    source: 'claude-code' as const,
    createdAt: '2026-07-09T10:00:00.000Z',
    updatedAt: isAlias ? '2026-07-09T10:00:00.000Z' : '2026-07-09T10:05:00.000Z'
  }
}

function makeRegistry(libraryRoot: string, aliases: Record<string, string> = { [oldId]: latestId }): SessionLineageRegistry {
  const sessions: SessionLineageRegistry['sessions'] = {}
  const latestByRoot: SessionLineageRegistry['latestByRoot'] = {}

  for (const [aliasId, resolvedId] of Object.entries(aliases)) {
    sessions[aliasId] = sessionEntry(aliasId, aliasId, resolvedId, true)
    sessions[resolvedId] = sessionEntry(resolvedId, aliasId, resolvedId, false)
    latestByRoot[aliasId] = resolvedId
  }

  return {
    version: 1,
    generatedAt: '2026-07-09T10:10:00.000Z',
    libraryRoot,
    aliases,
    latestByRoot,
    sessions,
    relations: [],
    ambiguous: []
  }
}

function writeRegistry(libraryRoot: string, registry = makeRegistry(libraryRoot)): void {
  writeSessionLineageRegistry(registry, getSessionLineagePath(libraryRoot))
}

describe('CLI resolve', () => {
  let tmpRoot: string

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-resolve-'))
  })

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('完整旧 id 解析到真身 latest 完整 id', () => {
    writeRegistry(tmpRoot)

    const result = resolveSessionId(oldId, tmpRoot)

    expect(result).toMatchObject({ input: oldId, resolved: latestId, matched: true })
  })

  it('短 id 解析到真身 latest 完整 id', () => {
    writeRegistry(tmpRoot)

    const result = resolveSessionId('932a47c4', tmpRoot)

    expect(result).toMatchObject({ input: '932a47c4', resolved: latestId, matched: true })
  })

  it('输入已是真身 id 时回显真身完整 id', () => {
    writeRegistry(tmpRoot)

    const result = resolveSessionId(latestId, tmpRoot)

    expect(result).toMatchObject({ input: latestId, resolved: latestId, matched: true })
  })

  it('输入不在注册表里时原样回显', () => {
    writeRegistry(tmpRoot)

    const result = resolveSessionId('totally-unknown-999', tmpRoot)

    expect(result).toEqual({
      input: 'totally-unknown-999',
      resolved: 'totally-unknown-999',
      matched: false
    })
  })

  it('注册表不存在时原样回显且不崩', () => {
    const result = resolveSessionId('932a47c4', tmpRoot)

    expect(result).toEqual({
      input: '932a47c4',
      resolved: '932a47c4',
      matched: false
    })
  })

  it('短 id 前缀歧义时原样回显并把提示写到 stderr 输出', () => {
    const registry = makeRegistry(tmpRoot, {
      'abcd1230-0000-4000-8000-000000000000': '11111111-1111-4111-8111-111111111111',
      'abcd1231-0000-4000-8000-000000000000': '22222222-2222-4222-8222-222222222222'
    })

    const result = resolveSessionIdFromRegistry('abcd123', registry)
    const output = formatResolveCliOutput(result)

    expect(result).toMatchObject({
      input: 'abcd123',
      resolved: 'abcd123',
      matched: false,
      ambiguous: true
    })
    expect(output.stdout).toBe('abcd123\n')
    expect(output.stderr).toContain('歧义')
    expect(output.stderr).toContain('abcd1230-0000-4000-8000-000000000000')
    expect(output.stderr).toContain('abcd1231-0000-4000-8000-000000000000')
  })

  it('--json 输出 input resolved matched 结构', () => {
    writeRegistry(tmpRoot)

    const result = resolveSessionId(oldId, tmpRoot)
    const output = formatResolveCliOutput(result, true)

    expect(JSON.parse(output.stdout)).toEqual({
      input: oldId,
      resolved: latestId,
      matched: true
    })
    expect(output.stderr).toBe('')
  })
})
