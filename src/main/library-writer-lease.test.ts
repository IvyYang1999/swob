import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  acquireLibraryWriterLease,
  LibraryWriterBusyError,
  type LibraryWriterLeaseOptions
} from './library-writer-lease'
import { LibraryPathUnsafeError } from './library-path-safety'
import {
  readLibraryWriteGeneration,
  runWithLibraryWriter
} from './library-write-coordinator'

let root: string

const quiet = { eventSink: () => {} }

function leaseOptions(
  pid: number,
  processState: (candidatePid: number) => string | 'missing' | null,
  overrides: Partial<LibraryWriterLeaseOptions> = {}
): LibraryWriterLeaseOptions {
  return {
    pid,
    bootIdentity: () => 'boot-a',
    processStartFingerprint: processState,
    eventSink: () => {},
    ...overrides
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-library-writer-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('Library 跨进程单写者 lease', () => {
  it('同一 Library 的两个实例串行执行，不受各自 userData 影响', async () => {
    const order: string[] = []
    let enterFirst!: () => void
    let releaseFirst!: () => void
    const firstEntered = new Promise<void>((resolve) => { enterFirst = resolve })
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })

    const first = runWithLibraryWriter(root, 'same-install', 'maintenance', async () => {
      order.push('gui-start')
      enterFirst()
      await firstGate
      order.push('gui-end')
    }, { ...quiet, timeoutMs: 500 })
    await firstEntered

    const second = runWithLibraryWriter(root, 'same-install', 'move', async () => {
      order.push('cli-move')
    }, { ...quiet, timeoutMs: 500, pollMs: 5 })

    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(order).toEqual(['gui-start'])
    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(['gui-start', 'gui-end', 'cli-move'])
    expect(readLibraryWriteGeneration(root)).toBe(2)
  })

  it('心跳延迟但原进程仍存活时绝不偷锁', async () => {
    const first = await acquireLibraryWriterLease(root, 'device-a', 'maintenance',
      leaseOptions(101, (pid) => pid === 101 ? 'start-101' : 'start-202', {
        leaseMs: 5,
        heartbeatMs: 1_000
      }))
    await new Promise((resolve) => setTimeout(resolve, 15))

    await expect(acquireLibraryWriterLease(root, 'device-a', 'move',
      leaseOptions(202, (pid) => pid === 101 ? 'start-101' : 'start-202', {
        timeoutMs: 5,
        pollMs: 1
      }))).rejects.toMatchObject({ code: 'LIBRARY_WRITER_BUSY', reason: 'active-owner' })
    first.release()
  })

  it('只回收已过期且能证明原进程死亡的本机 lease', async () => {
    const first = await acquireLibraryWriterLease(root, 'device-a', 'maintenance',
      leaseOptions(101, () => 'start-101', { leaseMs: 5, heartbeatMs: 1_000 }))
    await new Promise((resolve) => setTimeout(resolve, 15))

    const recovered = await acquireLibraryWriterLease(root, 'device-a', 'move',
      leaseOptions(202, (pid) => pid === 101 ? 'missing' : 'start-202', { timeoutMs: 50 }))
    first.release()
    expect(fs.existsSync(path.join(root, '.swob', 'locks', 'library-writer'))).toBe(true)
    recovered.release()
  })

  it('远端设备和不可解析 owner 都 fail closed，并返回 typed busy', async () => {
    const remote = await acquireLibraryWriterLease(root, 'device-a', 'maintenance',
      leaseOptions(101, () => 'start-101', { leaseMs: 5, heartbeatMs: 1_000 }))
    await new Promise((resolve) => setTimeout(resolve, 15))
    const remoteError = await acquireLibraryWriterLease(root, 'device-b', 'move',
      leaseOptions(202, () => 'start-202', { timeoutMs: 5, pollMs: 1 }))
      .then(() => null, (error) => error)
    expect(remoteError).toBeInstanceOf(LibraryWriterBusyError)
    expect(remoteError).toMatchObject({ reason: 'remote-owner' })
    remote.release()

    const lockDir = path.join(root, '.swob', 'locks', 'library-writer')
    fs.mkdirSync(lockDir, { recursive: true })
    fs.writeFileSync(path.join(lockDir, 'broken.owner.json'), '{broken')
    await expect(acquireLibraryWriterLease(root, 'device-a', 'move',
      leaseOptions(202, () => 'start-202', { timeoutMs: 5, pollMs: 1 })))
      .rejects.toMatchObject({ reason: 'unverifiable-owner' })
  })

  it('墙钟前跳或后退都不会偷走仍存活 owner，且等待由单调时钟限时', async () => {
    let wallNow = Date.parse('2026-07-22T00:00:00.000Z')
    const first = await acquireLibraryWriterLease(root, 'device-a', 'maintenance',
      leaseOptions(101, (pid) => pid === 101 ? 'start-101' : 'start-202', {
        now: () => wallNow,
        leaseMs: 5,
        heartbeatMs: 1_000
      }))

    wallNow += 365 * 24 * 60 * 60 * 1_000
    await expect(acquireLibraryWriterLease(root, 'device-a', 'move',
      leaseOptions(202, (pid) => pid === 101 ? 'start-101' : 'start-202', {
        now: () => wallNow,
        timeoutMs: 5,
        pollMs: 1
      }))).rejects.toMatchObject({ reason: 'active-owner' })

    wallNow = Date.parse('2000-01-01T00:00:00.000Z')
    await expect(acquireLibraryWriterLease(root, 'device-a', 'move',
      leaseOptions(202, (pid) => pid === 101 ? 'start-101' : 'start-202', {
        now: () => wallNow,
        timeoutMs: 5,
        pollMs: 1
      }))).rejects.toMatchObject({ reason: 'active-owner' })
    first.release()
  })

  it('锁目录祖先是符号链接时拒绝写入 Library 外部', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-library-writer-outside-'))
    try {
      fs.mkdirSync(path.join(root, '.swob'))
      fs.symlinkSync(outside, path.join(root, '.swob', 'locks'), process.platform === 'win32' ? 'junction' : 'dir')
      await expect(acquireLibraryWriterLease(root, 'device-a', 'move',
        leaseOptions(202, () => 'start-202', { timeoutMs: 5 })))
        .rejects.toBeInstanceOf(LibraryPathUnsafeError)
      expect(fs.readdirSync(outside)).toEqual([])
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('operation 抛错也先持久化 generation，拒绝复用旧扫描', async () => {
    await expect(runWithLibraryWriter(root, 'device-a', 'metadata', () => {
      throw new Error('synthetic-crash-before-result')
    }, quiet)).rejects.toThrow('synthetic-crash-before-result')
    expect(readLibraryWriteGeneration(root)).toBe(1)
  })
})
