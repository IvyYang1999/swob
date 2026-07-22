import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { acquireSessionCreateLock, SessionCreateBusyError } from './session-create-lock'
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
})

