import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  defaultHostIdentityPath,
  deriveLibraryHostProof,
  getOrCreateHostIdentity,
  HostIdentityError
} from './host-identity'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('stable host identity', () => {
  it('persists a random identity outside profiles and never derives it from hardware', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-host-identity-'))
    roots.push(root)
    const storagePath = path.join(root, 'machine', 'host-identity-v1.json')
    let generated = 0
    const first = getOrCreateHostIdentity({
      storagePath,
      randomId: () => {
        generated++
        return '10000000-0000-4000-8000-000000000001'
      },
      now: () => 1_700_000_000_000
    })
    const second = getOrCreateHostIdentity({
      storagePath,
      randomId: () => {
        generated++
        return '20000000-0000-4000-8000-000000000002'
      }
    })

    expect(second).toBe(first)
    expect(generated).toBe(1)
    expect(JSON.parse(fs.readFileSync(storagePath, 'utf8'))).toMatchObject({
      schemaVersion: 1,
      identity: first
    })
  })

  it('production storage path ignores HOME/profile changes and Library receives only a scoped proof', () => {
    const before = process.env.HOME
    process.env.HOME = '/tmp/profile-a'
    const firstPath = defaultHostIdentityPath('darwin')
    process.env.HOME = '/tmp/profile-b'
    const secondPath = defaultHostIdentityPath('darwin')
    if (before === undefined) delete process.env.HOME
    else process.env.HOME = before

    expect(firstPath).toBe('/Users/Shared/Swob/host-identity-v1.json')
    expect(secondPath).toBe(firstPath)
    const raw = '10000000-0000-4000-8000-000000000001'
    const proofA = deriveLibraryHostProof(raw, '10000000-0000-4000-8000-000000000010')
    const proofB = deriveLibraryHostProof(raw, '20000000-0000-4000-8000-000000000020')
    expect(proofA).toMatch(/^[0-9a-f]{64}$/)
    expect(proofA).not.toContain(raw)
    expect(proofB).not.toBe(proofA)
  })

  it('does not silently rotate corrupt identity evidence', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-host-identity-corrupt-'))
    roots.push(root)
    const storagePath = path.join(root, 'host-identity-v1.json')
    fs.writeFileSync(storagePath, '{broken')

    expect(() => getOrCreateHostIdentity({ storagePath }))
      .toThrowError(expect.objectContaining<Partial<HostIdentityError>>({
        code: 'HOST_IDENTITY_UNAVAILABLE', reason: 'corrupt'
      }))
    expect(fs.readFileSync(storagePath, 'utf8')).toBe('{broken')
  })
})
