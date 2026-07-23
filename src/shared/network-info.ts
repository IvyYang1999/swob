export type LocalNetworkInfo = {
  localIps: string[]
  tailscaleIp: string | null
  hostname: string
  sshEnabled: boolean
}

export type PublicIpQueryError = 'timeout' | 'request-failed' | 'invalid-response'

export type PublicIpQueryResult =
  | { ok: true; ip: string }
  | { ok: false; error: PublicIpQueryError }
