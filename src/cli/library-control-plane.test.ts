import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { deriveHostBootIdentity, deriveLibraryHostProof } from '../main/host-identity'
import { inspectLibraryWriterLease, type LibrarySession } from '../main/library-manager'
import { buildSessionLocation, inspectWriterLock, type WriterLockStatus } from './library-control-plane'

const unlockedWriter: WriterLockStatus = {
  state: 'unlocked',
  ownerPid: null,
  ownerAlive: null,
  mode: null,
  reason: null,
  heartbeatAt: null,
  leaseExpiresAt: null,
  leaseExpired: null,
  evidenceHash: null,
  manualRecoveryAvailable: false,
  whyNotRecoverable: null
}

function testSession(
  dirPath: string,
  sessionId: string,
  sourceFilePaths: string[],
  canonicalRecordsFile?: string
): LibrarySession {
  return {
    sessionId,
    dirPath,
    mdPath: path.join(dirPath, 'transcript.md'),
    jsonlPath: path.join(dirPath, 'backup.jsonl'),
    isSymlink: false,
    meta: {
      sessionId,
      sourceFilePaths,
      createdAt: '2026-08-02T00:00:00.000Z',
      updatedAt: '2026-08-02T00:00:00.000Z',
      projectPath: '/test',
      ...(canonicalRecordsFile
        ? { canonicalProvider: { recordsFile: canonicalRecordsFile } }
        : {})
    }
  } as LibrarySession
}

describe('CLI writer lock doctor', () => {
  let libraryRoot: string

  beforeEach(() => {
    libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-cli-doctor-lock-'))
  })

  afterEach(() => {
    fs.rmSync(libraryRoot, { recursive: true, force: true })
  })

  it('只输出 owner 存活事实与阻塞原因，不泄漏 device/boot/process 指纹', () => {
    const lockDir = path.join(libraryRoot, '.swob', 'locks', 'library-writer')
    const hostIdentity = '00000000-0000-4000-8000-000000000193'
    const hostProofSalt = '10000000-0000-4000-8000-000000000193'
    const rawBootIdentity = 'private-boot-identity'
    fs.mkdirSync(lockDir, { recursive: true })
    fs.writeFileSync(path.join(lockDir, 'owner.owner.json'), JSON.stringify({
      schemaVersion: 2,
      ownerNonce: 'private-owner-nonce',
      deviceId: 'private-device-id',
      pid: 193,
      bootIdentity: deriveHostBootIdentity(hostIdentity, rawBootIdentity, hostProofSalt),
      processStartFingerprint: 'private-process-fingerprint',
      hostProof: deriveLibraryHostProof(hostIdentity, hostProofSalt),
      hostProofSalt,
      mode: 'maintenance',
      acquiredAt: '2026-08-02T00:00:00.000Z',
      heartbeatAt: '2026-08-02T00:00:01.000Z',
      leaseExpiresAt: '2026-08-02T00:00:16.000Z'
    }))

    const result = inspectWriterLock(libraryRoot, {
      now: () => Date.parse('2026-08-02T00:00:02.000Z'),
      bootIdentity: () => rawBootIdentity,
      processStartFingerprint: () => 'private-process-fingerprint',
      hostIdentity: () => hostIdentity
    })

    expect(result).toMatchObject({
      state: 'blocked',
      ownerAlive: true,
      mode: 'maintenance',
      reason: 'active-owner',
      leaseExpired: false,
      evidenceHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      manualRecoveryAvailable: false
    })
    expect(result.whyNotRecoverable).toContain('不会抢锁')
    const formalInspection = inspectLibraryWriterLease(libraryRoot, {
      pid: 202,
      bootIdentity: () => rawBootIdentity,
      processStartFingerprint: (pid) => pid === 202 ? 'caller-start' : 'private-process-fingerprint',
      hostIdentity: () => hostIdentity
    })
    expect(result.evidenceHash).toBe(formalInspection.evidenceHash)
    expect(result.manualRecoveryAvailable).toBe(formalInspection.manualRecoveryAvailable)
    const output = JSON.stringify(result)
    for (const secret of [
      'private-owner-nonce', 'private-device-id', rawBootIdentity,
      'private-process-fingerprint', hostIdentity, hostProofSalt
    ]) {
      expect(output).not.toContain(secret)
    }
  })

  it('死亡 owner 可见但只读 doctor 不会把它伪装成已恢复', () => {
    const lockDir = path.join(libraryRoot, '.swob', 'locks', 'library-writer')
    fs.mkdirSync(lockDir, { recursive: true })
    fs.writeFileSync(path.join(lockDir, 'owner.owner.json'), JSON.stringify({
      schemaVersion: 1,
      ownerNonce: 'nonce',
      deviceId: 'device',
      pid: 193,
      bootIdentity: 'boot',
      processStartFingerprint: 'start',
      mode: 'transcript',
      acquiredAt: '2026-08-02T00:00:00.000Z',
      heartbeatAt: '2026-08-02T00:00:01.000Z',
      leaseExpiresAt: '2026-08-02T00:00:16.000Z'
    }))

    const result = inspectWriterLock(libraryRoot, {
      now: () => Date.parse('2026-08-02T01:00:00.000Z'),
      bootIdentity: () => 'boot',
      processStartFingerprint: () => 'missing'
    })
    expect(result).toMatchObject({
      state: 'blocked',
      ownerAlive: false,
      reason: 'unverifiable-owner',
      leaseExpired: true,
      evidenceHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      manualRecoveryAvailable: true,
      whyNotRecoverable: null
    })
    const formalInspection = inspectLibraryWriterLease(libraryRoot, {
      pid: 202,
      bootIdentity: () => 'boot',
      processStartFingerprint: (pid) => pid === 202 ? 'caller-start' : 'missing',
      hostIdentity: () => '00000000-0000-4000-8000-000000000193'
    })
    expect(result.evidenceHash).toBe(formalInspection.evidenceHash)
    expect(result.manualRecoveryAvailable).toBe(formalInspection.manualRecoveryAvailable)
    expect(fs.existsSync(lockDir)).toBe(true)
  })

  it('unlocked doctor 不创建 .swob 或 host identity', () => {
    const testHome = path.join(libraryRoot, 'machine-home')
    const previous = process.env.SWOB_TEST_HOME
    process.env.SWOB_TEST_HOME = testHome
    try {
      expect(inspectWriterLock(libraryRoot)).toMatchObject({ state: 'unlocked' })
      expect(fs.existsSync(path.join(libraryRoot, '.swob'))).toBe(false)
      expect(fs.existsSync(path.join(testHome, '.swob-machine'))).toBe(false)
    } finally {
      if (previous === undefined) delete process.env.SWOB_TEST_HOME
      else process.env.SWOB_TEST_HOME = previous
    }
  })

  it('unexpected lock entry 由 t190 权威 parser 判定 corrupt-owner', () => {
    const lockDir = path.join(libraryRoot, '.swob', 'locks', 'library-writer')
    fs.mkdirSync(lockDir, { recursive: true })
    fs.writeFileSync(path.join(lockDir, 'unexpected.txt'), 'retained evidence')

    expect(inspectWriterLock(libraryRoot, {
      bootIdentity: () => 'boot',
      processStartFingerprint: () => 'start',
      hostIdentity: () => '00000000-0000-4000-8000-000000000193'
    })).toMatchObject({
      state: 'blocked',
      reason: 'corrupt-owner',
      manualRecoveryAvailable: true,
      evidenceHash: expect.stringMatching(/^[0-9a-f]{64}$/)
    })
  })
})

describe('CLI freshness consumes the t192 stat-only contract', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-cli-freshness-'))
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('local missing replicas are syncing below 60s and stale above 60s', () => {
    const recentDir = path.join(root, 'recent')
    const oldDir = path.join(root, 'old')
    fs.mkdirSync(recentDir)
    fs.mkdirSync(oldDir)
    for (const [dirPath, ageMs] of [[recentDir, 30_000], [oldDir, 90_000]] as const) {
      fs.writeFileSync(path.join(dirPath, '.swob-session.json'), '{}')
      const source = path.join(dirPath, 'source.jsonl')
      fs.writeFileSync(source, '{}\n')
      const time = new Date(Date.now() - ageMs)
      fs.utimesSync(source, time, time)
    }

    const recent = buildSessionLocation(
      testSession(recentDir, 'recent', [path.join(recentDir, 'source.jsonl')]),
      unlockedWriter
    ).freshness
    const old = buildSessionLocation(
      testSession(oldDir, 'old', [path.join(oldDir, 'source.jsonl')]),
      unlockedWriter
    ).freshness

    expect(recent).toMatchObject({ basis: 'local-source', status: 'syncing', stale: false })
    expect(recent.lagMs).toBeLessThan(60_000)
    expect(old).toMatchObject({ basis: 'local-source', status: 'stale', stale: true })
    expect(old.reasons).toEqual(expect.arrayContaining(['TRANSCRIPT_MISSING', 'BACKUP_MISSING']))
  })

  it('canonical package does not require backup.jsonl', () => {
    fs.writeFileSync(path.join(root, '.swob-session.json'), '{}')
    fs.writeFileSync(path.join(root, 'records.jsonl'), '{}\n')
    fs.writeFileSync(path.join(root, 'transcript.md'), '# canonical')

    const location = buildSessionLocation(
      testSession(root, 'canonical', [], 'records.jsonl'),
      unlockedWriter
    )
    expect(location.canonicalRecords).toMatchObject({
      path: path.join(root, 'records.jsonl'),
      exists: true
    })
    expect(location.freshness).toMatchObject({
      basis: 'canonical-records',
      status: 'fresh',
      stale: false,
      requiredArtifacts: ['canonical-records', 'transcript']
    })
  })

  it('missing source and clock skew remain unverifiable with null lag', () => {
    fs.writeFileSync(path.join(root, '.swob-session.json'), '{}')
    const missing = buildSessionLocation(testSession(root, 'missing', []), unlockedWriter).freshness
    expect(missing).toMatchObject({ status: 'unverifiable', lagMs: null, stale: false })
    expect(missing.reasons).toContain('SOURCE_UNAVAILABLE')

    const futureSource = path.join(root, 'future.jsonl')
    fs.writeFileSync(futureSource, '{}\n')
    const future = new Date(Date.now() + 60_000)
    fs.utimesSync(futureSource, future, future)
    const skewed = buildSessionLocation(testSession(root, 'skewed', [futureSource]), unlockedWriter).freshness
    expect(skewed).toMatchObject({ status: 'unverifiable', lagMs: null, stale: false })
    expect(skewed.reasons).toContain('CLOCK_SKEW')
  })
})
