import { execFile } from 'node:child_process'
import * as fs from 'node:fs'

export type GeminiResumeProbeReason =
  | 'available'
  | 'binary-unavailable'
  | 'version-failed'
  | 'help-failed'
  | 'resume-flag-unavailable'
  | 'source-unavailable'

export interface GeminiResumeProbe {
  available: boolean
  reason: GeminiResumeProbeReason
  version: string | null
  helpOutput: string | null
}

export type GeminiProbeRunner = (args: string[]) => Promise<{ stdout: string; stderr: string }>

export function isGeminiSessionId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(value) && value !== '.' && value !== '..'
}

export function geminiHelpSupportsResume(helpOutput: string): boolean {
  return /(?:^|\s)(?:-r,\s*)?--resume(?:[=\s,]|$)/m.test(helpOutput)
}

export function buildGeminiResumeArgs(sessionId: string, helpOutput: string): string[] {
  if (!isGeminiSessionId(sessionId)) throw new Error('gemini-session-id-invalid')
  if (!geminiHelpSupportsResume(helpOutput)) throw new Error('gemini-resume-flag-unavailable')
  return ['--resume', sessionId]
}

function runGemini(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile('gemini', args, {
      encoding: 'utf8',
      timeout: 3_000,
      maxBuffer: 256 * 1024,
      windowsHide: true
    }, (error, stdout, stderr) => {
      if (error) reject(error)
      else resolve({ stdout, stderr })
    })
  })
}

/** Shell-free preflight. A successful spawn is not treated as resume success. */
export async function probeGeminiResumeCapability(
  sourcePath: string,
  runner: GeminiProbeRunner = runGemini
): Promise<GeminiResumeProbe> {
  try {
    if (!fs.statSync(sourcePath).isFile()) {
      return { available: false, reason: 'source-unavailable', version: null, helpOutput: null }
    }
  } catch {
    return { available: false, reason: 'source-unavailable', version: null, helpOutput: null }
  }

  let version: string
  try {
    const result = await runner(['--version'])
    version = `${result.stdout}\n${result.stderr}`.trim()
    if (!version) return { available: false, reason: 'version-failed', version: null, helpOutput: null }
  } catch (error) {
    return {
      available: false,
      reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'binary-unavailable' : 'version-failed',
      version: null,
      helpOutput: null
    }
  }

  try {
    const result = await runner(['--help'])
    const helpOutput = `${result.stdout}\n${result.stderr}`.trim()
    return geminiHelpSupportsResume(helpOutput)
      ? { available: true, reason: 'available', version, helpOutput }
      : { available: false, reason: 'resume-flag-unavailable', version, helpOutput }
  } catch {
    return { available: false, reason: 'help-failed', version, helpOutput: null }
  }
}
