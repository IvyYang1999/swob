import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { build } from 'vite'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-t190-production-crash-'))
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

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

function rows(sessionId: string, turns: number): unknown[] {
  const result: unknown[] = []
  for (let index = 1; index <= turns; index++) {
    result.push({
      uuid: `${sessionId}-u${index}`,
      parentUuid: index === 1 ? null : `${sessionId}-a${index - 1}`,
      sessionId,
      type: 'user',
      timestamp: `2026-08-02T00:0${index * 2 - 2}:00.000Z`,
      cwd: tempRoot,
      message: { role: 'user', content: index === 2 ? 'second user turn' : 'first user turn' }
    })
    result.push({
      uuid: `${sessionId}-a${index}`,
      parentUuid: `${sessionId}-u${index}`,
      sessionId,
      type: 'assistant',
      timestamp: `2026-08-02T00:0${index * 2 - 1}:00.000Z`,
      cwd: tempRoot,
      message: { role: 'assistant', content: `assistant turn ${index}` }
    })
  }
  return result
}

function jsonl(records: unknown[]): Buffer {
  return Buffer.from(records.map((record) => JSON.stringify(record)).join('\n') + '\n')
}

function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stderr = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('exit', (code, signal) => resolve({ code, signal, stderr }))
  })
}

function spawnWorker(
  mode: 'baseline-verify' | 'crash' | 'recover-verify',
  libraryRoot: string,
  sessionDir: string,
  evidencePath: string,
  stage?: 'transcript' | 'backup' | 'manifest'
): ChildProcess {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: path.join(tempRoot, 'home'),
    NODE_ENV: 'test',
    SWOB_TEST_HOME: tempRoot,
    SWOB_E2E_SANDBOX_ROOT: tempRoot,
    SWOB_LIBRARY_ROOT: libraryRoot
  }
  if (stage) {
    environment.SWOB_TEST_SESSION_WRITE_CRASH_STAGE = stage
    environment.SWOB_TEST_SESSION_WRITE_CRASH_SIGNAL = path.join(tempRoot, `crash-${stage}.signal`)
  } else {
    delete environment.SWOB_TEST_SESSION_WRITE_CRASH_STAGE
    delete environment.SWOB_TEST_SESSION_WRITE_CRASH_SIGNAL
  }
  return spawn(process.execPath, [workerBundle, mode, libraryRoot, sessionDir, evidencePath], {
    env: environment,
    stdio: ['ignore', 'ignore', 'pipe']
  })
}

function prepareSessionPackage(
  sessionDir: string,
  sessionId: string,
  sourcePath: string,
  oldBackup: Buffer
): void {
  fs.mkdirSync(sessionDir, { recursive: true })
  fs.writeFileSync(path.join(sessionDir, 'transcript.md'), '# old transcript\n')
  fs.writeFileSync(path.join(sessionDir, 'backup.jsonl'), oldBackup)
  fs.writeFileSync(path.join(sessionDir, '.swob-session.json'), JSON.stringify({
    sessionId,
    sourceFilePaths: [sourcePath],
    createdAt: '2026-08-02T00:00:00.000Z',
    updatedAt: '2026-08-02T00:01:00.000Z',
    projectPath: tempRoot,
    turnCount: 1,
    backupSha256: sha256(oldBackup),
    backupSize: oldBackup.length
  }))
}

interface SessionPackageEvidence {
  transcriptSha256: string
  backupSha256: string
  manifestSha256: string
  sourceSha256: string
  manifestBackupSha256: string
  turnCount: number
  transcriptTurns: number
}

function readEvidence(evidencePath: string): SessionPackageEvidence {
  return JSON.parse(fs.readFileSync(evidencePath, 'utf8')) as SessionPackageEvidence
}

describe('Library session durable write snapshot', () => {
  it('矩阵 8：三个生产发布点 SIGKILL 恢复后的 transcript/backup/manifest 与无崩溃基线逐字节一致', async () => {
    const stages = ['transcript', 'backup', 'manifest'] as const
    const sessionId = 't190-production-exact'
    const sourcePath = path.join(tempRoot, 'home', '.claude', 'projects', '-t190-production', `${sessionId}.jsonl`)
    const oldBackup = jsonl(rows(sessionId, 1))
    const newSource = jsonl(rows(sessionId, 2))
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true })
    // All four production runs share the exact same source inode, timestamps,
    // session id and initial package so manifest source-state bytes are comparable.
    fs.writeFileSync(sourcePath, newSource)

    const baselineRoot = path.join(tempRoot, 'library-baseline')
    const baselineSessionDir = path.join(baselineRoot, 'session')
    const baselineEvidencePath = path.join(tempRoot, 'verified-baseline.json')
    prepareSessionPackage(baselineSessionDir, sessionId, sourcePath, oldBackup)
    const baseline = await waitForExit(spawnWorker(
      'baseline-verify', baselineRoot, baselineSessionDir, baselineEvidencePath
    ))
    expect(baseline, baseline.stderr).toMatchObject({ code: 0, signal: null })
    const baselineEvidence = readEvidence(baselineEvidencePath)
    expect(baselineEvidence).toMatchObject({
      backupSha256: sha256(newSource),
      sourceSha256: sha256(newSource),
      manifestBackupSha256: sha256(newSource),
      turnCount: 2,
      transcriptTurns: 2
    })

    for (const stage of stages) {
      const libraryRoot = path.join(tempRoot, `library-${stage}`)
      const sessionDir = path.join(libraryRoot, 'session')
      const evidencePath = path.join(tempRoot, `verified-${stage}.json`)
      prepareSessionPackage(sessionDir, sessionId, sourcePath, oldBackup)

      const crashed = await waitForExit(spawnWorker('crash', libraryRoot, sessionDir, evidencePath, stage))
      expect(crashed, crashed.stderr).toMatchObject({ signal: 'SIGKILL' })
      expect(fs.readFileSync(path.join(tempRoot, `crash-${stage}.signal`), 'utf8')).toBe(`${stage}\n`)
      expect(fs.existsSync(path.join(sessionDir, '.swob-write-transaction.json'))).toBe(true)

      const recovered = await waitForExit(spawnWorker('recover-verify', libraryRoot, sessionDir, evidencePath))
      expect(recovered, recovered.stderr).toMatchObject({ code: 0, signal: null })
      const evidence = readEvidence(evidencePath)
      expect(evidence).toMatchObject({
        backupSha256: sha256(newSource),
        sourceSha256: sha256(newSource),
        manifestBackupSha256: sha256(newSource),
        turnCount: 2,
        transcriptTurns: 2
      })
      expect({
        transcriptSha256: evidence.transcriptSha256,
        backupSha256: evidence.backupSha256,
        manifestSha256: evidence.manifestSha256
      }, `${stage} recovery must equal the no-crash production baseline byte-for-byte`).toEqual({
        transcriptSha256: baselineEvidence.transcriptSha256,
        backupSha256: baselineEvidence.backupSha256,
        manifestSha256: baselineEvidence.manifestSha256
      })
    }
  }, 30_000)
})
