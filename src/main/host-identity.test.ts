import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { build } from 'vite'
import {
  defaultHostIdentityPath,
  deriveLibraryHostProof,
  getOrCreateHostIdentity,
  HostIdentityError,
  readHostIdentity
} from './host-identity'

const roots: string[] = []

interface WorkerResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

function startIdentityWorker(
  workerBundle: string,
  storagePath: string,
  gatePath: string,
  workerId: number
): { child: ChildProcess; result: Promise<WorkerResult> } {
  const child = spawn(process.execPath, [workerBundle, storagePath, gatePath, String(workerId)], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const result = new Promise<WorkerResult>((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => { stdout += chunk })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
  return { child, result }
}

async function waitForReadyWorkers(
  controlDir: string,
  count: number,
  workers: Array<{ child: ChildProcess; result: Promise<WorkerResult> }>
): Promise<void> {
  const deadline = Date.now() + 10_000
  while (true) {
    const readyCount = fs.readdirSync(controlDir).filter((name) => name.startsWith('ready-')).length
    if (readyCount === count) return
    if (workers.some(({ child }) => child.exitCode !== null || child.signalCode !== null)) {
      const results = await Promise.all(workers.map(({ result }) => result))
      throw new Error(`identity worker exited before release: ${JSON.stringify(results)}`)
    }
    if (Date.now() >= deadline) throw new Error(`timed out waiting for identity workers (${readyCount}/${count})`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('stable host identity', () => {
  it('publishes one no-clobber identity under concurrent first creation', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-host-identity-concurrent-'))
    roots.push(root)
    const storagePath = path.join(root, 'machine', 'host-identity-v1.json')
    const controlDir = path.join(root, 'control')
    const gatePath = path.join(controlDir, 'release')
    const bundleDir = path.join(root, 'bundle')
    const workerEntry = path.join(root, 'worker.ts')
    const workerBundle = path.join(bundleDir, 'worker.mjs')
    fs.mkdirSync(controlDir, { recursive: true })

    const hostIdentityModule = path.join(__dirname, 'host-identity.ts')
    fs.writeFileSync(workerEntry, `
      import * as fs from 'node:fs'
      import * as path from 'node:path'
      import { getOrCreateHostIdentity } from ${JSON.stringify(hostIdentityModule)}

      const [storagePath, gatePath, rawWorkerId] = process.argv.slice(2)
      const workerId = Number(rawWorkerId)
      fs.writeFileSync(path.join(path.dirname(gatePath), \`ready-${'${workerId}'}\`), '', { flag: 'wx' })
      const waiter = new Int32Array(new SharedArrayBuffer(4))
      const deadline = Date.now() + 10_000
      while (!fs.existsSync(gatePath)) {
        if (Date.now() >= deadline) throw new Error('timed out waiting for release gate')
        Atomics.wait(waiter, 0, 0, 5)
      }
      const candidate = \`10000000-0000-4000-8000-${'${workerId.toString(16).padStart(12, \'0\')}'}\`
      const identity = getOrCreateHostIdentity({
        storagePath,
        randomId: () => candidate,
        now: () => 1_700_000_000_000 + workerId
      })
      process.stdout.write(JSON.stringify({ identity, candidate }))
    `)
    await build({
      configFile: false,
      logLevel: 'silent',
      build: {
        ssr: workerEntry,
        outDir: bundleDir,
        emptyOutDir: true,
        rollupOptions: { output: { format: 'es', entryFileNames: 'worker.mjs' } }
      }
    })

    const workers = Array.from({ length: 12 }, (_, workerId) =>
      startIdentityWorker(workerBundle, storagePath, gatePath, workerId)
    )
    try {
      await waitForReadyWorkers(controlDir, workers.length, workers)
      fs.writeFileSync(gatePath, '', { flag: 'wx' })
      const results = await Promise.all(workers.map(({ result }) => result))
      expect(results, results.map(({ stderr }) => stderr).join('\n')).toSatisfy(
        (items: WorkerResult[]) => items.every(({ code, signal }) => code === 0 && signal === null)
      )

      const reports = results.map(({ stdout }) => JSON.parse(stdout) as {
        identity: string
        candidate: string
      })
      expect(new Set(reports.map(({ candidate }) => candidate)).size).toBe(workers.length)
      expect(new Set(reports.map(({ identity }) => identity)).size).toBe(1)

      const published = JSON.parse(fs.readFileSync(storagePath, 'utf8')) as {
        schemaVersion: number
        identity: string
        createdAt: string
      }
      expect(published).toMatchObject({
        schemaVersion: 1,
        identity: reports[0].identity,
        createdAt: expect.any(String)
      })
      expect(reports.map(({ candidate }) => candidate)).toContain(published.identity)
      expect(fs.readdirSync(path.dirname(storagePath))).toEqual([path.basename(storagePath)])
    } finally {
      for (const { child } of workers) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }
      await Promise.allSettled(workers.map(({ result }) => result))
    }
  }, 30_000)

  it('persists a random identity outside profiles and never derives it from hardware', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-host-identity-'))
    roots.push(root)
    const storagePath = path.join(root, 'machine', 'host-identity-v1.json')
    let generated = 0
    const first = getOrCreateHostIdentity({
      storagePath,
      randomId: () => {
        generated++
        return '10000000-0000-4000-8000-000000000001'
      },
      now: () => 1_700_000_000_000
    })
    const second = getOrCreateHostIdentity({
      storagePath,
      randomId: () => {
        generated++
        return '20000000-0000-4000-8000-000000000002'
      }
    })

    expect(second).toBe(first)
    expect(generated).toBe(1)
    expect(JSON.parse(fs.readFileSync(storagePath, 'utf8'))).toMatchObject({
      schemaVersion: 1,
      identity: first
    })
  })

  it('production storage path ignores HOME/profile changes and Library receives only a scoped proof', () => {
    const before = process.env.HOME
    process.env.HOME = '/tmp/profile-a'
    const firstPath = defaultHostIdentityPath('darwin')
    process.env.HOME = '/tmp/profile-b'
    const secondPath = defaultHostIdentityPath('darwin')
    if (before === undefined) delete process.env.HOME
    else process.env.HOME = before

    expect(firstPath).toBe('/Users/Shared/Swob/host-identity-v1.json')
    expect(secondPath).toBe(firstPath)
    const raw = '10000000-0000-4000-8000-000000000001'
    const proofA = deriveLibraryHostProof(raw, '10000000-0000-4000-8000-000000000010')
    const proofB = deriveLibraryHostProof(raw, '20000000-0000-4000-8000-000000000020')
    expect(proofA).toMatch(/^[0-9a-f]{64}$/)
    expect(proofA).not.toContain(raw)
    expect(proofB).not.toBe(proofA)
  })

  it('does not silently rotate corrupt identity evidence', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-host-identity-corrupt-'))
    roots.push(root)
    const storagePath = path.join(root, 'host-identity-v1.json')
    fs.writeFileSync(storagePath, '{broken')

    expect(() => getOrCreateHostIdentity({ storagePath }))
      .toThrowError(expect.objectContaining<Partial<HostIdentityError>>({
        code: 'HOST_IDENTITY_UNAVAILABLE', reason: 'corrupt'
      }))
    expect(fs.readFileSync(storagePath, 'utf8')).toBe('{broken')
  })

  it('read-only inspection never creates a missing host identity', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-host-identity-readonly-'))
    roots.push(root)
    const storagePath = path.join(root, 'missing', 'host-identity-v1.json')

    expect(readHostIdentity({ storagePath })).toBeNull()
    expect(fs.existsSync(path.dirname(storagePath))).toBe(false)
  })
})
