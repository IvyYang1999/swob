import { execSync } from 'child_process'
import { isIP } from 'net'
import { hostname, networkInterfaces } from 'os'
import type { LocalNetworkInfo, PublicIpQueryResult } from '../shared/network-info'

export const PUBLIC_IP_URL = 'https://api.ipify.org?format=json'
export const PUBLIC_IP_TIMEOUT_MS = 5000

type LocalNetworkDependencies = {
  getNetworkInterfaces?: typeof networkInterfaces
  getHostname?: typeof hostname
  runCommand?: (command: string) => string
}

const runCommand = (command: string): string =>
  execSync(command, { encoding: 'utf-8' }).trim()

export function getLocalNetworkInfo(
  dependencies: LocalNetworkDependencies = {}
): LocalNetworkInfo {
  const getNetworkInterfaces = dependencies.getNetworkInterfaces ?? networkInterfaces
  const getHostname = dependencies.getHostname ?? hostname
  const execute = dependencies.runCommand ?? runCommand
  const localIps: string[] = []

  for (const networkInterface of Object.values(getNetworkInterfaces())) {
    for (const address of networkInterface ?? []) {
      if (address.family === 'IPv4' && !address.internal) {
        localIps.push(address.address)
      }
    }
  }

  const tailscaleIp = localIps.find((ip) => ip.startsWith('100.')) ?? null

  let localHostname = ''
  try {
    localHostname = getHostname()
  } catch {
    // Hostname detection is best-effort and local-only.
  }

  let sshEnabled = false
  try {
    const output = execute('launchctl list com.openssh.sshd 2>/dev/null || true')
    sshEnabled = output.length > 0 && !output.includes('-\t0\tcom.openssh.sshd')
  } catch {
    // SSH status is best-effort and local-only.
  }

  return {
    localIps,
    tailscaleIp,
    hostname: localHostname,
    sshEnabled
  }
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.name === 'AbortError' || error.name === 'TimeoutError'
}

export async function queryPublicIp(
  fetchPublicIp: typeof fetch = fetch,
  createTimeoutSignal: (milliseconds: number) => AbortSignal = AbortSignal.timeout
): Promise<PublicIpQueryResult> {
  try {
    const response = await fetchPublicIp(PUBLIC_IP_URL, {
      signal: createTimeoutSignal(PUBLIC_IP_TIMEOUT_MS)
    })
    if (!response.ok) return { ok: false, error: 'request-failed' }

    const payload = await response.json() as { ip?: unknown }
    if (typeof payload.ip !== 'string' || isIP(payload.ip) === 0) {
      return { ok: false, error: 'invalid-response' }
    }

    return { ok: true, ip: payload.ip }
  } catch (error) {
    return {
      ok: false,
      error: isTimeoutError(error) ? 'timeout' : 'request-failed'
    }
  }
}
