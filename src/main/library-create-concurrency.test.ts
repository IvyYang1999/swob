import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawn } from 'node:child_process'
import { build } from 'vite'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-t130-processes-'))
const libraryRoot = path.join(tempRoot, 'library')
const testHome = path.join(tempRoot, 'home')
const bundleDir = path.join(tempRoot, 'bundle')
const workerEntry = path.join(__dirname, '__fixtures__', 't130-concurrent-ensure-worker.ts')
const workerBundle = path.join(bundleDir, 'worker.mjs')

beforeAll(async () => {
  fs.mkdirSync(libraryRoot, { recursive: true })
  fs.mkdirSync(path.join(testHome, '.claude-session-manager'), { recursive: true })
  fs.writeFileSync(path.join(testHome, '.claude-session-manager', 'app-config.json'), JSON.stringify({
    deviceId: 't130-concurrency-device'
  }))
  await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      ssr: workerEntry,
      outDir: bundleDir,
      emptyOutDir: true,
      rollupOptions: {
        output: { format: 'es', entryFileNames: 'worker.mjs' }
      }
    }
  })
  fs.symlinkSync(
    path.join(process.cwd(), 'node_modules'),
    path.join(bundleDir, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
})

afterAll(() => fs.rmSync(tempRoot, { recursive: true, force: true }))

function runWorker(sourcePath: string, sessionId: string): Promise<{ code: number | null; stderr: string; pid: number }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [workerBundle, libraryRoot, sourcePath, sessionId], {
      env: { ...process.env, HOME: testHome },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stderr = ''
    let stdout = ''
    child.stdout.setEncoding('utf-8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf-8')
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('exit', (code) => resolve({ code, stderr, pid: Number(stdout.trim()) }))
  })
}

function findManifests(dirPath: string): string[] {
  const results: string[] = []
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const fullPath = path.join(dirPath, entry.name)
    if (!entry.isDirectory()) continue
    const manifest = path.join(fullPath, '.swob-session.json')
    if (fs.existsSync(manifest)) results.push(manifest)
    else results.push(...findManifests(fullPath))
  }
  return results
}

describe('multi-process session creation', () => {
  it('lets 12 processes ensure one logical session while creating exactly one package', async () => {
    const sessionId = '50000000-0000-4000-8000-000000000005'
    const sourcePath = path.join(testHome, '.claude', 'projects', '-fixture', `${sessionId}.jsonl`)
    const results = await Promise.all(Array.from({ length: 12 }, () => runWorker(sourcePath, sessionId)))

    expect(results, results.map((result) => result.stderr).join('\n')).toSatisfy(
      (items: Array<{ code: number | null }>) => items.every((item) => item.code === 0)
    )
    expect(new Set(results.map((result) => result.pid)).size).toBe(12)
    const manifests = findManifests(libraryRoot)
    expect(manifests).toHaveLength(1)
    const meta = JSON.parse(fs.readFileSync(manifests[0], 'utf-8'))
    expect(meta).toMatchObject({ schemaVersion: 3, sessionId, packageId: expect.any(String) })
  }, 20_000)
})
