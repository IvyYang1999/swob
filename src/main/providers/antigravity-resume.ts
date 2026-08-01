import { execFile } from 'node:child_process'

export interface AntigravityResumeCapability {
  available: boolean
  reason: 'available' | 'binary-unavailable' | 'help-failed' | 'conversation-flag-unavailable'
  helpOutput: string | null
}

export type AntigravityHelpRunner = () => Promise<{ stdout: string; stderr: string }>

export function isAntigravityConversationId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
}

export function antigravityCliSupportsConversation(helpOutput: string): boolean {
  return /(?:^|\s)(?:-c(?:,|\s)+|--conversation(?:[=\s,]|$))/m.test(helpOutput)
}

export function buildAntigravityResumeArgs(sessionId: string, helpOutput: string): string[] {
  if (!isAntigravityConversationId(sessionId)) throw new Error('antigravity-conversation-id-invalid')
  if (!antigravityCliSupportsConversation(helpOutput)) throw new Error('antigravity-conversation-flag-unavailable')
  return ['--conversation', sessionId]
}

function runAgyHelp(): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile('agy', ['--help'], {
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

/** Shell-free runtime preflight. It never infers support from a version string. */
export async function probeAntigravityResumeCapability(
  runner: AntigravityHelpRunner = runAgyHelp
): Promise<AntigravityResumeCapability> {
  try {
    const result = await runner()
    const helpOutput = `${result.stdout}\n${result.stderr}`.trim()
    return antigravityCliSupportsConversation(helpOutput)
      ? { available: true, reason: 'available', helpOutput }
      : { available: false, reason: 'conversation-flag-unavailable', helpOutput }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    return {
      available: false,
      reason: code === 'ENOENT' ? 'binary-unavailable' : 'help-failed',
      helpOutput: null
    }
  }
}
