import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NetworkInterfaceInfo } from 'os'
import {
  getLocalNetworkInfo,
  PUBLIC_IP_TIMEOUT_MS,
  PUBLIC_IP_URL,
  queryPublicIp
} from './network-info'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('local network information', () => {
  it('【曾经的 bug】does not make a network request or expose a public IP', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const runCommand = vi.fn().mockReturnValue('123\t0\tcom.openssh.sshd')
    const address: NetworkInterfaceInfo = {
      address: '192.168.1.8',
      netmask: '255.255.255.0',
      family: 'IPv4',
      mac: '00:00:00:00:00:00',
      internal: false,
      cidr: '192.168.1.8/24'
    }

    const result = getLocalNetworkInfo({
      getNetworkInterfaces: () => ({ en0: [address] }),
      getHostname: () => 'test-host',
      runCommand
    })

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(result).toEqual({
      localIps: ['192.168.1.8'],
      tailscaleIp: null,
      hostname: 'test-host',
      sshEnabled: true
    })
    expect(result).not.toHaveProperty('publicIp')
  })
})

describe('public IP query', () => {
  it('uses the explicit endpoint with a five-second timeout', async () => {
    const signal = new AbortController().signal
    const createTimeoutSignal = vi.fn().mockReturnValue(signal)
    const fetchPublicIp = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ ip: '203.0.113.10' })
    })

    const result = await queryPublicIp(fetchPublicIp as typeof fetch, createTimeoutSignal)

    expect(createTimeoutSignal).toHaveBeenCalledWith(PUBLIC_IP_TIMEOUT_MS)
    expect(fetchPublicIp).toHaveBeenCalledWith(PUBLIC_IP_URL, { signal })
    expect(result).toEqual({ ok: true, ip: '203.0.113.10' })
  })

  it('rejects malformed responses', async () => {
    const fetchPublicIp = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ ip: 'not-an-ip' })
    })

    await expect(queryPublicIp(fetchPublicIp as typeof fetch)).resolves.toEqual({
      ok: false,
      error: 'invalid-response'
    })
  })

  it('returns a request error for non-success HTTP responses', async () => {
    const fetchPublicIp = vi.fn().mockResolvedValue({
      ok: false,
      json: vi.fn()
    })

    await expect(queryPublicIp(fetchPublicIp as typeof fetch)).resolves.toEqual({
      ok: false,
      error: 'request-failed'
    })
  })

  it('returns a request error when the response is not JSON', async () => {
    const fetchPublicIp = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockRejectedValue(new SyntaxError('invalid JSON'))
    })

    await expect(queryPublicIp(fetchPublicIp as typeof fetch)).resolves.toEqual({
      ok: false,
      error: 'request-failed'
    })
  })

  it('returns a timeout error without throwing', async () => {
    const timeoutError = new Error('timed out')
    timeoutError.name = 'TimeoutError'
    const fetchPublicIp = vi.fn().mockRejectedValue(timeoutError)

    await expect(queryPublicIp(fetchPublicIp as typeof fetch)).resolves.toEqual({
      ok: false,
      error: 'timeout'
    })
  })
})
