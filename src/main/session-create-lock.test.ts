import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import {
  acquireSessionCreateLock,
  recoverStaleSessionCreateLocks,
  SessionCreateBusyError,
  SessionCreateIdentityUnavailableError
} from './session-create-lock'
import { LibraryPathUnsafeError } from './library-path-safety'
import type { LogicalSessionKey } from './library-session-identity'

const roots: string[] = []
const key = 'v1\0claude-code\0default\0default\0secret-session-id' as LogicalSessionKey

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-create-lock-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('session create lock', () => {
  it.each([
    { bootIdentity: (): string | null => null, processStartFingerprint: (): string | null => 'start-a' },
    { bootIdentity: (): string | null => 'boot-a', processStartFingerprint: (): string | null => null }
  ])('fails identity probing before creating the lock tree', async (identity) => {
    const root = tempRoot()
    const error = await acquireSessionCreateLock(root, key, 'device-a', identity)
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(SessionCreateIdentityUnavailableError)
    expect(error).toMatchObject({ code: 'WRITER_IDENTITY_UNAVAILABLE' })
    expect(fs.existsSync(path.join(root, '.swob', 'locks'))).toBe(false)
  })

  it('uses only a hash in the lock filename', async () => {
    const handle = await acquireSessionCreateLock(tempRoot(), key, 'device-a', {
      bootIdentity: () => 'boot-a',
      processStartFingerprint: () => 'start-a'
    })
    expect(path.basename(handle.lockPath)).toMatch(/^[0-9a-f]{64}\.lock$/)
    expect(handle.lockPath).not.toContain('secret-session-id')
    handle.release()
  })

  it('atomically reclaims an empty lock directory after the protocol grace period', async () => {
    const root = tempRoot()
    const lockDir = path.join(root, '.swob', 'locks', 'session-create')
    const emptyKey = 'v1\0claude-code\0default\0default\0empty' as LogicalSessionKey
    const lockPath = path.join(lockDir, createHash('sha256').update(emptyKey).digest('hex') + '.lock')
    fs.mkdirSync(lockPath, { recursive: true })
    const staleAt = new Date(Date.now() - 60_000)
    fs.utimesSync(lockPath, staleAt, staleAt)
    const handle = await acquireSessionCreateLock(
      root,
      emptyKey,
      'device-a',
      {
        // Generous bound: under parallel vitest workers the reclaim sequence
        // (readdir+stat+rmdir+mkdir+link) can exceed a few milliseconds, which
        // made a 5ms budget flake under load. The assertion is about reclaim
        // behavior, not latency.
        timeoutMs: 2_000,
        pollMs: 10,
        bootIdentity: () => 'boot-a',
        processStartFingerprint: () => 'start-a'
      }
    )
    handle.release()
    expect(fs.existsSync(lockPath)).toBe(false)
  })

  it('preserves a fresh empty directory during the mkdir-to-owner protocol window', () => {
    const root = tempRoot()
    const lockPath = path.join(root, '.swob', 'locks', 'session-create', 'c'.repeat(64) + '.lock')
    fs.mkdirSync(lockPath, { recursive: true })

    expect(recoverStaleSessionCreateLocks(root, 'device-a', {
      bootIdentity: () => 'boot-a',
      processStartFingerprint: () => 'missing'
    })).toEqual({ examined: 1, recovered: 0, preserved: 1 })
    expect(fs.existsSync(lockPath)).toBe(true)
  })

  it('sweeps empty and proven-dead local locks while preserving remote and malformed evidence', async () => {
    const root = tempRoot()
    const deadKey = 'v1\0claude-code\0default\0default\0dead' as LogicalSessionKey
    const remoteKey = 'v1\0claude-code\0default\0default\0remote' as LogicalSessionKey
    const dead = await acquireSessionCreateLock(root, deadKey, 'device-a', {
      pid: 701,
      bootIdentity: () => 'boot-a',
      processStartFingerprint: () => 'dead-start'
    })
    const remote = await acquireSessionCreateLock(root, remoteKey, 'remote-device', {
      pid: 702,
      bootIdentity: () => 'boot-a',
      processStartFingerprint: () => 'remote-start'
    })
    const lockDir = path.dirname(dead.lockPath)
    const emptyPath = path.join(lockDir, 'e'.repeat(64) + '.lock')
    const malformedPath = path.join(lockDir, 'd'.repeat(64) + '.lock')
    fs.mkdirSync(emptyPath)
    const staleAt = new Date(Date.now() - 60_000)
    fs.utimesSync(emptyPath, staleAt, staleAt)
    fs.mkdirSync(malformedPath)
    fs.writeFileSync(path.join(malformedPath, 'broken.owner.json'), '{')

    const result = recoverStaleSessionCreateLocks(root, 'device-a', {
      bootIdentity: () => 'boot-a',
      processStartFingerprint: (pid) => pid === 701 ? 'missing' : 'remote-start'
    })

    expect(result).toEqual({ examined: 4, recovered: 2, preserved: 2 })
    expect(fs.existsSync(dead.lockPath)).toBe(false)
    expect(fs.existsSync(emptyPath)).toBe(false)
    expect(fs.existsSync(remote.lockPath)).toBe(true)
    expect(fs.existsSync(malformedPath)).toBe(true)
    dead.release()
    remote.release()
  })

  it('recovers only an expired same-device owner proven dead', async () => {
    const root = tempRoot()
    const first = await acquireSessionCreateLock(root, key, 'device-a', {
      pid: 101,
      leaseMs: -1,
      bootIdentity: () => 'boot-a',
      processStartFingerprint: () => 'start-old'
    })
    const second = await acquireSessionCreateLock(root, key, 'device-a', {
      pid: 202,
      bootIdentity: () => 'boot-a',
      processStartFingerprint: (pid) => pid === 101 ? 'missing' : 'start-new'
    })
    expect(second.owner.ownerNonce).not.toBe(first.owner.ownerNonce)
    first.release()
    expect(fs.existsSync(second.lockPath)).toBe(true)
    second.release()
  })

  it('does not reclaim a remote, live, or unverifiable owner merely because time passed', async () => {
    for (const scenario of ['remote', 'live', 'unverifiable'] as const) {
      const root = tempRoot()
      const first = await acquireSessionCreateLock(root, key, scenario === 'remote' ? 'remote-device' : 'device-a', {
        pid: 301,
        leaseMs: -1,
        bootIdentity: () => 'boot-a',
        processStartFingerprint: () => 'start-old'
      })
      const attempt = acquireSessionCreateLock(root, key, 'device-a', {
        pid: 302,
        timeoutMs: 5,
        pollMs: 1,
        bootIdentity: () => 'boot-a',
        processStartFingerprint: (pid) => {
          if (pid === 302) return 'start-new'
          if (scenario === 'unverifiable') return null
          return 'start-old'
        }
      })
      await expect(attempt).rejects.toBeInstanceOf(SessionCreateBusyError)
      first.release()
    }
  })

  it('never removes a replacement owner during release', async () => {
    const root = tempRoot()
    const first = await acquireSessionCreateLock(root, key, 'device-a', {
      bootIdentity: () => 'boot-a',
      processStartFingerprint: () => 'start-a'
    })
    const oldOwnerPath = path.join(first.lockPath, `${first.owner.ownerNonce}.owner.json`)
    fs.unlinkSync(oldOwnerPath)
    const replacementPath = path.join(first.lockPath, 'replacement.owner.json')
    fs.writeFileSync(replacementPath, JSON.stringify({ ...first.owner, ownerNonce: 'replacement' }))

    first.release()
    expect(fs.existsSync(replacementPath)).toBe(true)
  })

  it('uses process identity instead of wall clock when time jumps', async () => {
    const root = tempRoot()
    const first = await acquireSessionCreateLock(root, key, 'device-a', {
      pid: 401,
      now: () => 10_000,
      leaseMs: 1,
      bootIdentity: () => 'boot-a',
      processStartFingerprint: () => 'start-live'
    })
    await expect(acquireSessionCreateLock(root, key, 'device-a', {
      pid: 402,
      now: (() => { let value = 10 ** 12; return () => value++ })(),
      timeoutMs: 2,
      pollMs: 1,
      bootIdentity: () => 'boot-a',
      processStartFingerprint: (pid) => pid === 401 ? 'start-live' : 'start-new'
    })).rejects.toBeInstanceOf(SessionCreateBusyError)
    first.release()
  })

  it('recovers PID reuse and prior-boot owners but fails closed on truncated owner data', async () => {
    for (const scenario of ['pid-reuse', 'prior-boot'] as const) {
      const root = tempRoot()
      const first = await acquireSessionCreateLock(root, key, 'device-a', {
        pid: 501,
        bootIdentity: () => 'boot-old',
        processStartFingerprint: () => 'start-old'
      })
      const second = await acquireSessionCreateLock(root, key, 'device-a', {
        pid: 502,
        bootIdentity: () => scenario === 'prior-boot' ? 'boot-new' : 'boot-old',
        processStartFingerprint: (pid) => pid === 501 ? 'start-reused' : 'start-new'
      })
      expect(second.owner.ownerNonce).not.toBe(first.owner.ownerNonce)
      first.release()
      second.release()
    }

    const root = tempRoot()
    const owner = await acquireSessionCreateLock(root, key, 'device-a', {
      bootIdentity: () => 'boot-a',
      processStartFingerprint: () => 'start-a'
    })
    fs.writeFileSync(path.join(owner.lockPath, `${owner.owner.ownerNonce}.owner.json`), '{')
    await expect(acquireSessionCreateLock(root, key, 'device-a', {
      timeoutMs: 2,
      pollMs: 1,
      bootIdentity: () => 'boot-a',
      processStartFingerprint: () => 'start-b'
    })).rejects.toBeInstanceOf(SessionCreateBusyError)
    owner.release()
  })

  it('rejects a symlink in the lock directory ancestry before writing outside', async () => {
    const root = tempRoot()
    const external = tempRoot()
    fs.symlinkSync(external, path.join(root, '.swob'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(acquireSessionCreateLock(root, key, 'device-a', {
      bootIdentity: () => 'boot-a',
      processStartFingerprint: () => 'start-a'
    })).rejects.toBeInstanceOf(LibraryPathUnsafeError)
    expect(fs.readdirSync(external)).toEqual([])
  })
})
