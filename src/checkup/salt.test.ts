import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The hostname is mocked so the test can change it between calls and prove
// the salt does not depend on it (the network can rename a Mac at any time).
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, hostname: vi.fn(() => 'first-host.local') }
})

import * as os from 'node:os'
import {
  derivePrivacySalt,
  hostHash,
  machineIdentity,
  parseIoregPlatformUuid,
  parseLinuxMachineId,
  parseWindowsMachineGuid,
  readMachineIdentifier,
  saltFingerprint,
  saltFromMachineIdentity
} from './privacy'

// Never print identifiers or salts: every comparison below is reduced to a boolean.
const HEX64 = /^[0-9a-f]{64}$/

afterEach(() => {
  vi.mocked(os.hostname).mockReturnValue('first-host.local')
})

describe('checkup salt (machine identifier, never the hostname)', () => {
  it('parses the three platform identifiers from synthetic command/file output', () => {
    const ioreg = [
      '+-o Mac16,10  <class IOPlatformExpertDevice, id 0x100000000, registered, matched, active>',
      '    {',
      '      "IOPlatformSerialNumber" = "SYNTHETIC00"',
      '      "IOPlatformUUID" = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"',
      '    }'
    ].join('\n')
    expect(parseIoregPlatformUuid(ioreg)).toBe('0A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D')
    expect(parseIoregPlatformUuid('"IOPlatformUUID" = "not-a-uuid"')).toBeNull()
    const reg = '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    0A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D\r\n\r\n'
    expect(parseWindowsMachineGuid(reg)).toBe('0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d')
    expect(parseWindowsMachineGuid('MachineGuid REG_SZ oops')).toBeNull()
    expect(parseLinuxMachineId('0123456789ABCDEF0123456789abcdef\n')).toBe('0123456789abcdef0123456789abcdef')
    expect(parseLinuxMachineId('short')).toBeNull()
  })

  it('reads this machine\'s identifier without writing anything', () => {
    const identity = readMachineIdentifier()
    if (process.platform === 'darwin') expect(identity?.source).toBe('io-platform-uuid')
    if (process.platform === 'linux' && fs.existsSync('/etc/machine-id')) expect(identity?.source).toBe('machine-id')
    expect(readMachineIdentifier('aix')).toBeNull()
    const sandbox = fs.realpathSync(process.env.SWOB_E2E_SANDBOX_ROOT!)
    const before = fs.readdirSync(path.join(sandbox)).sort()
    derivePrivacySalt({ platform: process.platform })
    expect(fs.readdirSync(sandbox).sort()).toEqual(before)
  })

  it('does not change when the hostname changes', () => {
    const first = derivePrivacySalt({ platform: process.platform })
    const firstHost = hostHash(first)
    vi.mocked(os.hostname).mockReturnValue('renamed-by-another-network.lan')
    const second = derivePrivacySalt({ platform: process.platform })
    expect(HEX64.test(first)).toBe(true)
    expect(first === second).toBe(true)
    // The mock is live: the (separately hashed) host id does follow the hostname.
    expect(hostHash(second) === firstHost).toBe(false)
    const identity = machineIdentity({ platform: process.platform })
    expect(identity.value.includes('first-host.local') || identity.value.includes('renamed-by-another-network')).toBe(false)
  })

  it('falls back to username + home directory, still without the hostname', () => {
    const fallback = machineIdentity({ readMachineId: () => null })
    const info = os.userInfo()
    expect(fallback.source).toBe('user-home')
    expect(fallback.value === `${info.username}\0${info.homedir}`).toBe(true)
    const salt = derivePrivacySalt({ readMachineId: () => null })
    vi.mocked(os.hostname).mockReturnValue('another-host')
    expect(derivePrivacySalt({ readMachineId: () => null }) === salt).toBe(true)
    expect(saltFromMachineIdentity({ source: 'machine-id', value: 'x' }) === saltFromMachineIdentity({ source: 'machine-id', value: 'y' })).toBe(false)
  })

  it('exposes only a stable 8-hex fingerprint of the salt', () => {
    const salt = derivePrivacySalt()
    const fingerprint = saltFingerprint(salt)
    expect(/^[0-9a-f]{8}$/.test(fingerprint)).toBe(true)
    expect(saltFingerprint(derivePrivacySalt()) === fingerprint).toBe(true)
    expect(saltFingerprint(derivePrivacySalt({ platform: process.platform })) === fingerprint).toBe(true)
    expect(salt.includes(fingerprint)).toBe(false)
    expect(saltFingerprint('another-salt') === fingerprint).toBe(false)
  })
})
