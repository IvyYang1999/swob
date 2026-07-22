import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawn } from 'node:child_process'
import { build } from 'vite'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-t130-crash-'))
const testHome = path.join(tempRoot, 'home')
const bundleDir = path.join(tempRoot, 'bundle')
const workerEntry = path.join(__dirname, '__fixtures__', 't130-crash-publish-worker.ts')
const workerBundle = path.join(bundleDir, 'worker.mjs')

beforeAll(async () => {
  fs.mkdirSync(path.join(testHome, '.claude-session-manager'), { recursive: true })
  fs.writeFileSync(path.join(testHome, '.claude-session-manager', 'app-config.json'), JSON.stringify({
    deviceId: 't130-crash-device'
  }))
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

function runWorker(
  libraryRoot: string,
  sourcePath: string,
  sessionId: string,
  stage: string,
  killAtStage = false
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerBundle, libraryRoot, sourcePath, sessionId, stage], {
      env: { ...process.env, HOME: testHome },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stderr = ''
    let killed = false
    child.stdout.setEncoding('utf-8')
    child.stdout.on('data', (chunk) => {
      if (killAtStage && !killed && String(chunk).includes(stage)) {
        killed = true
        child.kill('SIGKILL')
      }
    })
    child.stderr.setEncoding('utf-8')
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('exit', (code, signal) => resolve({ code, signal, stderr }))
  })
}

function findEvidence(libraryRoot: string): { manifests: string[]; incomplete: string[] } {
  const manifests: string[] = []
  const incomplete: string[] = []
  const walk = (dirPath: string): void => {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === '.swob') continue
      const child = path.join(dirPath, entry.name)
      if (fs.existsSync(path.join(child, '.swob-session.json'))) manifests.push(child)
      if (fs.existsSync(path.join(child, '.swob-incomplete.json')) || entry.name.startsWith('.swob-create-')) {
        incomplete.push(child)
      }
      walk(child)
    }
  }
  walk(libraryRoot)
  return { manifests, incomplete }
}

describe('session publish crash recovery', () => {
  const stages = {
    'before-publish-reservation': 'dd000000-0000-4000-8000-0000000000dd',
    'publish-directory-created': 'df000000-0000-4000-8000-0000000000df',
    'publish-directory-durable': 'de000000-0000-4000-8000-0000000000de',
    'incomplete-durable': 'e0000000-0000-4000-8000-00000000000e',
    'manifest-durable': 'f0000000-0000-4000-8000-00000000000f'
  } as const

  for (const [stage, sessionId] of Object.entries(stages)) {
    it(`recovers a real child SIGKILL at ${stage} without duplicate or hidden temp evidence`, async () => {
      const libraryRoot = path.join(tempRoot, `library-${stage}`)
      fs.mkdirSync(libraryRoot)
      const sourcePath = path.join(testHome, '.claude', 'projects', '-fixture', `${sessionId}.jsonl`)

      const killed = await runWorker(libraryRoot, sourcePath, sessionId, stage, true)
      expect(killed.signal).toBe('SIGKILL')
      const retried = await runWorker(libraryRoot, sourcePath, sessionId, 'none')
      expect(retried.code, retried.stderr).toBe(0)

      const evidence = findEvidence(libraryRoot)
      expect(evidence.manifests).toHaveLength(1)
      expect(evidence.incomplete).toEqual([])
      expect(fs.readdirSync(libraryRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name !== '.swob')).toHaveLength(1)
      const meta = JSON.parse(fs.readFileSync(path.join(evidence.manifests[0], '.swob-session.json'), 'utf-8'))
      expect(meta).toMatchObject({ schemaVersion: 3, sessionId, packageId: expect.any(String) })
      const reservationNames = fs.readdirSync(path.join(libraryRoot, '.swob', 'package-ids'))
      expect(reservationNames.filter((name) => /^[0-9a-f]{64}\.json$/.test(name))).toHaveLength(1)
      expect(reservationNames.filter((name) => name.endsWith('.committed.json'))).toHaveLength(1)
      const claimDir = path.join(libraryRoot, '.swob', 'publish-paths')
      expect(fs.existsSync(claimDir) ? fs.readdirSync(claimDir) : []).toEqual([])
    }, 20_000)
  }
})
