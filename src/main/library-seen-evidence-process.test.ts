import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawn } from 'node:child_process'
import { build } from 'vite'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-t130-seen-'))
const testHome = path.join(tempRoot, 'home')
const bundleDir = path.join(tempRoot, 'bundle')
const workerEntry = path.join(__dirname, '__fixtures__', 't130-seen-evidence-worker.ts')
const workerBundle = path.join(bundleDir, 'worker.mjs')

beforeAll(async () => {
  fs.mkdirSync(path.join(testHome, '.claude-session-manager'), { recursive: true })
  fs.writeFileSync(path.join(testHome, '.claude-session-manager', 'app-config.json'), JSON.stringify({
    deviceId: 't130-seen-device'
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

function runWorker(args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerBundle, ...args], {
      env: { ...process.env, HOME: testHome },
      stdio: ['ignore', 'ignore', 'pipe']
    })
    let stderr = ''
    child.stderr.setEncoding('utf-8')
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('exit', (code) => resolve({ code, stderr }))
  })
}

describe('durable logical seen evidence', () => {
  it('blocks legacy v1/v2 recreation after authoritative scans, disappearance, and process restarts', async () => {
    for (const schemaVersion of [undefined, 2] as const) {
      const suffix = schemaVersion === 2 ? 'v2' : 'v1'
      const libraryRoot = path.join(tempRoot, `library-${suffix}`)
      const packageDir = path.join(libraryRoot, 'legacy-package')
      const movedRoot = path.join(tempRoot, `moved-${suffix}`)
      const sessionId = schemaVersion === 2
        ? 'bc000000-0000-4000-8000-0000000000bc'
        : 'bd000000-0000-4000-8000-0000000000bd'
      const sourcePath = path.join(testHome, '.claude', 'projects', '-fixture', `${sessionId}.jsonl`)
      fs.mkdirSync(packageDir, { recursive: true })
      fs.mkdirSync(movedRoot)
      fs.writeFileSync(path.join(packageDir, '.swob-session.json'), JSON.stringify({
        ...(schemaVersion === 2 ? { schemaVersion } : {}),
        sessionId,
        sourceFilePaths: [sourcePath],
        createdAt: '2026-07-22T00:00:00.000Z',
        updatedAt: '2026-07-22T00:01:00.000Z',
        projectPath: '/fixture/project'
      }))

      const observed = await runWorker(['scan', libraryRoot, sourcePath, sessionId])
      expect(observed.code, observed.stderr).toBe(0)
      const evidenceDir = path.join(libraryRoot, '.swob', 'logical-sessions')
      expect(fs.readdirSync(evidenceDir).filter((name) => name.endsWith('.seen.json'))).toHaveLength(1)
      expect(fs.readFileSync(path.join(packageDir, '.swob-session.json'), 'utf-8')).not.toContain('packageId')

      fs.renameSync(packageDir, path.join(movedRoot, 'legacy-package'))
      // Semantic change (t206): a legacy package never commits a package-id
      // reservation, so after it disappears the identity is seen-only.
      // Blocking recreation forever would strand migration-lost sessions;
      // first-time recreation from the live source is allowed and lossless.
      // A committed-reservation package that disappears still stays MISSING
      // (covered by library-logical-identity.integration.test.ts).
      const retried = await runWorker(['ensure', libraryRoot, sourcePath, sessionId])
      expect(retried.code, retried.stderr).toBe(0)
      const recreated = fs.readdirSync(libraryRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name !== '.swob')
      expect(recreated).toHaveLength(1)
      const evidence = fs.readFileSync(path.join(evidenceDir, fs.readdirSync(evidenceDir)[0]), 'utf-8')
      expect(evidence).not.toContain(sessionId)
      expect(evidence).not.toContain(sourcePath)
    }
  }, 20_000)
})
