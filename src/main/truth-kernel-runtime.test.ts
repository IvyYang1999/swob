import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TruthKernelRuntime } from './truth-kernel-runtime'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'swob-t211i-runtime-'))
  roots.push(root)
  const userDataPath = path.join(root, 'user-data')
  const homeDir = path.join(root, 'home')
  const library = path.join(root, 'library')
  await Promise.all([mkdir(userDataPath), mkdir(homeDir), mkdir(library)])
  return { root, userDataPath, homeDir, library }
}

function runtime(input: Awaited<ReturnType<typeof fixture>>, evidenceFile: () => Promise<string | null>, catalogRoot: () => Promise<string | null> = async () => null) {
  return new TruthKernelRuntime({
    userDataPath: input.userDataPath, homeDir: input.homeDir, platform: 'darwin',
    getLibraryRoot: () => input.library, selectCatalogRoot: catalogRoot, selectEvidenceFile: evidenceFile
  })
}

describe('TruthKernelRuntime production owners', () => {
  it('persists bounded Catalog roots, tabs, active scope and offline last-known state', async () => {
    const input = await fixture()
    const packageDir = path.join(input.library, 'package')
    await mkdir(packageDir)
    await writeFile(path.join(packageDir, '.swob-session.json'), JSON.stringify({
      schemaVersion: 3, packageId: 'package-1', logicalIdentity: { providerId: 'codex', sessionId: 'session-1' }, backupSize: 64
    }))
    const first = runtime(input, async () => null)
    first.rescanCatalogRoot('library')
    expect(first.catalogState()).toMatchObject({
      activeTabId: 'all', logicalSessionIds: ['session-1'],
      roots: [{ root: { rootId: 'library', capability: 'read-only' }, observation: { scanState: 'fresh' } }]
    })
    const tab = { ...first.catalogState().tabs[0], tabId: 'codex', title: 'Codex', pinned: false, scope: { ...first.catalogState().tabs[0].scope, providerIds: ['codex'] } }
    first.saveCatalogTab(tab)
    first.setActiveCatalogTab(tab.tabId)
    first.close()
    const reopened = runtime(input, async () => null)
    expect(reopened.catalogState()).toMatchObject({ activeTabId: 'codex', logicalSessionIds: ['session-1'] })
    reopened.close()
  })

  it('attaches redacted Claude Tap metadata, persists it, and rejects a duplicate after restart', async () => {
    const input = await fixture()
    const selected = path.join(input.root, 'capture.ctap.json')
    await writeFile(selected, JSON.stringify({ schema_version: '1', schema: 'claude-tap.capture', usage: { input: 1 }, trace: [] }))
    const truth = { transcriptHash: 'truth', turnCount: 1, usageTotalTokens: 1 }
    const first = runtime(input, async () => selected)
    const attached = await first.attachEvidence('session-1', truth)
    expect(attached).toMatchObject({ canceled: false, attachment: { mappedLogicalSessionId: { status: 'available', value: 'session-1' }, confirmation: 'user-confirmed', contentRetention: 'redacted-metadata-only' } })
    first.close()
    const reopened = runtime(input, async () => selected)
    expect(reopened.evidenceForSession('session-1')).toHaveLength(1)
    await expect(reopened.attachEvidence('session-1', truth)).rejects.toThrow('external-evidence:duplicate-attachment')
    const persisted = await readFile(path.join(input.userDataPath, 'truth-kernel', 'external-evidence.json'), 'utf8')
    expect(persisted).not.toContain(selected)
    expect(persisted).not.toContain('"trace"')
    reopened.close()
  })

  it('requires and validates the paired nono event stream before attachment', async () => {
    const input = await fixture()
    const selected = path.join(input.root, 'audit.session.json')
    const events = path.join(input.root, 'audit.events.ndjson')
    await writeFile(selected, JSON.stringify({ schema_version: '1', schema: 'nono.audit-session', session_id: 'nono-1', dimensions: {} }))
    const instance = runtime(input, async () => selected)
    await expect(instance.attachEvidence('session-1', { transcriptHash: 'x', turnCount: 0, usageTotalTokens: 0 })).rejects.toThrow()
    await writeFile(events, `${JSON.stringify({ schema_version: '1', schema: 'nono.audit-event', session_id: 'nono-1' })}\n`)
    await expect(instance.attachEvidence('session-1', { transcriptHash: 'x', turnCount: 0, usageTotalTokens: 0 })).resolves.toMatchObject({ attachment: { externalProviderId: 'nono' } })
    instance.close()
  })

  it('projects Multica through the read-only linked-session surface without leaking paths or raw payloads', async () => {
    const input = await fixture()
    const multicaRoot = path.join(input.root, 'multica')
    const task = path.join(multicaRoot, 'workspace', 'task')
    await mkdir(task, { recursive: true })
    await writeFile(path.join(task, 'multica-orchestration.json'), JSON.stringify({
      schemaVersion: '0.4', tasks: [{ id: 'T1', attemptIds: ['A1'] }],
      attempts: [{ id: 'A1', taskId: 'T1', status: 'running', sessionIds: ['session-1'] }]
    }))
    const instance = new TruthKernelRuntime({
      userDataPath: input.userDataPath, homeDir: input.homeDir, platform: 'darwin',
      getLibraryRoot: () => input.library, selectCatalogRoot: async () => null, selectEvidenceFile: async () => null,
      environment: { MULTICA_WORKSPACES_ROOT: multicaRoot }
    })
    const projection = instance.orchestration('session-1')
    expect(projection).toMatchObject({ mode: 'read-only', runs: 1, linkedRuns: 1 })
    expect(JSON.stringify(projection)).not.toContain(input.root)
    expect(JSON.stringify(projection)).not.toContain('rawPayload')
    instance.close()
  })
})
