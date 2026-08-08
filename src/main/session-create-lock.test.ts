import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  acquireSessionCreateLock,
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
