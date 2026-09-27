import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { deriveHostBootIdentity, deriveLibraryHostProof } from '../main/host-identity'
import { inspectLibraryWriterLease, type LibrarySession } from '../main/library-manager'
import {
  buildSessionLocation,
  inspectWriterLock,
  recoverWriterLock,
  type WriterLockStatus
} from './library-control-plane'

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
  whyNotRecoverable: null,
  deviceIdCaveat: null
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

  it('F1l-c P2-3: remote-owner 且 owner deviceId 与本机相同 → deviceIdCaveat 提示残余风险', () => {
    const lockDir = path.join(libraryRoot, '.swob', 'locks', 'library-writer')
    const otherHost = '40000000-0000-4000-8000-000000000905'
    const salt = '50000000-0000-4000-8000-000000000905'
    fs.mkdirSync(lockDir, { recursive: true })
    fs.writeFileSync(path.join(lockDir, 'owner.owner.json'), JSON.stringify({
      schemaVersion: 2,
      ownerNonce: 'nonce',
      deviceId: 'shared-device-id',
      pid: 905,
      bootIdentity: deriveHostBootIdentity(otherHost, 'other-boot', salt),
      processStartFingerprint: 'start-905',
      hostProof: deriveLibraryHostProof(otherHost, salt),
      hostProofSalt: salt,
      mode: 'maintenance',
      acquiredAt: '2026-08-02T00:00:00.000Z',
      heartbeatAt: '2026-08-02T00:00:01.000Z',
      leaseExpiresAt: '2026-08-02T00:00:16.000Z'
    }))

    const local = inspectWriterLock(libraryRoot, {
      bootIdentity: () => 'this-boot',
      hostIdentity: () => '60000000-0000-4000-8000-000000000906', // does not match otherHost: hostProof mismatches
      localDeviceId: 'shared-device-id'
    })
    expect(local).toMatchObject({ reason: 'remote-owner' })
    expect(local.deviceIdCaveat).toMatch(/deviceId.*相同|相同.*deviceId/)
    expect(local.deviceIdCaveat).not.toContain('shared-device-id') // the value itself is never echoed

    const foreign = inspectWriterLock(libraryRoot, {
      bootIdentity: () => 'this-boot',
      hostIdentity: () => '60000000-0000-4000-8000-000000000906',
      localDeviceId: 'a-different-installation'
    })
    expect(foreign).toMatchObject({ reason: 'remote-owner' })
    expect(foreign.deviceIdCaveat).toBeNull()

    const noLocalDeviceId = inspectWriterLock(libraryRoot, {
      bootIdentity: () => 'this-boot',
      hostIdentity: () => '60000000-0000-4000-8000-000000000906'
    })
    expect(noLocalDeviceId).toMatchObject({ reason: 'remote-owner' })
    // No localDeviceId override: falls back to this test process's real
    // installation deviceId (read-only, via loadAppConfig), which will never
    // coincidentally equal 'shared-device-id'.
    expect(noLocalDeviceId.deviceIdCaveat).toBeNull()
  })

  it('doctor locks --recover 对本机存活 owner 拒绝（active-owner），不进入写路径', () => {
    const lockDir = path.join(libraryRoot, '.swob', 'locks', 'library-writer')
    const hostIdentity = '00000000-0000-4000-8000-000000000194'
    const hostProofSalt = '10000000-0000-4000-8000-000000000194'
    fs.mkdirSync(lockDir, { recursive: true })
    fs.writeFileSync(path.join(lockDir, 'live.owner.json'), JSON.stringify({
      schemaVersion: 2,
      ownerNonce: 'live',
      deviceId: 'device',
      pid: 194,
      bootIdentity: deriveHostBootIdentity(hostIdentity, 'boot', hostProofSalt),
      processStartFingerprint: 'start-194',
      hostProof: deriveLibraryHostProof(hostIdentity, hostProofSalt),
      hostProofSalt,
      mode: 'maintenance',
      acquiredAt: '2026-08-02T00:00:00.000Z',
      heartbeatAt: '2026-08-02T00:00:01.000Z',
      leaseExpiresAt: '2026-08-02T00:00:16.000Z'
    }))
    const options = {
      pid: 202,
      bootIdentity: () => 'boot',
      hostIdentity: () => hostIdentity,
      processStartFingerprint: (pid: number) => pid === 194 ? 'start-194' : 'caller-start',
      eventSink: () => {}
    }
    const inspection = inspectWriterLock(libraryRoot, options)
    expect(inspection).toMatchObject({ state: 'blocked', reason: 'active-owner', manualRecoveryAvailable: false })

    expect(recoverWriterLock({
      recover: true,
      evidence: inspection.evidenceHash!,
      confirmation: 'RECOVER_LIBRARY_WRITER_LOCK'
    }, libraryRoot, options)).toEqual({ recovered: false, reason: 'active-owner' })
    expect(fs.readdirSync(lockDir)).toEqual(['live.owner.json'])
    expect(fs.existsSync(path.join(libraryRoot, '.swob', 'locks', 'writer-recovery-evidence'))).toBe(false)
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

describe('F1l-c ③: 被拒的恢复请求不建身份（M16 钉子：断言文件系统副作用，不只是返回值）', () => {
  // recoverLibraryWriterLeaseManually unconditionally calls prepareAcquisition
  // (which calls getOrCreateHostIdentity) before its own unlocked/evidence-
  // changed/active-owner checks; recoverWriterLock's read-only precheck
  // (inspectLibraryWriterLease) is the only thing standing between a rejected
  // request and that side effect. A mutant that deletes the precheck still
  // returns the exact same { recovered: false, reason } - only the identity
  // file, its backup, and .swob-machine appearing prove the difference, which
  // is why this asserts the filesystem, not recoverWriterLock's return value.
  let libraryRoot: string
  let machineHome: string
  let previousTestHome: string | undefined

  beforeEach(() => {
    libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-cli-doctor-m16-'))
    machineHome = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-cli-doctor-m16-home-'))
    previousTestHome = process.env.SWOB_TEST_HOME
    process.env.SWOB_TEST_HOME = machineHome
  })

  afterEach(() => {
    if (previousTestHome === undefined) delete process.env.SWOB_TEST_HOME
    else process.env.SWOB_TEST_HOME = previousTestHome
    fs.rmSync(libraryRoot, { recursive: true, force: true })
    fs.rmSync(machineHome, { recursive: true, force: true })
  })

  const identityPath = () => path.join(machineHome, '.swob-machine', 'host-identity-v1.json')
  const backupPath = () => path.join(machineHome, '.claude-session-manager', 'host-identity-v1.json')

  /** No machine identity (primary or backup) was created - the actual pin. */
  function assertNoIdentitySideEffects(): void {
    expect(fs.existsSync(identityPath())).toBe(false)
    expect(fs.existsSync(backupPath())).toBe(false)
  }

  /** Nothing at all yet: no identity, and no .swob (used only before any lock is set up). */
  function assertPristine(): void {
    assertNoIdentitySideEffects()
    expect(fs.existsSync(path.join(libraryRoot, '.swob'))).toBe(false)
  }

  function writeV1Owner(bootIdentity: string, pid: number, deviceId = 'foreign-device'): void {
    const lockDir = path.join(libraryRoot, '.swob', 'locks', 'library-writer')
    fs.mkdirSync(lockDir, { recursive: true })
    fs.writeFileSync(path.join(lockDir, 'incident.owner.json'), JSON.stringify({
      schemaVersion: 1,
      ownerNonce: 'incident',
      deviceId,
      pid,
      bootIdentity,
      processStartFingerprint: `start-${pid}`,
      mode: 'maintenance',
      acquiredAt: '2026-09-04T01:00:00.000Z',
      heartbeatAt: '2026-09-04T01:00:00.000Z',
      leaseExpiresAt: '2026-09-04T01:00:15.000Z'
    }))
  }

  it('unlocked 拒绝：没有锁，什么身份文件都不建', () => {
    assertPristine()
    const outcome = recoverWriterLock({
      recover: true, evidence: '0'.repeat(64), confirmation: 'RECOVER_LIBRARY_WRITER_LOCK'
    }, libraryRoot)
    expect(outcome).toEqual({ recovered: false, reason: 'unlocked' })
    assertPristine()
  })

  it('evidence-changed 拒绝（错哈希）：只读预检不建身份', () => {
    // A v1 (legacy) owner needs no host identity at all to be inspected or to
    // compute its evidenceHash - this isolates the pin from any real identity
    // ever needing to exist, so the assertion is unambiguous either way. The
    // caller's own pid (not the owner's) must still resolve to a real
    // fingerprint - if prepareAcquisition is ever reached (the mutation this
    // pin targets), it must fail by creating identity, not by throwing for an
    // unrelated reason first.
    writeV1Owner('boot-a', 76437)
    const options = {
      bootIdentity: () => 'different-boot',
      processStartFingerprint: (pid: number) => pid === 76437 ? 'missing' : 'caller-start'
    }
    const inspected = inspectWriterLock(libraryRoot, options)
    assertNoIdentitySideEffects() // read-only inspection itself must not create anything either
    const wrongHash = (inspected.evidenceHash ?? '').replace(/^./, (inspected.evidenceHash?.[0] === '0' ? '1' : '0'))

    const outcome = recoverWriterLock({
      recover: true, evidence: wrongHash, confirmation: 'RECOVER_LIBRARY_WRITER_LOCK'
    }, libraryRoot, options)
    expect(outcome).toEqual({ recovered: false, reason: 'evidence-changed' })
    assertNoIdentitySideEffects()
  })

  it('active-owner 拒绝：本机存活 owner，只读预检识别出来但不建身份', () => {
    writeV1Owner('boot-live', 76437, 'this-install')
    const options = { bootIdentity: () => 'boot-live', processStartFingerprint: (pid: number) => pid === 76437 ? 'start-76437' : 'caller-start' }
    const inspected = inspectWriterLock(libraryRoot, options)
    expect(inspected).toMatchObject({ state: 'blocked', reason: 'active-owner', manualRecoveryAvailable: false })
    assertNoIdentitySideEffects()

    const outcome = recoverWriterLock({
      recover: true, evidence: inspected.evidenceHash!, confirmation: 'RECOVER_LIBRARY_WRITER_LOCK'
    }, libraryRoot, options)
    expect(outcome).toEqual({ recovered: false, reason: 'active-owner' })
    assertNoIdentitySideEffects()
    expect(fs.readdirSync(path.join(libraryRoot, '.swob', 'locks', 'library-writer'))).toEqual(['incident.owner.json'])
  })

  it('正对照：一个真正被允许的恢复（dead owner，非本机存活）确实建立身份 - 钉子只挡「拒绝」这三条，不挡正常恢复', () => {
    // Same v1-owner shape as the rejected cases, but the boot/pid facts make it
    // provably dead rather than active, so manualRecoveryAvailable is true.
    writeV1Owner('boot-dead', 76437, 'this-install')
    const options = {
      bootIdentity: () => 'boot-dead',
      // The owner (pid 76437) is dead; the caller's own pid must still resolve
      // to a real fingerprint, or prepareAcquisition refuses for a different
      // reason (its own process-start check, unrelated to this pin).
      processStartFingerprint: (pid: number) => pid === 76437 ? 'missing' : 'caller-start'
    }
    const inspected = inspectWriterLock(libraryRoot, options)
    expect(inspected).toMatchObject({ state: 'blocked', reason: 'unverifiable-owner', manualRecoveryAvailable: true })
    assertNoIdentitySideEffects() // still nothing from the read-only precheck itself

    const outcome = recoverWriterLock({
      recover: true, evidence: inspected.evidenceHash!, confirmation: 'RECOVER_LIBRARY_WRITER_LOCK'
    }, libraryRoot, options)
    expect(outcome).toMatchObject({ recovered: true, reason: 'recovered' })
    // A genuine, allowed recovery legitimately needs this machine's identity to
    // write the recovery claim - unlike the three rejections above, it is
    // expected (and required) to create it.
    expect(fs.existsSync(identityPath())).toBe(true)
    expect(fs.existsSync(backupPath())).toBe(true)
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
