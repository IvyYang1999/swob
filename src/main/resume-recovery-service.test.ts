import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionMeta } from './library-manager'
import {
  ensureClaudeResumeTarget,
  recoveryLockPath
} from './resume-recovery-service'

const SESSION_ID = '81000000-0000-4000-8000-000000000001'
const USER_UUID = '81000000-0000-4000-8000-000000000011'
const ASSISTANT_UUID = '81000000-0000-4000-8000-000000000012'
const PHYSICAL_ID = '81000000-0000-4000-8000-000000000002'

let tmpRoot: string
let homeDir: string
let libraryDir: string
let projectsRoot: string
let sourcePath: string
let backupPath: string
let backup: Buffer

function validBackup(userText = 'recover me'): Buffer {
  return Buffer.from([
    JSON.stringify({
      uuid: USER_UUID,
      parentUuid: null,
      sessionId: SESSION_ID,
      type: 'user',
      timestamp: '2026-07-19T00:00:00.000Z',
      cwd: '/fixture/project',
      message: { role: 'user', content: userText }
    }),
    JSON.stringify({
      uuid: ASSISTANT_UUID,
      parentUuid: USER_UUID,
      sessionId: SESSION_ID,
      type: 'assistant',
      timestamp: '2026-07-19T00:01:00.000Z',
      cwd: '/fixture/project',
      message: { role: 'assistant', content: 'recovered' }
    })
  ].join('\n') + '\n')
}

function continuationBackup(): Buffer {
  return Buffer.from([
    JSON.stringify({
      uuid: USER_UUID,
      parentUuid: null,
      sessionId: SESSION_ID,
      type: 'user',
      message: { role: 'user', content: 'logical start' }
    }),
    JSON.stringify({
      uuid: '81000000-0000-4000-8000-000000000013',
      parentUuid: null,
      sessionId: PHYSICAL_ID,
      type: 'summary',
      leafUuid: USER_UUID
    }),
    JSON.stringify({
      uuid: ASSISTANT_UUID,
      parentUuid: '81000000-0000-4000-8000-000000000013',
      sessionId: PHYSICAL_ID,
      type: 'assistant',
      message: { role: 'assistant', content: 'physical continuation' }
    })
  ].join('\n') + '\n')
}

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    schemaVersion: 2,
    sessionId: SESSION_ID,
    sourceFilePaths: [sourcePath],
    createdAt: '2026-07-19T00:00:00.000Z',
    updatedAt: '2026-07-19T00:01:00.000Z',
    projectPath: '-fixture-project',
    backupSha256: createHash('sha256').update(backup).digest('hex'),
    backupSize: backup.length,
    origin: {
      deviceId: 'local-installation',
      hostname: 'fixture-host',
      username: 'fixture-user',
      capturedAt: '2026-07-19T00:00:00.000Z'
    },
    sourceInstance: { kind: 'claude-default', configDir: path.join(homeDir, '.claude') },
    ...overrides
  }
}

function ensure(overrides: Partial<Parameters<typeof ensureClaudeResumeTarget>[0]> = {}) {
  return ensureClaudeResumeTarget({
    sessionId: SESSION_ID,
    libraryMeta: meta(),
    backupPath,
    homeDir,
    localDeviceId: 'local-installation',
    localUsername: 'fixture-user',
    lockTimeoutMs: 80,
    lockPollMs: 5,
    ...overrides
  })
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-recovery-service-'))
  homeDir = path.join(tmpRoot, 'home')
  libraryDir = path.join(tmpRoot, 'library')
  projectsRoot = path.join(homeDir, '.claude', 'projects')
  sourcePath = path.join(projectsRoot, '-fixture-project', `${SESSION_ID}.jsonl`)
  backupPath = path.join(libraryDir, 'backup.jsonl')
  backup = validBackup()
  fs.mkdirSync(projectsRoot, { recursive: true })
  fs.mkdirSync(libraryDir, { recursive: true })
  fs.writeFileSync(backupPath, backup)
})

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

describe('atomic Claude resume recovery transaction', () => {
  it('publishes exact bytes with mode 0600 and verifies the final target', async () => {
    const result = await ensure()

    expect(result).toMatchObject({ ok: true, state: 'restored', sourcePath })
    expect(fs.readFileSync(sourcePath).equals(backup)).toBe(true)
    expect(fs.statSync(sourcePath).mode & 0o777).toBe(0o600)
    expect(fs.readdirSync(path.dirname(sourcePath))).toEqual([`${SESSION_ID}.jsonl`])
  })

  it('coalesces concurrent callers and never overwrites an already published target', async () => {
    const results = await Promise.all([ensure(), ensure(), ensure()])

    expect(results.every((result) => result.ok)).toBe(true)
    expect(results.filter((result) => result.ok && result.state === 'restored')).toHaveLength(3)
    expect(fs.readFileSync(sourcePath).equals(backup)).toBe(true)
  })

  it('does not mistake an old logical shard for the selected missing physical continuation', async () => {
    const oldLogicalPath = sourcePath
    fs.mkdirSync(path.dirname(oldLogicalPath), { recursive: true })
    fs.writeFileSync(oldLogicalPath, validBackup())
    sourcePath = path.join(projectsRoot, '-fixture-project', `${PHYSICAL_ID}.jsonl`)
    backup = continuationBackup()
    fs.writeFileSync(backupPath, backup)
    const continuationMeta = meta({ sourceFilePaths: [oldLogicalPath, sourcePath] })

    const result = await ensure({
      libraryMeta: continuationMeta,
      physicalSessionId: PHYSICAL_ID
    })

    expect(result).toMatchObject({ ok: true, state: 'restored', sourcePath })
    expect(fs.readFileSync(sourcePath).equals(backup)).toBe(true)
  })

  it('accepts an exact existing target as idempotent but refuses a mismatched conflict', async () => {
    const existingPath = path.join(projectsRoot, '-other-project', `${SESSION_ID}.jsonl`)
    fs.mkdirSync(path.dirname(existingPath), { recursive: true })
    fs.writeFileSync(existingPath, backup, { mode: 0o600 })

    await expect(ensure()).resolves.toMatchObject({
      ok: true,
      state: 'already-present',
      sourcePath: existingPath
    })

    const conflicting = validBackup('different bytes')
    fs.writeFileSync(existingPath, conflicting)
    const result = await ensure()
    expect(result).toMatchObject({ ok: false, reason: 'target-conflict', sourcePath: existingPath })
    expect(fs.readFileSync(existingPath).equals(conflicting)).toBe(true)
  })

  it('fails closed on invalid or unverified backup bytes without creating the target', async () => {
    fs.writeFileSync(backupPath, '{broken\n')
    await expect(ensure({
      libraryMeta: meta({
        backupSha256: createHash('sha256').update('{broken\n').digest('hex'),
        backupSize: Buffer.byteLength('{broken\n')
      })
    })).resolves.toMatchObject({ ok: false, reason: 'invalid-backup' })
    expect(fs.existsSync(sourcePath)).toBe(false)

    fs.writeFileSync(backupPath, backup)
    await expect(ensure({
      libraryMeta: meta({ backupSha256: undefined, backupSize: undefined })
    })).resolves.toMatchObject({ ok: false, reason: 'unverified-backup' })
    expect(fs.existsSync(sourcePath)).toBe(false)
  })

  it('refuses symlink traversal and leaves the symlink destination untouched', async () => {
    const outside = path.join(tmpRoot, 'outside')
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, path.dirname(sourcePath))

    await expect(ensure()).resolves.toMatchObject({ ok: false, reason: 'target-instance-untrusted' })
    expect(fs.existsSync(path.join(outside, `${SESSION_ID}.jsonl`))).toBe(false)
  })

  it('honors a cross-process lock instead of writing through it', async () => {
    const lockPath = recoveryLockPath(projectsRoot, 'claude-default', SESSION_ID)
    fs.mkdirSync(path.dirname(lockPath), { recursive: true })
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAt: Date.now() }), {
      flag: 'wx',
      mode: 0o600
    })

    await expect(ensure()).resolves.toMatchObject({ ok: false, reason: 'recovery-locked' })
    expect(fs.existsSync(sourcePath)).toBe(false)
  })

  it('reclaims a lock whose recorded owner process is dead', async () => {
    const lockPath = recoveryLockPath(projectsRoot, 'claude-default', SESSION_ID)
    fs.mkdirSync(path.dirname(lockPath), { recursive: true })
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 2_147_483_647, createdAt: 0 }), {
      flag: 'wx',
      mode: 0o600
    })

    await expect(ensure()).resolves.toMatchObject({ ok: true, state: 'restored' })
    expect(fs.readFileSync(sourcePath).equals(backup)).toBe(true)
  })
})
