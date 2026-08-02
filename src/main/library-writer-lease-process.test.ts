import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { build } from 'vite'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-t190-writer-process-'))
const bundleDir = path.join(tempRoot, 'bundle')
const workerEntry = path.join(__dirname, '__fixtures__', 't190-writer-recovery-process.ts')
const workerBundle = path.join(bundleDir, 'worker.mjs')
const exits = new WeakMap<ChildProcess, Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>>()

beforeAll(async () => {
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
  fs.symlinkSync(
    path.join(process.cwd(), 'node_modules'),
    path.join(bundleDir, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
})

afterAll(() => fs.rmSync(tempRoot, { recursive: true, force: true }))

function startWorker(mode: string, libraryRoot: string, controlPrefix: string, id = 'worker'): ChildProcess {
  const child = spawn(process.execPath, [workerBundle, mode, libraryRoot, controlPrefix, id], {
    env: {
      ...process.env,
      HOME: path.join(tempRoot, 'home'),
      NODE_ENV: 'test',
      SWOB_TEST_HOME: tempRoot,
      SWOB_E2E_SANDBOX_ROOT: tempRoot,
      SWOB_LIBRARY_ROOT: libraryRoot
    },
    stdio: ['ignore', 'ignore', 'pipe']
  })
  let stderr = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk) => { stderr += chunk })
  exits.set(child, new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('exit', (code, signal) => resolve({ code, signal, stderr }))
  }))
  return child
}

function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> {
  return exits.get(child)!
}

async function waitForFile(filePath: string, child?: ChildProcess): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!fs.existsSync(filePath)) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      const exit = await waitForExit(child)
      throw new Error(`worker exited before ${path.basename(filePath)}: ${exit.stderr}`)
    }
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path.basename(filePath)}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function waitForAnyFile(filePaths: string[], children: ChildProcess[]): Promise<string> {
  const deadline = Date.now() + 10_000
  while (true) {
    const found = filePaths.find((filePath) => fs.existsSync(filePath))
    if (found) return found
    if (children.every((child) => child.exitCode !== null || child.signalCode !== null)) {
      const details = await Promise.all(children.map(waitForExit))
      throw new Error(`all workers exited before winner: ${JSON.stringify(details)}`)
    }
    if (Date.now() >= deadline) throw new Error('timed out waiting for a recovery winner')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function killAndWait(child: ChildProcess): Promise<void> {
  const exit = waitForExit(child)
  child.kill('SIGKILL')
  expect((await exit).signal).toBe('SIGKILL')
}

describe('Library writer real-process recovery', () => {
  it('heartbeat SIGKILL 留下完整 temp+旧 owner，后继进程可自动恢复而不是 corrupt-owner', async () => {
    const libraryRoot = path.join(tempRoot, 'heartbeat-library')
    const control = path.join(tempRoot, 'heartbeat')
    fs.mkdirSync(libraryRoot, { recursive: true })
    const writer = startWorker('heartbeat-crash', libraryRoot, control)
    await waitForFile(`${control}.heartbeat-owner-ready`, writer)
    await waitForFile(`${control}.heartbeat-temp-ready`, writer)
    await killAndWait(writer)

    const lockDir = path.join(libraryRoot, '.swob', 'locks', 'library-writer')
    const entries = fs.readdirSync(lockDir)
    expect(entries.filter((name) => name.endsWith('.owner.json'))).toHaveLength(1)
    expect(entries.filter((name) => name.endsWith('.tmp'))).toHaveLength(1)
    expect(() => JSON.parse(fs.readFileSync(path.join(lockDir, entries.find((name) => name.endsWith('.owner.json'))!), 'utf8')))
      .not.toThrow()

    const recovered = await waitForExit(startWorker('recover-once', libraryRoot, control, 'after-heartbeat'))
    expect(recovered, recovered.stderr).toMatchObject({ code: 0, signal: null })
    expect(fs.existsSync(lockDir)).toBe(false)
  }, 20_000)

  it('矩阵 7：两个真实子进程同时竞争 claim，单赢家且败方不破坏新 owner，赢家崩溃后仍可恢复', async () => {
    const libraryRoot = path.join(tempRoot, 'claim-library')
    const control = path.join(tempRoot, 'claim')
    fs.mkdirSync(libraryRoot, { recursive: true })
    const seed = startWorker('seed', libraryRoot, control)
    await waitForFile(`${control}.seed-ready`, seed)
    const lockDir = path.join(libraryRoot, '.swob', 'locks', 'library-writer')
    const oldOwnerName = fs.readdirSync(lockDir).find((name) => name.endsWith('.owner.json'))!
    const oldOwnerBytes = fs.readFileSync(path.join(lockDir, oldOwnerName))
    await killAndWait(seed)

    const contenders = {
      a: startWorker('contend', libraryRoot, control, 'a'),
      b: startWorker('contend', libraryRoot, control, 'b')
    }
    await Promise.all([waitForFile(`${control}.a.ready`), waitForFile(`${control}.b.ready`)])
    fs.writeFileSync(`${control}.start`, 'start')
    await waitForFile(`${control}.claim-ready`)
    const claimant = fs.readFileSync(`${control}.claim-ready`, 'utf8') as 'a' | 'b'
    const loser = claimant === 'a' ? 'b' : 'a'
    await waitForFile(`${control}.${loser}.claim-observed`)
    expect(fs.existsSync(path.join(lockDir, 'recovery.claim'))).toBe(true)
    expect(fs.readFileSync(path.join(lockDir, oldOwnerName))).toEqual(oldOwnerBytes)

    fs.writeFileSync(`${control}.claim-release`, 'release')
    const winnerPath = await waitForAnyFile(
      [`${control}.a.won`, `${control}.b.won`],
      [contenders.a, contenders.b]
    )
    const winner = winnerPath.endsWith('.a.won') ? 'a' : 'b'
    const leaseLoser = winner === 'a' ? 'b' : 'a'
    await waitForFile(`${control}.${leaseLoser}.lost`, contenders[leaseLoser])
    const loserExit = await waitForExit(contenders[leaseLoser])
    expect(loserExit, loserExit.stderr).toMatchObject({ code: 0, signal: null })
    expect(fs.readFileSync(`${control}.${leaseLoser}.lost`, 'utf8')).toBe('active-owner')
    expect(['a', 'b'].filter((id) => fs.existsSync(`${control}.${id}.stale-recovered`))).toEqual([claimant])

    const newEntries = fs.readdirSync(lockDir)
    expect(newEntries.filter((name) => name.endsWith('.owner.json'))).toHaveLength(1)
    expect(newEntries).not.toContain('recovery.claim')
    const newOwner = JSON.parse(fs.readFileSync(path.join(lockDir, newEntries.find((name) => name.endsWith('.owner.json'))!), 'utf8'))
    expect(newOwner).toMatchObject({ schemaVersion: 2, deviceId: `contender-${winner}` })

    await killAndWait(contenders[winner])
    const recovered = await waitForExit(startWorker('recover-once', libraryRoot, control, 'after-winner-crash'))
    expect(recovered, recovered.stderr).toMatchObject({ code: 0, signal: null })
    expect(fs.existsSync(lockDir)).toBe(false)
  }, 30_000)
})
