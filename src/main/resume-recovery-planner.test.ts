import { describe, expect, it } from 'vitest'
import * as path from 'path'
import { RECOVERY_SYNTHETIC_FIXTURES } from './__fixtures__/resume-recovery-synthetic'
import {
  classifyRecoverySourcePath,
  planSessionRecovery,
  type RecoveryPlannerInput,
  type RecoveryTargetInstance
} from './resume-recovery-planner'

function cloneFixture(name: keyof typeof RECOVERY_SYNTHETIC_FIXTURES): RecoveryPlannerInput {
  return structuredClone(RECOVERY_SYNTHETIC_FIXTURES[name])
}

function standardTarget(overrides: Partial<RecoveryTargetInstance> = {}): RecoveryTargetInstance {
  return {
    id: 'standard-xx…1001',
    kind: 'standard',
    projectsRoot: '/fixture/home-xx…1001/.claude/projects',
    configDir: '/fixture/home-xx…1001/.claude',
    available: true,
    trusted: true,
    existingFiles: [],
    ...overrides
  }
}

describe('recovery planner synthetic 253-shape fixtures', () => {
  it('normal: routes a standard source to the standard instance', () => {
    expect(() => JSON.parse(RECOVERY_SYNTHETIC_FIXTURES.normal.evidence.jsonl.trim())).not.toThrow()
    const result = planSessionRecovery(cloneFixture('normal'))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source.kind).toBe('standard')
    expect(result.target.instanceKind).toBe('standard')
    expect(result.target.route).toBe('original-instance')
    expect(result.materializeFiles).toEqual([])
  })

  it('logical/physical double ID: preserves the physical filename and resume ID', () => {
    const evidenceIds = RECOVERY_SYNTHETIC_FIXTURES.logicalPhysicalDoubleId.evidence.jsonl
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).sessionId)
    expect(new Set(evidenceIds).size).toBe(2)
    const result = planSessionRecovery(cloneFixture('logicalPhysicalDoubleId'))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.logicalSessionId).toBe('20000000-0000-4000-8000-000000000002')
    expect(result.physicalSessionId).toBe('30000000-0000-4000-8000-000000000003')
    expect(path.basename(result.target.path)).toBe('30000000-0000-4000-8000-000000000003.jsonl')
  })

  it('malformed line: refuses a backup already rejected by strict validation', () => {
    expect(() => JSON.parse(RECOVERY_SYNTHETIC_FIXTURES.malformedLine.evidence.jsonl.trim())).toThrow()
    const result = planSessionRecovery(cloneFixture('malformedLine'))
    expect(result).toMatchObject({
      ok: false,
      reason: 'invalid-backup',
      diagnostic: 'malformed-line-xx…0004'
    })
  })

  it('iCloud placeholder metadata: returns the exact logical file to materialize', () => {
    const input = cloneFixture('icloudPlaceholder')
    expect(RECOVERY_SYNTHETIC_FIXTURES.icloudPlaceholder.evidence.placeholderName)
      .toBe('.backup.jsonl.icloud-xx…0005')
    const result = planSessionRecovery(input)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state).toBe('needs-materialization')
    expect(result.materializeFiles).toEqual([input.backup.path])
  })
})

describe('recovery target routing and conflicts', () => {
  it('refuses a target whose trusted inventory result was omitted', () => {
    const input = cloneFixture('normal')
    delete (input.targetInstances[0] as Partial<RecoveryTargetInstance>).trusted

    expect(planSessionRecovery(input)).toMatchObject({
      ok: false,
      reason: 'target-inventory-incomplete'
    })
  })

  it('refuses a target whose existing-file inventory was omitted', () => {
    const input = cloneFixture('normal')
    delete (input.targetInstances[0] as Partial<RecoveryTargetInstance>).existingFiles

    expect(planSessionRecovery(input)).toMatchObject({
      ok: false,
      reason: 'target-inventory-incomplete'
    })
  })

  it('refuses a completely omitted target inventory instead of guessing', () => {
    const input = cloneFixture('normal')
    delete (input as Partial<RecoveryPlannerInput>).targetInstances

    expect(planSessionRecovery(input)).toMatchObject({
      ok: false,
      reason: 'missing-target-inventory'
    })
  })

  it('predicts an existing same-name target and refuses to overwrite it', () => {
    const input = cloneFixture('normal')
    const sourcePath = input.libraryMeta.sourceFilePaths[0]
    input.targetInstances[0].existingFiles = [{ path: sourcePath }]

    const result = planSessionRecovery(input)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('target-conflict')
    expect(result.conflicts.map((item) => item.code)).toContain('target-path-exists')
  })

  it('predicts the same physical ID anywhere else in the target instance', () => {
    const input = cloneFixture('logicalPhysicalDoubleId')
    input.targetInstances[0].existingFiles = [{
      path: '/fixture/home-xx…0001/.claude/projects/-other-xx…1002/duplicate-xx…1002.jsonl',
      physicalSessionId: '30000000-0000-4000-8000-000000000003'
    }]

    const result = planSessionRecovery(input)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.conflicts).toEqual([{
      code: 'physical-id-exists',
      path: '/fixture/home-xx…0001/.claude/projects/-other-xx…1002/duplicate-xx…1002.jsonl',
      physicalSessionId: '30000000-0000-4000-8000-000000000003'
    }])
  })

  it('treats a case-only target-path difference as an APFS-default conflict', () => {
    const input = cloneFixture('normal')
    input.targetInstances[0].existingFiles = [{
      path: input.libraryMeta.sourceFilePaths[0].toUpperCase()
    }]

    expect(planSessionRecovery(input)).toMatchObject({
      ok: false,
      reason: 'target-conflict',
      conflicts: [{ code: 'target-path-exists' }]
    })
  })

  it('routes an existing Claude Window source back to its matching instance', () => {
    const sessionId = '60000000-0000-4000-8000-000000000006'
    const input = cloneFixture('normal')
    input.sessionId = sessionId
    input.libraryMeta.sessionId = sessionId
    input.libraryMeta.sourceFilePaths = [
      `/fixture/home-xx…1003/.claude-window/window-xx…1003/projects/-fixture-project-xx…1003/${sessionId}.jsonl`
    ]
    input.targetInstances = [{
      id: 'window-xx…1003',
      kind: 'claude-window',
      projectsRoot: '/fixture/home-xx…1003/.claude-window/window-xx…1003/projects',
      configDir: '/fixture/home-xx…1003/.claude-window/window-xx…1003',
      available: true,
      trusted: true,
      existingFiles: []
    }, standardTarget()]

    const result = planSessionRecovery(input)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.target).toMatchObject({
      instanceId: 'window-xx…1003',
      instanceKind: 'claude-window',
      route: 'original-instance'
    })
  })

  it('refuses a Claude Window target whose configDir was omitted', () => {
    const sessionId = '61000000-0000-4000-8000-000000000006'
    const input = cloneFixture('normal')
    input.sessionId = sessionId
    input.libraryMeta.sessionId = sessionId
    input.libraryMeta.sourceFilePaths = [
      `/fixture/home-xx…1003/.claude-window/window-xx…1003/projects/-fixture-project-xx…1003/${sessionId}.jsonl`
    ]
    input.targetInstances = [{
      id: 'window-xx…1003',
      kind: 'claude-window',
      projectsRoot: '/fixture/home-xx…1003/.claude-window/window-xx…1003/projects',
      available: true,
      trusted: true,
      existingFiles: []
    }]

    expect(planSessionRecovery(input)).toMatchObject({
      ok: false,
      reason: 'target-instance-missing-config-dir'
    })
  })

  it('imports a vanished Claude Window instance into the available standard instance', () => {
    const sessionId = '70000000-0000-4000-8000-000000000007'
    const input = cloneFixture('normal')
    input.sessionId = sessionId
    input.libraryMeta.sessionId = sessionId
    input.libraryMeta.sourceFilePaths = [
      `/fixture/old-home-xx…1004/.claude-window/gone-xx…1004/projects/-fixture-project-xx…1004/${sessionId}.jsonl`
    ]
    input.targetInstances = [standardTarget()]

    const result = planSessionRecovery(input)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.target.instanceKind).toBe('standard')
    expect(result.target.route).toBe('import-to-standard')
  })

  it('refuses a non-standard source until a standard/window target is explicitly selected', () => {
    const input = cloneFixture('normal')
    input.libraryMeta.sourceFilePaths = [
      '/fixture/custom-store-xx…1005/project-xx…1005/10000000-0000-4000-8000-000000000001.jsonl'
    ]
    input.targetInstances = [standardTarget()]

    expect(planSessionRecovery(input)).toMatchObject({
      ok: false,
      reason: 'non-standard-source-requires-explicit-target',
      source: { kind: 'non-standard' }
    })

    input.preferredTargetInstanceId = 'standard-xx…1001'
    const selected = planSessionRecovery(input)
    expect(selected.ok).toBe(true)
    if (!selected.ok) return
    expect(selected.target.route).toBe('selected-import')
    expect(selected.target.instanceKind).toBe('standard')
  })

  it('uses deviceId—not username—to block an implicit restore from another installation', () => {
    const input = cloneFixture('normal')
    input.localDeviceId = 'device-xx…2002'
    input.libraryMeta.origin = {
      deviceId: 'device-xx…2001',
      hostname: 'host-xx…2001',
      username: 'same-user-xx…2001',
      capturedAt: '2026-07-19T00:00:00.000Z'
    }

    expect(planSessionRecovery(input)).toMatchObject({
      ok: false,
      reason: 'remote-source-requires-explicit-target'
    })
  })

  it('refuses origin metadata when the caller omitted the local installation ID', () => {
    const input = cloneFixture('normal')
    delete input.localDeviceId

    expect(planSessionRecovery(input)).toMatchObject({
      ok: false,
      reason: 'missing-local-device-id'
    })
  })

  it('uses the legacy remote-state resolver to block a different-username path', () => {
    const input = cloneFixture('normal')
    delete input.libraryMeta.origin
    input.localUsername = 'local-user-xx…2003'
    input.libraryMeta.projectPath =
      '/Users/remote-user-xx…2003/.claude/projects/-Users-remote-user-xx…2003-project'

    expect(planSessionRecovery(input)).toMatchObject({
      ok: false,
      reason: 'remote-source-requires-explicit-target'
    })
  })

  it('refuses an implicit legacy plan when localUsername was omitted', () => {
    const input = cloneFixture('normal')
    delete input.libraryMeta.origin
    delete input.localUsername

    expect(planSessionRecovery(input)).toMatchObject({
      ok: false,
      reason: 'missing-local-username'
    })
  })
})

describe('recovery path classification', () => {
  it('classifies a standard path lexically', () => {
    const result = classifyRecoverySourcePath(
      '/fixture/home-xx…3001/.claude/projects/-fixture-project-xx…3001/80000000-0000-4000-8000-000000000008.jsonl'
    )
    expect(result.kind).toBe('standard')
  })

  it('在非 Windows 测试机上也能按 path.win32 识别盘符源路径', () => {
    const result = classifyRecoverySourcePath(
      'C:\\Users\\Alice\\.claude\\projects\\C--Users-Alice-project\\80000000-0000-4000-8000-000000000008.jsonl'
    )
    expect(result).toMatchObject({
      kind: 'standard',
      configDir: 'C:\\Users\\Alice\\.claude',
      projectDirName: 'C--Users-Alice-project',
      fileName: '80000000-0000-4000-8000-000000000008.jsonl'
    })
  })
})
