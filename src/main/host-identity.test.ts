import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { build } from 'vite'
import {
  defaultHostIdentityBackupPath,
  defaultHostIdentityPath,
  deriveLibraryHostProof,
  getOrCreateHostIdentity,
  HostIdentityError,
  readHostIdentity,
  readHostMachineBinding,
  type HostIdentityEvent,
  type HostIdentityOptions
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

describe('machine-local host identity backup', () => {
  const identityA = '10000000-0000-4000-8000-00000000000a'
  const identityB = '20000000-0000-4000-8000-00000000000b'

  function layout(label: string): { root: string; storagePath: string; backupPath: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `swob-host-identity-backup-${label}-`))
    roots.push(root)
    return {
      root,
      // The incident removed the primary's whole directory, so the backup lives elsewhere.
      storagePath: path.join(root, 'Shared', 'Swob', 'host-identity-v1.json'),
      backupPath: path.join(root, 'home', '.claude-session-manager', 'host-identity-v1.json')
    }
  }

  function options(
    paths: { storagePath: string; backupPath: string },
    overrides: Partial<HostIdentityOptions> = {}
  ): HostIdentityOptions & { events: HostIdentityEvent[] } {
    const events: HostIdentityEvent[] = []
    return {
      storagePath: paths.storagePath,
      backupPath: paths.backupPath,
      machineBinding: () => 'machine-a',
      randomId: () => identityA,
      now: () => 1_700_000_000_000,
      eventSink: (event) => { events.push(event) },
      ...overrides,
      events
    }
  }

  it('writes a machine-bound backup after the primary; the backup never carries the machine identifier', () => {
    const paths = layout('write')
    const first = options(paths)
    expect(getOrCreateHostIdentity(first)).toBe(identityA)

    const primary = JSON.parse(fs.readFileSync(paths.storagePath, 'utf8'))
    const backup = JSON.parse(fs.readFileSync(paths.backupPath, 'utf8'))
    expect(backup).toEqual({ ...primary, mac: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(fs.readFileSync(paths.backupPath, 'utf8')).not.toContain('machine-a')
    expect(fs.statSync(paths.backupPath).mode & 0o777).toBe(0o600)
    expect(first.events).toEqual([
      { component: 'host-identity', event: 'host-identity-regenerated', backup: 'missing' },
      { component: 'host-identity', event: 'host-identity-backup-written', previous: 'missing' }
    ])

    // A backup deleted later is written again from the existing primary.
    fs.rmSync(paths.backupPath)
    const again = options(paths, { machineBinding: () => 'machine-a', randomId: () => identityB })
    expect(getOrCreateHostIdentity(again)).toBe(identityA)
    expect(JSON.parse(fs.readFileSync(paths.backupPath, 'utf8'))).toEqual(backup)
  })

  it('primary directory removed: restores the same record from a verified backup instead of generating one', () => {
    const paths = layout('restore')
    getOrCreateHostIdentity(options(paths))
    const primaryBytes = fs.readFileSync(paths.storagePath, 'utf8')
    fs.rmSync(path.dirname(paths.storagePath), { recursive: true, force: true })

    let generated = 0
    const restore = options(paths, { randomId: () => { generated++; return identityB } })
    expect(getOrCreateHostIdentity(restore)).toBe(identityA)

    expect(generated).toBe(0)
    expect(fs.readFileSync(paths.storagePath, 'utf8')).toBe(primaryBytes)
    expect(restore.events).toEqual([{ component: 'host-identity', event: 'host-identity-restored', source: 'backup' }])
  })

  it.each([
    {
      label: 'another machine (HMAC key differs)',
      damage: () => {},
      binding: 'machine-b',
      state: 'mismatch'
    },
    {
      label: 'identity edited without its HMAC',
      damage: (backupPath: string) => {
        const record = JSON.parse(fs.readFileSync(backupPath, 'utf8'))
        fs.writeFileSync(backupPath, JSON.stringify({ ...record, identity: '30000000-0000-4000-8000-00000000000c' }))
      },
      binding: 'machine-a',
      state: 'mismatch'
    },
    {
      label: 'corrupt JSON',
      damage: (backupPath: string) => { fs.writeFileSync(backupPath, '{broken') },
      binding: 'machine-a',
      state: 'corrupt'
    }
  ])('an unverifiable backup ($label) is never restored: a new identity is generated and logged', ({ damage, binding, state }) => {
    const paths = layout('reject')
    getOrCreateHostIdentity(options(paths))
    damage(paths.backupPath)
    fs.rmSync(path.dirname(paths.storagePath), { recursive: true, force: true })

    const regenerate = options(paths, { machineBinding: () => binding, randomId: () => identityB })
    expect(getOrCreateHostIdentity(regenerate)).toBe(identityB)

    expect(regenerate.events[0]).toEqual({ component: 'host-identity', event: 'host-identity-regenerated', backup: state })
    // The backup follows the primary that now exists, under this machine's key.
    expect(JSON.parse(fs.readFileSync(paths.backupPath, 'utf8'))).toMatchObject({ identity: identityB })
  })

  it('without a readable machine identifier the backup is neither trusted nor overwritten', () => {
    const paths = layout('unbound')
    getOrCreateHostIdentity(options(paths))
    const backupBytes = fs.readFileSync(paths.backupPath, 'utf8')
    fs.rmSync(path.dirname(paths.storagePath), { recursive: true, force: true })

    const unbound = options(paths, { machineBinding: () => null, randomId: () => identityB })
    expect(getOrCreateHostIdentity(unbound)).toBe(identityB)
    expect(unbound.events).toEqual([
      { component: 'host-identity', event: 'host-identity-regenerated', backup: 'unverified' }
    ])
    expect(fs.readFileSync(paths.backupPath, 'utf8')).toBe(backupBytes)
  })

  it('a corrupt primary is never replaced from the backup (no silent rotation of existing evidence)', () => {
    const paths = layout('corrupt-primary')
    getOrCreateHostIdentity(options(paths))
    fs.writeFileSync(paths.storagePath, '{broken')

    expect(() => getOrCreateHostIdentity(options(paths)))
      .toThrowError(expect.objectContaining<Partial<HostIdentityError>>({ reason: 'corrupt' }))
    expect(fs.readFileSync(paths.storagePath, 'utf8')).toBe('{broken')
  })

  it('never writes through a symlink at the backup path', () => {
    const paths = layout('symlink')
    const outside = path.join(paths.root, 'outside.json')
    fs.writeFileSync(outside, 'outside')
    fs.mkdirSync(path.dirname(paths.backupPath), { recursive: true })
    fs.symlinkSync(outside, paths.backupPath)

    expect(getOrCreateHostIdentity(options(paths))).toBe(identityA)
    expect(fs.readFileSync(outside, 'utf8')).toBe('outside')
    expect(fs.lstatSync(paths.backupPath).isSymbolicLink()).toBe(true)
  })

  it('read-only inspection neither reads nor writes the backup', () => {
    const paths = layout('readonly')
    getOrCreateHostIdentity(options(paths))
    fs.rmSync(paths.backupPath)
    expect(readHostIdentity(options(paths))).toBe(identityA)
    expect(fs.existsSync(paths.backupPath)).toBe(false)

    fs.rmSync(path.dirname(paths.storagePath), { recursive: true, force: true })
    getOrCreateHostIdentity(options(paths))
    fs.rmSync(path.dirname(paths.storagePath), { recursive: true, force: true })
    // The backup exists, but the read-only path must not restore from it.
    expect(readHostIdentity(options(paths))).toBeNull()
    expect(fs.existsSync(paths.storagePath)).toBe(false)
  })

  it('an explicit storagePath without backupPath keeps the backup disabled', () => {
    const paths = layout('disabled')
    const events: HostIdentityEvent[] = []
    getOrCreateHostIdentity({ storagePath: paths.storagePath, randomId: () => identityA, eventSink: (event) => { events.push(event) } })
    expect(fs.existsSync(paths.backupPath)).toBe(false)
    expect(events).toEqual([{ component: 'host-identity', event: 'host-identity-regenerated', backup: 'disabled' }])
  })

  it('the production backup sits in the state directory next to app-config.json, never Electron userData', () => {
    expect(defaultHostIdentityBackupPath('darwin', { NODE_ENV: 'production', HOME: '/tmp/profile-a' }))
      .toBe('/tmp/profile-a/.claude-session-manager/host-identity-v1.json')
    expect(defaultHostIdentityBackupPath('darwin', { NODE_ENV: 'production', HOME: '/tmp/profile-a' }))
      .not.toContain('Application Support')
    // The primary still ignores HOME.
    expect(defaultHostIdentityPath('darwin')).toBe('/Users/Shared/Swob/host-identity-v1.json')
  })

  it('without an eventSink the events reach process listeners, which the desktop app writes to lifecycle.log', () => {
    const paths = layout('process-event')
    const received: HostIdentityEvent[] = []
    const listener = (event: HostIdentityEvent): void => { received.push(event) }
    process.on('swob:host-identity-event', listener)
    try {
      getOrCreateHostIdentity({
        storagePath: paths.storagePath,
        backupPath: paths.backupPath,
        machineBinding: () => 'machine-a',
        randomId: () => identityA
      })
    } finally {
      process.off('swob:host-identity-event', listener)
    }
    expect(received.map(({ event }) => event)).toEqual(['host-identity-regenerated', 'host-identity-backup-written'])

    const index = fs.readFileSync(path.join(__dirname, 'index.ts'), 'utf8')
    expect(index).toMatch(
      /process\.on\('swob:host-identity-event', \(event: HostIdentityEvent\) => \{[\s\S]*?writeLifecycleLog\(name, fields\)/
    )
    expect(index).toMatch(
      /process\.on\('swob:library-writer-event'[\s\S]*?writeLifecycleLog\('library-writer-stale-recovered', \{ basis: event\.recoveryBasis/
    )
  })

  it('under the test harness the machine binding is a seed, never the host identifier', () => {
    expect(readHostMachineBinding('darwin')).toBe(`test-machine:${path.resolve(process.env.SWOB_TEST_HOME!)}`)
  })
})

