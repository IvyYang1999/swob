import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { SecurityCliSecretStore, type SpawnSecurity } from './llm-secret-store'

function fakeProcess(onInput?: (value: string) => void): ChildProcessWithoutNullStreams {
  const processLike = new EventEmitter() as ChildProcessWithoutNullStreams
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  Object.assign(processLike, { stdin, stdout, stderr })
  let input = ''
  stdin.on('data', (chunk) => { input += chunk.toString('utf-8') })
  stdin.on('finish', () => {
    onInput?.(input)
    queueMicrotask(() => processLike.emit('close', 0))
  })
  return processLike
}

describe('SecurityCliSecretStore', () => {
  it.runIf(process.platform === 'darwin')('writes the value through stdin and never argv', async () => {
    let args: string[] = []
    let stdinValue = ''
    const spawnSecurity: SpawnSecurity = (_executable, receivedArgs) => {
      args = receivedArgs
      return fakeProcess((value) => { stdinValue = value })
    }
    const store = new SecurityCliSecretStore(spawnSecurity)

    await store.set('fixture-value')

    expect(args.at(-1)).toBe('-w')
    expect(args).not.toContain('fixture-value')
    expect(stdinValue).toBe('fixture-value\n')
  })
})
