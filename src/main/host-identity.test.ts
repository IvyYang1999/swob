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
  readHostIdentityHistory,
  readHostMachineBinding,
  type HostIdentityEvent,
  type HostIdentityOptions
} from './host-identity'
import {
  resolveLibraryWriterHostIdentityBackupPath,
  resolveLibraryWriterHostIdentityStoragePath
} from './library-writer-lease'

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

describe('identity history (F1l-c): old identities survive a primary regenerated elsewhere', () => {
  const identityA = '10000000-0000-4000-8000-0000000000a1'
  const identityB = '20000000-0000-4000-8000-0000000000b2'
  const identityC = '30000000-0000-4000-8000-0000000000c3'

  function layout(label: string): { root: string; storagePath: string; backupPath: string; historyPath: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `swob-host-identity-history-${label}-`))
    roots.push(root)
    const backupPath = path.join(root, 'home', '.claude-session-manager', 'host-identity-v1.json')
    return {
      root,
      storagePath: path.join(root, 'Shared', 'Swob', 'host-identity-v1.json'),
      backupPath,
      historyPath: path.join(path.dirname(backupPath), 'host-identity-history.jsonl')
    }
  }

  function options(
    paths: { storagePath: string; backupPath: string },
    overrides: Partial<HostIdentityOptions> = {}
  ): HostIdentityOptions {
    return {
      storagePath: paths.storagePath,
      backupPath: paths.backupPath,
      machineBinding: () => 'machine-a',
      now: () => 1_700_000_000_000,
      ...overrides
    }
  }

  /** Replace the primary out from under the backup, as a test-framework/other-process regeneration would. */
  function regeneratePrimary(storagePath: string, identity: string, createdAt: string): void {
    fs.rmSync(path.dirname(storagePath), { recursive: true, force: true })
    fs.mkdirSync(path.dirname(storagePath), { recursive: true })
    fs.writeFileSync(storagePath, JSON.stringify({ schemaVersion: 1, identity, createdAt }), { mode: 0o600 })
  }

  function historyEntries(historyPath: string): Array<{ identity: string; createdAt: string; source: string; mac: string }> {
    if (!fs.existsSync(historyPath)) return []
    return fs.readFileSync(historyPath, 'utf8').split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line))
  }

  it('a primary regenerated elsewhere (the 09-26 shape) has its old identity preserved in history when the backup is next synced', () => {
    const paths = layout('supersede')
    getOrCreateHostIdentity(options(paths, { randomId: () => identityA }))
    expect(fs.existsSync(paths.historyPath)).toBe(false) // first write: 'missing', not 'stale' - nothing lost yet

    // Something else (a test framework, an old build) regenerates the primary
    // to a different identity without going through this machine's backup.
    regeneratePrimary(paths.storagePath, identityB, '2026-09-26T22:22:00.000Z')
    getOrCreateHostIdentity(options(paths, { randomId: () => identityC })) // reads B back; randomId must not be used

    const entries = historyEntries(paths.historyPath)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ identity: identityA, source: 'superseded' })
    expect(JSON.stringify(entries[0])).not.toContain('machine-a') // the binding itself is never persisted
    expect(fs.statSync(paths.historyPath).mode & 0o777).toBe(0o600)

    // The backup now holds the new primary (B), not A - single-value format unchanged.
    expect(JSON.parse(fs.readFileSync(paths.backupPath, 'utf8'))).toMatchObject({ identity: identityB })
  })

  it('readHostIdentityHistory verifies the machine-bound HMAC and returns identities most-recent-first', () => {
    const paths = layout('read-verified')
    getOrCreateHostIdentity(options(paths, { randomId: () => identityA }))
    regeneratePrimary(paths.storagePath, identityB, '2026-09-26T22:22:00.000Z')
    getOrCreateHostIdentity(options(paths))
    regeneratePrimary(paths.storagePath, identityC, '2026-09-27T00:00:00.000Z')
    getOrCreateHostIdentity(options(paths))

    expect(readHostIdentityHistory(options(paths))).toEqual([identityB, identityA])
    // A different machine (different HMAC key) can never read these entries as valid.
    expect(readHostIdentityHistory(options(paths, { machineBinding: () => 'machine-b' }))).toEqual([])
  })

  it('a tampered history entry (identity edited, MAC left alone) is silently excluded, never trusted', () => {
    const paths = layout('tampered')
    getOrCreateHostIdentity(options(paths, { randomId: () => identityA }))
    regeneratePrimary(paths.storagePath, identityB, '2026-09-26T22:22:00.000Z')
    getOrCreateHostIdentity(options(paths))

    const entries = historyEntries(paths.historyPath)
    entries[0].identity = identityC // forge the identity, leaving the old MAC
    fs.writeFileSync(paths.historyPath, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`)

    expect(readHostIdentityHistory(options(paths))).toEqual([])
  })

  it('deduplicates: an identity already recorded anywhere in history is never appended twice, even across a flip-flop', () => {
    const paths = layout('dedup')
    getOrCreateHostIdentity(options(paths, { randomId: () => identityA }))
    regeneratePrimary(paths.storagePath, identityB, '2026-09-26T00:00:00.000Z')
    getOrCreateHostIdentity(options(paths)) // supersedes A -> history [A]
    regeneratePrimary(paths.storagePath, identityA, '2026-09-26T01:00:00.000Z')
    getOrCreateHostIdentity(options(paths)) // supersedes B -> history [A, B]
    regeneratePrimary(paths.storagePath, identityB, '2026-09-26T02:00:00.000Z')
    getOrCreateHostIdentity(options(paths)) // supersedes A again - already in history, must not duplicate

    expect(historyEntries(paths.historyPath).map((entry) => entry.identity)).toEqual([identityA, identityB])
  })

  it('never floods on the high-frequency "primary unchanged" path: repeated calls with the same identity append nothing', () => {
    const paths = layout('no-flood')
    for (let i = 0; i < 25; i++) getOrCreateHostIdentity(options(paths, { randomId: () => identityA }))
    expect(fs.existsSync(paths.historyPath)).toBe(false)
  })

  it('caps history at historyLimit, dropping the oldest first', () => {
    const paths = layout('cap')
    getOrCreateHostIdentity(options(paths, { randomId: () => identityA, historyLimit: 2 }))
    for (const [identity, createdAt] of [
      [identityB, '2026-09-26T01:00:00.000Z'],
      [identityC, '2026-09-26T02:00:00.000Z'],
      ['40000000-0000-4000-8000-0000000000d4', '2026-09-26T03:00:00.000Z']
    ] as const) {
      const current = JSON.parse(fs.readFileSync(paths.storagePath, 'utf8')).identity
      regeneratePrimary(paths.storagePath, identity, createdAt)
      getOrCreateHostIdentity(options(paths, { historyLimit: 2 }))
      void current
    }
    const entries = historyEntries(paths.historyPath)
    expect(entries).toHaveLength(2)
    // Oldest (A) dropped first; the two most recently superseded remain.
    expect(entries.map((entry) => entry.identity)).toEqual([identityB, identityC])
  })

  it('an explicit storagePath without backupPath keeps history disabled too', () => {
    const paths = layout('history-disabled')
    getOrCreateHostIdentity({ storagePath: paths.storagePath, randomId: () => identityA })
    regeneratePrimary(paths.storagePath, identityB, '2026-09-26T22:22:00.000Z')
    getOrCreateHostIdentity({ storagePath: paths.storagePath, randomId: () => identityC })
    expect(fs.existsSync(paths.historyPath)).toBe(false)
  })

  it('read-only inspection never writes history, even when the primary was regenerated elsewhere', () => {
    const paths = layout('readonly')
    getOrCreateHostIdentity(options(paths, { randomId: () => identityA }))
    regeneratePrimary(paths.storagePath, identityB, '2026-09-26T22:22:00.000Z')
    expect(readHostIdentity(options(paths))).toBe(identityB)
    expect(fs.existsSync(paths.historyPath)).toBe(false)
    expect(readHostIdentityHistory(options(paths))).toEqual([])
  })

  it('never writes through a symlink at the history path', () => {
    const paths = layout('symlink')
    getOrCreateHostIdentity(options(paths, { randomId: () => identityA }))
    const outside = path.join(paths.root, 'outside-history.jsonl')
    fs.writeFileSync(outside, 'outside')
    fs.symlinkSync(outside, paths.historyPath)

    regeneratePrimary(paths.storagePath, identityB, '2026-09-26T22:22:00.000Z')
    expect(() => getOrCreateHostIdentity(options(paths))).not.toThrow()
    expect(fs.readFileSync(outside, 'utf8')).toBe('outside')
    expect(fs.lstatSync(paths.historyPath).isSymbolicLink()).toBe(true)
  })
})

describe('E2E sandbox redirect (packaged-CLI contract and dev-mode e2e launches)', () => {
  function sandbox(label: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `swob-host-identity-e2e-${label}-`))
    roots.push(root)
    return root
  }

  it('redirects the primary and backup into the sandbox when both E2E markers are set, in production', () => {
    const sandboxRoot = sandbox('prod')
    const environment = {
      NODE_ENV: 'production',
      HOME: '/tmp/should-be-ignored',
      SWOB_E2E_RUNNER: 'packaged-cli-contract',
      SWOB_E2E_SANDBOX_ROOT: sandboxRoot
    }
    expect(defaultHostIdentityPath('darwin', environment)).toBe(path.join(sandboxRoot, '.swob-machine', 'host-identity-v1.json'))
    expect(defaultHostIdentityBackupPath('darwin', environment)).toBe(path.join(sandboxRoot, '.claude-session-manager', 'host-identity-v1.json'))
  })

  it('redirects in development mode too (the dangerous dev-mode e2e desktop launch)', () => {
    const sandboxRoot = sandbox('dev')
    const environment = {
      NODE_ENV: 'development',
      SWOB_E2E_RUNNER: 'app-launch-e2e',
      SWOB_E2E_SANDBOX_ROOT: sandboxRoot
    }
    expect(defaultHostIdentityPath('darwin', environment)).toBe(path.join(sandboxRoot, '.swob-machine', 'host-identity-v1.json'))
  })

  it('never redirects with only one of the two markers set (both must be present)', () => {
    const sandboxRoot = sandbox('partial')
    expect(defaultHostIdentityPath('darwin', { NODE_ENV: 'production', SWOB_E2E_SANDBOX_ROOT: sandboxRoot }))
      .toBe('/Users/Shared/Swob/host-identity-v1.json')
    expect(defaultHostIdentityPath('darwin', { NODE_ENV: 'production', SWOB_E2E_RUNNER: 'x' }))
      .toBe('/Users/Shared/Swob/host-identity-v1.json')
    expect(defaultHostIdentityBackupPath('darwin', { NODE_ENV: 'production', HOME: '/tmp/profile-a', SWOB_E2E_SANDBOX_ROOT: sandboxRoot }))
      .toBe('/tmp/profile-a/.claude-session-manager/host-identity-v1.json')
  })

  it('an ordinary production run (no E2E markers) still resolves to the real machine path', () => {
    // This is the reverse-verification pin for deliverable 1: on master, this
    // assertion already holds for the *unmarked* case, but the packaged CLI
    // contract sets both markers (packaged-contract.test.ts:216-217) and, before
    // this fix, defaultHostIdentityPath ignores them entirely and still resolves
    // here - the two 'redirects' tests above are what must fail before the fix.
    expect(defaultHostIdentityPath('darwin', { NODE_ENV: 'production' })).toBe('/Users/Shared/Swob/host-identity-v1.json')
  })

  it('refuses a sandbox subdirectory that is a symlink escaping the declared sandbox root', () => {
    const sandboxRoot = sandbox('escape')
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-host-identity-e2e-outside-'))
    roots.push(outside)
    fs.symlinkSync(outside, path.join(sandboxRoot, '.swob-machine'))
    expect(() => defaultHostIdentityPath('darwin', {
      NODE_ENV: 'production',
      SWOB_E2E_RUNNER: 'x',
      SWOB_E2E_SANDBOX_ROOT: sandboxRoot
    })).toThrow(/sandbox/)
  })

  // resolveLibraryWriterHostIdentityStoragePath calls defaultHostIdentityPath
  // with only a platform argument (no environment) - by design (it is one of
  // the two resolvers this package must not touch), so it only sees the same
  // redirect its sibling backup resolver does when both read the *same*
  // process.env object a real child process actually has, not a synthetic one
  // passed by value. These two tests mutate process.env (saved/restored) to
  // match that real condition instead of passing a private environment object.
  function withProcessEnv<T>(overrides: Record<string, string | undefined>, run: () => T): T {
    const previous = { ...process.env }
    try {
      for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) delete (process.env as Record<string, string | undefined>)[key]
        else process.env[key] = value
      }
      return run()
    } finally {
      for (const key of Object.keys(overrides)) delete (process.env as Record<string, string | undefined>)[key]
      Object.assign(process.env, previous)
    }
  }

  it('the real production entry points (library-writer-lease\'s two resolvers) redirect too, unmodified', () => {
    // This is the reverse-verification pin for deliverable 1, exercised through
    // the actual call chain packaged-contract.test.ts drives: NODE_ENV is
    // 'production' (so the resolvers' own NODE_ENV==='test' + SWOB_TEST_HOME
    // seam does not apply, matching :210-230's real child-process environment,
    // which sets SWOB_TEST_HOME alongside NODE_ENV: 'production' for other
    // reasons), and both E2E markers are set. Before this fix,
    // resolveLibraryWriterHostIdentityStoragePath/BackupPath fall through to
    // defaultHostIdentityPath/BackupPath, which ignored the markers and
    // resolved to /Users/Shared/Swob and the real HOME - so this must fail
    // before the fix and needs no change to either resolver.
    const sandboxRoot = sandbox('resolvers')
    withProcessEnv({
      NODE_ENV: 'production',
      HOME: path.join(sandboxRoot, 'home'),
      SWOB_TEST_HOME: path.join(sandboxRoot, 'home'),
      SWOB_E2E_RUNNER: 'packaged-cli-contract',
      SWOB_E2E_SANDBOX_ROOT: sandboxRoot
    }, () => {
      expect(resolveLibraryWriterHostIdentityStoragePath('darwin'))
        .toBe(path.join(sandboxRoot, '.swob-machine', 'host-identity-v1.json'))
      expect(resolveLibraryWriterHostIdentityBackupPath('darwin'))
        .toBe(path.join(sandboxRoot, '.claude-session-manager', 'host-identity-v1.json'))
    })
  })

  it('an actual identity create through the redirected path lands only inside the sandbox (lstat before/after on the real path)', () => {
    const sandboxRoot = sandbox('full-cycle')
    // Read-only before/after comparison of the real production path, per the
    // task's "只读 lstat 前后比对" requirement: never assert it is absent
    // outright (a real identity may already exist on the machine running this
    // test), only that this call leaves it exactly as found.
    const realPrimaryPath = '/Users/Shared/Swob/host-identity-v1.json'
    const before = (() => { try { return fs.lstatSync(realPrimaryPath) } catch { return null } })()

    const identity = withProcessEnv({
      NODE_ENV: 'production',
      SWOB_E2E_RUNNER: 'packaged-cli-contract',
      SWOB_E2E_SANDBOX_ROOT: sandboxRoot
    }, () => getOrCreateHostIdentity({
      storagePath: resolveLibraryWriterHostIdentityStoragePath('darwin'),
      backupPath: resolveLibraryWriterHostIdentityBackupPath('darwin'),
      machineBinding: () => 'sandbox-machine'
    }))

    expect(identity).toMatch(/^[0-9a-f-]{36}$/)
    expect(fs.existsSync(path.join(sandboxRoot, '.swob-machine', 'host-identity-v1.json'))).toBe(true)
    expect(fs.existsSync(path.join(sandboxRoot, '.claude-session-manager', 'host-identity-v1.json'))).toBe(true)

    const after = (() => { try { return fs.lstatSync(realPrimaryPath) } catch { return null } })()
    expect(Boolean(after)).toBe(Boolean(before))
    if (before && after) {
      expect({ ino: after.ino, size: after.size, mtimeMs: after.mtimeMs })
        .toEqual({ ino: before.ino, size: before.size, mtimeMs: before.mtimeMs })
    }
  })
})

