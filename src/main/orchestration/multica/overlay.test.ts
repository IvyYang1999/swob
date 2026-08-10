import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { TRUTH_KERNEL_GOLDEN_FIXTURE } from '../../../shared/contracts/truth-kernel/fixtures/golden-v1'
import { validateTruthKernelGoldenFixture } from '../../../shared/contracts/truth-kernel/validator'
import type { TruthKernelGoldenFixture } from '../../../shared/contracts/truth-kernel'
import {
  deduplicateTranscriptSources,
  discoverMulticaRoots,
  identifyTranscriptSource,
  mergeMulticaMetadataCheckpoint,
  multicaDoctor,
  parseMulticaWorkspace,
  parseMulticaWorkspaceBytes,
  projectMulticaOverlay,
  readMulticaWorkspace,
  reconcileMulticaUsage
} from './index'

const fixturePath = path.join(__dirname, 'fixtures', 'native-workspace-v04.json')
const physicalFixturePath = path.join(__dirname, 'fixtures', 'physical-identity-cases.json')
const temporary: string[] = []
afterEach(() => { for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true }) })

describe('Multica native read-only orchestration overlay', () => {
  it('uses win32 semantics for drive, UNC, Desktop/profile roots and physical-root deduplication', () => {
    const windows = discoverMulticaRoots({
      platform: 'win32', homeDir: 'D:\\fallback', env: { USERPROFILE: 'C:\\Users\\test', MULTICA_WORKSPACES_ROOT: 'C:\\Data\\Multica' },
      profileRoots: [
        { profile: 'desktop-api.multica.ai', path: '\\\\server\\share\\desktop', desktop: true },
        { profile: 'alias', path: 'c:\\DATA\\multica\\', desktop: false }
      ],
      customRoots: ['D:\\Custom\\multica'], exists: () => true, readable: () => true,
      physicalIdentity: (candidate) => candidate.toLowerCase().includes('data\\multica') ? 'volume:42:file:7' : candidate.toLowerCase()
    })
    expect(windows.filter((root) => root.physicalIdentity === 'volume:42:file:7')).toHaveLength(1)
    expect(windows).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'C:\\Data\\Multica', source: 'environment' }),
      expect.objectContaining({ path: '\\\\server\\share\\desktop', source: 'desktop-profile' }),
      expect.objectContaining({ path: 'D:\\Custom\\multica', source: 'custom' })
    ]))
  })

  it('deduplicates hard-link, symlink/junction, worktree, bare-store and cross-volume copy identities but preserves divergent bytes', () => {
    const fixture = JSON.parse(fs.readFileSync(physicalFixturePath, 'utf8')) as {
      sessionId: string
      sources: Array<{ locator: string; realPath: string; device: string; fileId: string; content: 'same' | 'changed' }>
      expectedLogicalSources: number
      expectedAliasesForSameBytes: number
    }
    const same = new TextEncoder().encode('{"session_id":"11111111-1111-1111-1111-111111111111"}\n')
    const changed = new TextEncoder().encode('{"session_id":"11111111-1111-1111-1111-111111111111","changed":true}\n')
    const sources = fixture.sources.map((entry) => identifyTranscriptSource({
      locator: entry.locator, realPath: entry.realPath, device: entry.device, fileId: entry.fileId,
      logicalSessionId: fixture.sessionId, bytes: entry.content === 'same' ? same : changed
    }))
    const deduped = deduplicateTranscriptSources(sources)
    expect(deduped).toHaveLength(fixture.expectedLogicalSources)
    expect(deduped[0].aliases).toHaveLength(fixture.expectedAliasesForSameBytes)
    expect(deduped[1].sha256).not.toBe(deduped[0].sha256)
  })

  it('reads bounded native roots, markers and exact source bytes without a real Multica workspace', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-t211f-'))
    temporary.push(home)
    const root = path.join(home, 'multica_workspaces_desktop-api.multica.ai')
    const task1 = path.join(root, 'workspace-1', 'task-1')
    const task2 = path.join(root, 'workspace-1', 'task-2')
    const sessions = path.join(task1, 'codex-home', 'sessions', '2026', '08', '11')
    fs.mkdirSync(sessions, { recursive: true })
    fs.mkdirSync(task2, { recursive: true })
    fs.copyFileSync(fixturePath, path.join(task1, 'multica-orchestration.json'))
    fs.writeFileSync(path.join(task1, '.gc_meta.json'), '{"kind":"task","task_id":"T1"}')
    const rollout = path.join(sessions, 'rollout-11111111-1111-1111-1111-111111111111.jsonl')
    fs.writeFileSync(rollout, '{"session_id":"11111111-1111-1111-1111-111111111111"}\n')
    fs.linkSync(rollout, path.join(sessions, 'rollout-hardlink.jsonl'))
    fs.mkdirSync(path.join(task2, 'codex-home'), { recursive: true })
    fs.symlinkSync(path.join(task1, 'codex-home', 'sessions'), path.join(task2, 'codex-home', 'sessions'), 'dir')

    const result = readMulticaWorkspace({ platform: 'darwin', homeDir: home })
    expect(result.roots).toContainEqual(expect.objectContaining({ source: 'desktop-profile', exists: true, readable: true }))
    expect(result.taskRoots).toHaveLength(2)
    expect(result.metadataSnapshots.map((entry) => entry.kind)).toEqual(expect.arrayContaining(['gc-meta', 'orchestration-export']))
    expect(result.transcriptSources).toHaveLength(1)
    // Two names in the physical store are each observed through the task-home junction.
    expect(result.transcriptSources[0].aliases).toHaveLength(4)
    expect(result.parsed.entities.some((entry) => entry.kind === 'workspace')).toBe(true)
    const retained = mergeMulticaMetadataCheckpoint(undefined, result.metadataSnapshots, '2026-08-11T00:00:00.000Z')
    expect(mergeMulticaMetadataCheckpoint(retained, [], '2026-08-12T00:00:00.000Z').snapshots).toEqual(retained.snapshots)
    expect(result.diagnostics).toEqual([])
  })

  it('projects complete attempt/verifier/barrier semantics and hashes exact source bytes', () => {
    const bytes = fs.readFileSync(fixturePath)
    const digest = createHash('sha256').update(bytes).digest('hex')
    const parsed = parseMulticaWorkspaceBytes(bytes, fixturePath, '2026-08-11T00:00:00.000Z')
    const projection = projectMulticaOverlay({
      discovery: { platform: 'linux', homeDir: '/fixture', schemaVersion: parsed.schemaVersion, exists: () => true, readable: () => true },
      entities: parsed.entities,
      usages: parsed.usages
    })
    expect(projection.entities).toHaveLength(18)
    expect(projection.runs).toHaveLength(4)
    expect(projection.sessionLinks).toHaveLength(3)
    expect(projection.entities[0].evidence[0]).toMatchObject({ digest, capturedAt: '2026-08-11T00:00:00.000Z', grade: 'B' })
    expect(projection.semantics.attempts.find((entry) => entry.attemptId === 'A-queued')).toMatchObject({ isDuplicate: true, duplicateOf: 'A-running', successful: false })
    expect(projection.semantics.attempts.find((entry) => entry.attemptId === 'A-cancelled')).toMatchObject({ successful: false })
    expect(projection.semantics.verifiers.map((entry) => [entry.outcome, entry.successful])).toEqual(expect.arrayContaining([['accepted', true], ['rejected', false], ['cancelled', false]]))
    expect(projection.semantics.stageBarriers).toEqual(expect.arrayContaining([
      expect.objectContaining({ stageId: 'S-closed', satisfied: false }),
      expect.objectContaining({ stageId: 'S-open', satisfied: true })
    ]))
    expect(projection.entityLinks).toEqual(expect.arrayContaining([
      expect.objectContaining({ fromEntityId: 'multica-workspace-W1', toEntityId: 'multica-project-P1', relation: 'parent-of' }),
      expect.objectContaining({ fromEntityId: 'multica-project-P1', toEntityId: 'multica-issue-I1', relation: 'parent-of' }),
      expect.objectContaining({ fromEntityId: 'multica-agent-AG1', toEntityId: 'multica-task-T1', relation: 'executes' })
    ]))
    expect(projection.entityLinks.map((entry) => entry.relation)).toEqual(expect.arrayContaining(['parent-of', 'executes', 'contains', 'verifies', 'uses-evidence', 'produced-by']))
    const endpointIds = new Set(projection.entities.map((entity) => entity.orchestrationEntityId))
    expect(projection.entityLinks.every((edge) => endpointIds.has(edge.fromEntityId) && endpointIds.has(edge.toEntityId))).toBe(true)
    const contractFixture: TruthKernelGoldenFixture = structuredClone(TRUTH_KERNEL_GOLDEN_FIXTURE)
    contractFixture.orchestrationRegistrationDescriptors = [projection.descriptor]
    contractFixture.orchestrationEntities = projection.entities
    contractFixture.orchestrationEntityLinks = projection.entityLinks
    contractFixture.orchestrationRuns = projection.runs
    contractFixture.orchestrationLinks = projection.sessionLinks
    contractFixture.usageAggregates = projection.usageAggregates
    expect(validateTruthKernelGoldenFixture(contractFixture)).toEqual({ ok: true, value: contractFixture, issues: [] })
  })

  it('reconciles native authority, coverage and residual without double counting or issue allocation', () => {
    const parsed = parseMulticaWorkspaceBytes(fs.readFileSync(fixturePath), fixturePath, '2026-08-11T00:00:00.000Z')
    const [native, fallback, issue] = reconcileMulticaUsage(parsed.usages)
    expect(native).toMatchObject({ scope: { kind: 'entity', orchestrationEntityId: 'multica-task-T1' }, coveredTotal: { status: 'available', value: 90 }, residual: { status: 'available', value: 10 }, authoritative: { status: 'available', value: false }, billingDisposition: 'observation-only', reconciliation: { authority: 'native', allocation: 'residual-unallocated', doubleCountPrevented: true } })
    expect(fallback).toMatchObject({ authoritative: { status: 'available', value: true }, reconciliation: { authority: 'multica-task-fallback' } })
    expect(issue).toMatchObject({ scope: { kind: 'entity', orchestrationEntityId: 'multica-issue-I1' }, authoritative: { status: 'available', value: false }, residual: { status: 'unknown' }, reconciliation: { authority: 'issue-observation', allocation: 'not-allocatable' } })
  })

  it('caps coveredTotal at reportedTotal and exposes authoritative native overcoverage without a negative residual', () => {
    const [aggregate] = reconcileMulticaUsage([{
      id: 'overcoverage', scopeKind: 'task', scopeId: 'T-over', metric: 'input-token', unit: 'token', total: 90,
      nativeCoverage: 'complete', nativeUsageFacts: [{ factId: 'NF-over', metric: 'input-token', unit: 'token', total: 100, authoritative: true }]
    }])
    expect(aggregate).toMatchObject({
      reportedTotal: { status: 'available', value: 90 }, coveredTotal: { status: 'available', value: 90 }, residual: { status: 'available', value: 0 },
      authoritative: { status: 'available', value: false },
      reconciliation: {
        authority: 'native', allocation: 'overcoverage-anomaly', doubleCountPrevented: true,
        anomaly: { code: 'native-covered-total-exceeds-multica-reported-total', nativeObservedTotal: 100, multicaReportedTotal: 90, overcoverage: 10 }
      }
    })
    const contractFixture: TruthKernelGoldenFixture = structuredClone(TRUTH_KERNEL_GOLDEN_FIXTURE)
    contractFixture.usageAggregates = [aggregate]
    expect(validateTruthKernelGoldenFixture(contractFixture).issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'aggregate-negative-total' }),
      expect.objectContaining({ code: 'aggregate-conservation-failed' })
    ]))
  })

  it('rejects relationship ids as object identity and never invents native resume', () => {
    const parsed = parseMulticaWorkspace({ tasks: [{ issueId: 'I1', attemptId: 'A1' }] })
    expect(parsed.entities).toEqual([])
    expect(parsed.diagnostics).toHaveLength(1)
    const report = multicaDoctor({ platform: 'linux', homeDir: '/missing', exists: () => false })
    expect(report.capabilities.discovery).toBe('unavailable')
    expect(report.capabilities.nativeResume).toBe('unavailable')
  })
})
