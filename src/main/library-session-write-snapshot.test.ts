import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawn } from 'node:child_process'
import { build } from 'vite'
import { recoverIncompleteSessionWriteSnapshot } from './library-session-write-snapshot'
import { runWithLibraryWriter } from './library-write-coordinator'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-t190-snapshot-crash-'))
const bundleDir = path.join(tempRoot, 'bundle')
const workerEntry = path.join(__dirname, '__fixtures__', 't190-session-snapshot-crash-worker.ts')
const workerBundle = path.join(bundleDir, 'worker.mjs')

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

function crashWorker(libraryRoot: string, sessionDir: string, stage: string): Promise<NodeJS.Signals | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerBundle, libraryRoot, sessionDir, stage], {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let killed = false
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      if (!killed && String(chunk).includes(stage)) {
        killed = true
        child.kill('SIGKILL')
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('exit', (_code, signal) => {
      if (!killed) reject(new Error(`crash worker did not reach ${stage}: ${stderr}`))
      else resolve(signal)
    })
  })
}

describe('Library session durable write snapshot', () => {
  it('矩阵 8：进程在 transcript、backup 或 manifest 任一步 SIGKILL 后都能恢复旧一致快照', async () => {
    const stages = ['transcript.md', 'backup.jsonl', '.swob-session.json'] as const
    for (const crashAfter of stages) {
      const root = path.join(tempRoot, `library-${crashAfter}`)
      const sessionDir = path.join(root, 'session')
      fs.mkdirSync(sessionDir, { recursive: true })
      const oldFiles = {
        'transcript.md': '# old transcript\n',
        'backup.jsonl': '{"snapshot":"old"}\n',
        '.swob-session.json': JSON.stringify({
          schemaVersion: 3,
          sessionId: 'old',
          updatedAt: '2026-08-01T00:00:00.000Z'
        })
      }
      for (const [name, content] of Object.entries(oldFiles)) fs.writeFileSync(path.join(sessionDir, name), content)

      expect(await crashWorker(root, sessionDir, crashAfter)).toBe('SIGKILL')
      expect(fs.existsSync(path.join(sessionDir, '.swob-write-transaction.json'))).toBe(true)

      // Acquiring the next root writer first proves the dead child lease can be
      // recovered; only then may the durable package snapshot be restored.
      await runWithLibraryWriter(root, 'recovery-profile', 'maintenance', () => {
        expect(recoverIncompleteSessionWriteSnapshot(root, sessionDir)).toBe(true)
      }, { timeoutMs: 1_000, eventSink: () => {} })

      for (const [name, content] of Object.entries(oldFiles)) {
        expect(fs.readFileSync(path.join(sessionDir, name), 'utf8'), `${crashAfter} -> ${name}`).toBe(content)
      }
      expect(fs.existsSync(path.join(sessionDir, '.swob-write-transaction.json'))).toBe(false)
      expect(fs.existsSync(path.join(sessionDir, '.swob-write-snapshots'))).toBe(false)
    }
  }, 20_000)
})
