import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { build } from 'vite'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-t133-processes-'))
const libraryRoot = path.join(tempRoot, 'library')
const testHome = path.join(tempRoot, 'home')
const bundleDir = path.join(tempRoot, 'bundle')
const signalPath = path.join(tempRoot, 'writer')
const workerEntry = path.join(__dirname, '__fixtures__', 't133-library-writer-worker.ts')
const workerBundle = path.join(bundleDir, 'worker.mjs')

beforeAll(async () => {
  fs.mkdirSync(path.join(libraryRoot, '原始位置'), { recursive: true })
  fs.mkdirSync(path.join(libraryRoot, '目标'), { recursive: true })
  fs.writeFileSync(path.join(libraryRoot, '原始位置', '.swob-session.json'), JSON.stringify({
    sessionId: 'session-a',
    sourceFilePaths: [],
    createdAt: '2026-07-22T00:00:00.000Z',
    updatedAt: '2026-07-22T00:00:00.000Z',
    projectPath: '/synthetic'
  }))
  fs.mkdirSync(path.join(testHome, '.claude-session-manager'), { recursive: true })
  fs.writeFileSync(path.join(testHome, '.claude-session-manager', 'app-config.json'), JSON.stringify({
    deviceId: 't133-shared-device'
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

function startWorker(mode: 'hold' | 'move', userData: string): ChildProcess {
  return spawn(process.execPath, [workerBundle, mode, libraryRoot, signalPath], {
    env: { ...process.env, HOME: testHome, SWOB_TEST_USER_DATA: userData },
    stdio: ['ignore', 'ignore', 'pipe']
  })
}

function waitForExit(child: ChildProcess): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    let stderr = ''
    child.stderr?.setEncoding('utf-8')
    child.stderr?.on('data', (chunk) => { stderr += chunk })
    child.on('exit', (code) => resolve({ code, stderr }))
  })
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path.basename(filePath)}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('Library writer multi-process contract', () => {
  it('GUI maintenance 与不同 userData 的 CLI move 只能串行；busy 后重试不产生 (2)', async () => {
    const gui = startWorker('hold', path.join(tempRoot, 'gui-user-data'))
    const guiExit = waitForExit(gui)
    await waitForFile(`${signalPath}.ready`)

    const blocked = await waitForExit(startWorker('move', path.join(tempRoot, 'cli-user-data')))
    expect(blocked.code).toBe(1)
    expect(blocked.stderr).toContain('LibraryWriterBusyError:LIBRARY_WRITER_BUSY')
    expect(fs.existsSync(path.join(libraryRoot, '原始位置'))).toBe(true)

    fs.writeFileSync(`${signalPath}.release`, 'release')
    expect((await guiExit).code).toBe(0)
    const moved = await waitForExit(startWorker('move', path.join(tempRoot, 'cli-user-data')))
    expect(moved, moved.stderr).toMatchObject({ code: 0 })
    expect(fs.existsSync(path.join(libraryRoot, '目标', '原始位置', '.swob-session.json'))).toBe(true)
    expect(fs.existsSync(path.join(libraryRoot, '目标', '原始位置 (2)'))).toBe(false)
  }, 15_000)
})
