import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

export interface SecretStore {
  get(): Promise<string | null>
  set(value: string): Promise<void>
}

export type SpawnSecurity = (
  executable: string,
  args: string[],
  options: { stdio: ['pipe', 'pipe', 'pipe'] }
) => ChildProcessWithoutNullStreams

const SECURITY_PATH = '/usr/bin/security'
const SERVICE = 'com.swob.insights-llm'
const ACCOUNT = 'default'

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
    ], `${value}\n`, false)
  }

  private run(args: string[], input: string | undefined, missingIsNull: boolean): Promise<string | null> {
    if (process.platform !== 'darwin') {
      return Promise.reject(new Error('macOS Keychain is unavailable on this platform'))
    }
    return new Promise((resolve, reject) => {
      const child = this.spawnSecurity(SECURITY_PATH, args, { stdio: ['pipe', 'pipe', 'pipe'] })
      const stdout: Buffer[] = []
      let stdoutLength = 0
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutLength += chunk.length
        if (stdoutLength <= 64 * 1024) stdout.push(chunk)
      })
      child.stderr.resume()
      child.on('error', () => reject(new Error('Unable to start macOS Keychain')))
      child.on('close', (code) => {
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
