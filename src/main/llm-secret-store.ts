import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

export interface SecretStore {
  get(): Promise<string | null>
  set(value: string): Promise<void>
  delete(): Promise<void>
}

export type SpawnSecurity = (
  executable: string,
  args: string[],
  options: { stdio: ['pipe', 'pipe', 'pipe'] }
) => ChildProcessWithoutNullStreams

const SECURITY_PATH = '/usr/bin/security'
const SERVICE = 'com.swob.insights-llm'
const ACCOUNT = 'default'
const PROFILE_SERVICE = 'com.swob.llm-profile'

/** `security ... -w` prompts for the password and its confirmation on stdin. */
export function keychainPasswordInput(value: string): string {
  return `${value}\n${value}\n`
}

/** `security` may report a confirmation mismatch while still exiting with code 0. */
export function assertNoKeychainPasswordMismatch(stderr: string): void {
  if (/passwords don't match/i.test(stderr)) {
    throw new Error('macOS Keychain rejected the password confirmation')
  }
}

export interface ProfileSecretStore {
  get(profileId: string): Promise<string | null>
  set(profileId: string, value: string): Promise<void>
  delete(profileId: string): Promise<void>
}

/**
 * Profile-scoped Keychain storage. Profile ids are account names; secret
 * values only travel through the child process stdin and are never included
 * in thrown errors.
 */
export class SecurityCliProfileSecretStore implements ProfileSecretStore {
  constructor(
    private readonly spawnSecurity: SpawnSecurity =
      (executable, args, options) => spawn(executable, args, options)
  ) {}

  async get(profileId: string): Promise<string | null> {
    this.assertProfileId(profileId)
    return this.run([
      'find-generic-password',
      '-a', profileId,
      '-s', PROFILE_SERVICE,
      '-w'
    ], undefined, true)
  }

  async set(profileId: string, value: string): Promise<void> {
    this.assertProfileId(profileId)
    if (!value) throw new Error('Cannot store an empty LLM profile credential')
    await this.run([
      'add-generic-password',
      '-U',
      '-a', profileId,
      '-s', PROFILE_SERVICE,
      '-w'
    ], keychainPasswordInput(value), false)
  }

  async delete(profileId: string): Promise<void> {
    this.assertProfileId(profileId)
    await this.run([
      'delete-generic-password',
      '-a', profileId,
      '-s', PROFILE_SERVICE
    ], undefined, true)
  }

  private assertProfileId(profileId: string): void {
    if (!profileId || profileId.length > 200 || /[\r\n]/.test(profileId)) {
      throw new Error('Invalid LLM profile id')
    }
  }

  private async run(args: string[], input: string | undefined, missingIsNull: boolean): Promise<string | null> {
    // spawn can THROW synchronously (e.g. transient EBADF in GUI-launched
    // apps) instead of emitting 'error' — catch both shapes and retry once.
    let lastError: Error | null = null
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.runOnce(args, input, missingIsNull)
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        if (!String(lastError.message).includes('EBADF')) throw lastError
        if (attempt === 0) console.warn('[keychain] spawn EBADF; retrying once')
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
    throw new Error(`Keychain 调用失败(${lastError?.message || 'unknown'});请重启 Swob 后重试`)
  }

  private runOnce(args: string[], input: string | undefined, missingIsNull: boolean): Promise<string | null> {
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams
      try {
        child = this.spawnSecurity(SECURITY_PATH, args, { stdio: ['pipe', 'pipe', 'pipe'] })
      } catch (error) {
        reject(error)
        return
      }
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => { stdout += chunk })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        if (stderr.length < 64 * 1024) stderr += chunk
      })
      child.on('error', (error) => reject(new Error(`macOS Keychain command could not start (${String(error)})`)))
      child.on('close', (code) => {
        try {
          assertNoKeychainPasswordMismatch(stderr)
        } catch (error) {
          reject(error)
          return
        }
        if (code === 0) resolve(stdout.trim())
        else if (missingIsNull && code === 44) resolve(null)
        else reject(new Error(`macOS Keychain command failed (${code ?? 'unknown'})`))
      })
      if (input === undefined) child.stdin.end()
      else child.stdin.end(input)
    })
  }
}

export class SecurityCliSecretStore implements SecretStore {
  constructor(
    private readonly spawnSecurity: SpawnSecurity =
      (executable, args, options) => spawn(executable, args, options)
  ) {}

  async get(): Promise<string | null> {
    const result = await this.run([
      'find-generic-password',
      '-a', ACCOUNT,
      '-s', SERVICE,
      '-w'
    ], undefined, true)
    return result === null ? null : result.replace(/\r?\n$/, '')
  }

  async set(value: string): Promise<void> {
    if (!value) throw new Error('Cannot store an empty LLM credential')
    // macOS security reads the password from stdin when -w is the final
    // option without an argv value. The secret never enters process listings.
    await this.run([
      'add-generic-password',
      '-U',
      '-a', ACCOUNT,
      '-s', SERVICE,
      '-w'
    ], keychainPasswordInput(value), false)
  }

  async delete(): Promise<void> {
    await this.run([
      'delete-generic-password',
      '-a', ACCOUNT,
      '-s', SERVICE
    ], undefined, true)
  }

  private async run(args: string[], input: string | undefined, missingIsNull: boolean): Promise<string | null> {
    if (process.platform !== 'darwin') {
      throw new Error('macOS Keychain is unavailable on this platform')
    }
    let lastError: Error | null = null
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.runOnce(args, input, missingIsNull)
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        if (!String(lastError.message).includes('EBADF')) throw lastError
        if (attempt === 0) console.warn('[keychain] spawn EBADF; retrying once')
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
    throw new Error(`Keychain 调用失败(${lastError?.message || 'unknown'});请重启 Swob 后重试`)
  }

  private runOnce(args: string[], input: string | undefined, missingIsNull: boolean): Promise<string | null> {
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams
      try {
        child = this.spawnSecurity(SECURITY_PATH, args, { stdio: ['pipe', 'pipe', 'pipe'] })
      } catch (error) {
        reject(error)
        return
      }
      const stdout: Buffer[] = []
      let stdoutLength = 0
      const stderr: Buffer[] = []
      let stderrLength = 0
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutLength += chunk.length
        if (stdoutLength <= 64 * 1024) stdout.push(chunk)
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderrLength += chunk.length
        if (stderrLength <= 64 * 1024) stderr.push(chunk)
      })
      child.on('error', () => reject(new Error('Unable to start macOS Keychain')))
      child.on('close', (code) => {
        try {
          assertNoKeychainPasswordMismatch(Buffer.concat(stderr).toString('utf-8'))
        } catch (error) {
          reject(error)
          return
        }
        if (code === 0) {
          resolve(Buffer.concat(stdout).toString('utf-8'))
        } else if (missingIsNull && code === 44) {
          resolve(null)
        } else {
          reject(new Error(`macOS Keychain operation failed (${code ?? 'unknown'})`))
        }
      })
      if (input === undefined) child.stdin.end()
      else child.stdin.end(input)
    })
  }
}
