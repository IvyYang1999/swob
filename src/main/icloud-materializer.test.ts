import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import {
  SINGLE_ID_OPTIONS,
  SIX_REPORTED_BACKUP_SHAPES
} from './__fixtures__/backup-validation-synthetic'
import {
  materializeICloudBackup,
  resolveICloudBackupPaths,
  type ICloudMaterializeAllowedResult,
  type ICloudMaterializeDefaultResult,
  type ICloudMaterializeResult,
  type ICloudMaterializerRuntime
} from './icloud-materializer'

const targetPath = '/fixture/library-xx…9001/session-xx…9001/backup.jsonl'
const placeholderPath = '/fixture/library-xx…9001/session-xx…9001/.backup.jsonl.icloud'
const completeContent = Buffer.from(SIX_REPORTED_BACKUP_SHAPES.currentlyStrictValidShort.content)
const legalPrefix = Buffer.from(completeContent.toString('utf8').split('\n')[0] + '\n')
const expected = {
  sha256: createHash('sha256').update(completeContent).digest('hex'),
  size: completeContent.length
}

function runtime(overrides: Partial<ICloudMaterializerRuntime> = {}): ICloudMaterializerRuntime {
  return {
    pathExists: async (filePath) => filePath === targetPath,
    readFile: async () => Buffer.from(completeContent),
    execFile: async () => undefined,
    delay: async () => undefined,
    ...overrides
  }
}

describe('iCloud backup materializer', () => {
  it('类型契约限定 ok:true 只能是 expected-metadata 强成功', () => {
    type StrongSuccess = Extract<ICloudMaterializeResult, { ok: true }>
    type DefaultUnverified = Extract<ICloudMaterializeDefaultResult, { state: 'unverified' }>
    type AllowedUnverified = Extract<ICloudMaterializeAllowedResult, { state: 'unverified' }>

    expectTypeOf<StrongSuccess['confidence']>().toEqualTypeOf<'expected-metadata'>()
    expectTypeOf<Extract<StrongSuccess, { confidence: 'prefix-unverifiable' }>>().toEqualTypeOf<never>()
    expectTypeOf<DefaultUnverified['content']>().toEqualTypeOf<undefined>()
    expectTypeOf<AllowedUnverified['content']>().toEqualTypeOf<Buffer>()
  })

  it('统一识别目标文件与同目录 .<name>.icloud placeholder', () => {
    expect(resolveICloudBackupPaths(targetPath)).toEqual({
      targetPath,
      placeholderPath,
      inputWasPlaceholder: false
    })
    expect(resolveICloudBackupPaths(placeholderPath)).toEqual({
      targetPath,
      placeholderPath,
      inputWasPlaceholder: true
    })
  })

  it('已完整物化时只读验证通过，不调用 brctl', async () => {
    const execFile = vi.fn(async () => undefined)
    const result = await materializeICloudBackup(targetPath, {
      expected,
      validation: SINGLE_ID_OPTIONS,
      runtime: runtime({ execFile })
    })

    expect(result).toMatchObject({ ok: true, state: 'already-materialized', pollAttempts: 0 })
    expect(execFile).not.toHaveBeenCalled()
  })

  it('合法 JSONL 前缀在 placeholder 仍存在时绝不判完成，且 brctl 使用参数数组', async () => {
    let placeholderExists = true
    let content = Buffer.from(legalPrefix)
    const execFile = vi.fn(async () => undefined)
    let delays = 0
    const result = await materializeICloudBackup(targetPath, {
      expected,
      maxPollAttempts: 3,
      initialPollDelayMs: 1,
      maxPollDelayMs: 2,
      validation: SINGLE_ID_OPTIONS,
      runtime: runtime({
        pathExists: async (filePath) => filePath === placeholderPath ? placeholderExists : filePath === targetPath,
        readFile: async () => Buffer.from(content),
        execFile,
        delay: async () => {
          delays++
          placeholderExists = false
          content = Buffer.from(completeContent)
        }
      })
    })

    expect(result).toMatchObject({ ok: true, state: 'materialized', pollAttempts: 2 })
    expect(delays).toBe(1)
    expect(execFile).toHaveBeenCalledWith('/usr/bin/brctl', ['download', placeholderPath])
  })

  it('placeholder 不消失时即使可读内容是严格合法前缀也超时', async () => {
    const result = await materializeICloudBackup(targetPath, {
      expected,
      maxPollAttempts: 2,
      initialPollDelayMs: 0,
      maxPollDelayMs: 0,
      validation: SINGLE_ID_OPTIONS,
      runtime: runtime({
        pathExists: async (filePath) => filePath === placeholderPath || filePath === targetPath,
        readFile: async () => Buffer.from(legalPrefix)
      })
    })

    expect(result).toMatchObject({
      ok: false,
      reason: 'timeout',
      pollAttempts: 2,
      diagnostic: expect.stringContaining('placeholder did not disappear')
    })
  })

  it('【验收点名】placeholder 已消失但内容只是严格合法前缀，有 expected 时仍拦截', async () => {
    const execFile = vi.fn(async () => undefined)
    const result = await materializeICloudBackup(targetPath, {
      expected,
      maxPollAttempts: 2,
      initialPollDelayMs: 0,
      maxPollDelayMs: 0,
      validation: SINGLE_ID_OPTIONS,
      runtime: runtime({
        readFile: async () => Buffer.from(legalPrefix),
        execFile
      })
    })

    expect(result).toMatchObject({
      ok: false,
      reason: 'timeout',
      diagnostic: expect.stringContaining('did not match expected')
    })
    expect(execFile).toHaveBeenCalledWith('/usr/bin/brctl', ['download', targetPath])
  })

  it('无 expected 且未允许降级时，只查 ok 的调用方拿不到 content', async () => {
    const execFile = vi.fn(async () => undefined)
    const result = await materializeICloudBackup(targetPath, {
      validation: SINGLE_ID_OPTIONS,
      runtime: runtime({
        readFile: async () => Buffer.from(legalPrefix),
        execFile
      })
    })
    const contentFromOkOnlyCaller = result.ok ? result.content : undefined

    expect(result).toMatchObject({
      ok: false,
      state: 'unverified',
      confidence: 'prefix-unverifiable',
      pollAttempts: 0
    })
    expect(result).not.toHaveProperty('content')
    expect(contentFromOkOnlyCaller).toBeUndefined()
    expect(execFile).not.toHaveBeenCalled()
  })

  it('无 expected 但显式 allowUnverified 时返回降级 content 与正确 confidence', async () => {
    const execFile = vi.fn(async () => undefined)
    const result = await materializeICloudBackup(targetPath, {
      allowUnverified: true,
      validation: SINGLE_ID_OPTIONS,
      runtime: runtime({
        readFile: async () => Buffer.from(legalPrefix),
        execFile
      })
    })

    expect(result).toMatchObject({
      ok: false,
      state: 'unverified',
      confidence: 'prefix-unverifiable',
      content: legalPrefix,
      pollAttempts: 0
    })
    expect(execFile).not.toHaveBeenCalled()
  })

  it('brctl 启动失败明确返回可重试错误', async () => {
    const result = await materializeICloudBackup(placeholderPath, {
      validation: SINGLE_ID_OPTIONS,
      runtime: runtime({
        pathExists: async (filePath) => filePath === placeholderPath,
        readFile: async () => { throw new Error('not materialized') },
        execFile: async () => { throw new Error('sandbox denied') }
      })
    })

    expect(result).toMatchObject({ ok: false, reason: 'brctl-failed', pollAttempts: 0 })
  })

  it('目标和 placeholder 均不存在时不调用系统下载', async () => {
    const execFile = vi.fn(async () => undefined)
    const result = await materializeICloudBackup(targetPath, {
      runtime: runtime({ pathExists: async () => false, execFile })
    })

    expect(result).toMatchObject({ ok: false, reason: 'not-found' })
    expect(execFile).not.toHaveBeenCalled()
  })
})
