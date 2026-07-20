import * as os from 'os'
import * as path from 'path'

export interface SessionRemoteStateMeta {
  origin?: {
    deviceId: string
    hostname: string
    username?: string
    capturedAt?: string
  }
  projectPath: string
}

export interface SessionRemoteState {
  /** Compatibility name for the UI: true means the session is not from this installation. */
  isRemote: boolean
  remoteHost?: string
  confidence: 'installation-id' | 'installation-id-unavailable' | 'legacy-path-guess'
}

export function isRemoteProjectPathForUser(projectPath: string, localUser: string): boolean {
  const dirName = path.basename(projectPath)
  if (!dirName.startsWith('-')) return false
  const segments = dirName.slice(1).split('-')
  if (segments.length >= 2 && (segments[0] === 'Users' || segments[0] === 'home')) {
    return segments[1] !== localUser
  }
  return false
}

export function extractRemoteUser(projectPath: string): string | null {
  const dirName = path.basename(projectPath)
  if (!dirName.startsWith('-')) return null
  const segments = dirName.slice(1).split('-')
  if (segments.length >= 2 && (segments[0] === 'Users' || segments[0] === 'home')) {
    return segments[1]
  }
  return null
}

/**
 * Compare a persisted source with this installation. The installation UUID is
 * authoritative when available; it is not hardware identity. Legacy metadata
 * falls back to the historical username encoded in the Claude project path.
 */
export function resolveSessionRemoteState(
  meta: SessionRemoteStateMeta,
  localDeviceId?: string,
  localUsername: string = os.userInfo().username
): SessionRemoteState {
  if (meta.origin?.deviceId) {
    if (!localDeviceId) {
      return {
        isRemote: true,
        remoteHost: meta.origin.hostname,
        confidence: 'installation-id-unavailable'
      }
    }
    const isRemote = meta.origin.deviceId !== localDeviceId
    return {
      isRemote,
      remoteHost: isRemote ? meta.origin.hostname : undefined,
      confidence: 'installation-id'
    }
  }

  const isRemote = meta.projectPath
    ? isRemoteProjectPathForUser(meta.projectPath, localUsername)
    : true
  const remoteUser = isRemote && meta.projectPath ? extractRemoteUser(meta.projectPath) : null
  return {
    isRemote,
    remoteHost: remoteUser ? `${remoteUser}@remote` : undefined,
    confidence: 'legacy-path-guess'
  }
}
