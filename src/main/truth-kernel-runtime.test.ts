import { mkdirSync, rmSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TruthKernelRuntime } from './truth-kernel-runtime'
import type { CanonicalSessionStore } from './canonical-store'
import { getSqliteAgentSourceStatus } from './opencode-loader'
import { loadAllSessions } from './session-loader'
import { installFakeSqlite3, realSqlite3Path } from './__test-support__/fake-sqlite3'

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

// F1e: OpenCode/ZCode are legacy loaders without canonical diagnostics, so the
// Doctor row comes from their process-local source status.
const cliIt = process.platform !== 'win32' && realSqlite3Path() ? it : it.skip
const emptyCanonicalStore = { sourceStates: () => [], listV2Sessions: () => [] } as unknown as CanonicalSessionStore

function createOpencodeHomeDb(sessionIds: readonly string[]): string {
  const dbPath = path.join(process.env.HOME!, '.local', 'share', 'opencode', 'opencode.db')
  mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  try {
    db.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, slug TEXT, directory TEXT, title TEXT, model TEXT);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER);
      CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, type TEXT, idx INTEGER, data TEXT);
    `)
    for (const id of sessionIds) {
      db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?)').run(id, 'doctor-slug', '/fixture/doctor', 'Doctor', 'gpt-5.1')
      db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(`${id}-user`, id,
        JSON.stringify({ role: 'user', time: { created: '2026-08-02T00:00:00Z' } }), 1785628800)
      db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(`${id}-assistant`, id,
        JSON.stringify({ role: 'assistant', time: { created: '2026-08-02T00:00:01Z' } }), 1785628801)
      db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)').run(`${id}-part-user`, id, `${id}-user`, 'text', 0,
        JSON.stringify({ text: 'doctor prompt' }))
      db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)').run(`${id}-part-assistant`, id, `${id}-assistant`, 'text', 0,
        JSON.stringify({ text: 'doctor answer' }))
    }
  } finally {
    db.close()
  }
  return dbPath
}

describe('Provider Doctor SQLite-agent rows (F1e)', () => {
  cliIt('opencode reports found with its session count, then partial and error codes, never paths or stderr', async () => {
    const input = await fixture()
    const dbPath = createOpencodeHomeDb(['ses_DoctorGood', 'ses_DoctorBad'])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const instance = runtime(input, async () => null)
    const row = (providerId: string) =>
      instance.providerDoctor(emptyCanonicalStore).find((entry) => entry.manifest.providerId === providerId)!
    try {
      await loadAllSessions({ readOnly: true, quiet: true })
      const found = row('swob/opencode')
      expect(found).toMatchObject({
        discovery: 'found', discoveryReason: null, sourceLabel: 'opencode · 2', partialEvents: 0
      })
      expect(found.lastSuccessfulParseAt).toEqual(expect.any(String))
      expect(row('swob/zcode')).toMatchObject({ discovery: 'not-found', discoveryReason: null, sourceLabel: 'zcode · 0' })

      const oneSessionFails = installFakeSqlite3({
        kind: 'fail-matching',
        match: ['FROM "message"', 'ses_DoctorBad'],
        stderr: 'Runtime error near line 2: database disk image is malformed (11)'
      })
      try {
        await loadAllSessions({ readOnly: true, quiet: true })
      } finally {
        oneSessionFails.restore()
      }
      expect(row('swob/opencode')).toMatchObject({
        discovery: 'found', discoveryReason: 'partial:corrupt', sourceLabel: 'opencode · 1', partialEvents: 0
      })

      const busy = installFakeSqlite3({ kind: 'fail', stderr: 'Parse error near line 2: database is locked (5)' })
      try {
        await loadAllSessions({ readOnly: true, quiet: true })
      } finally {
        busy.restore()
      }
      const failed = row('swob/opencode')
      expect(failed).toMatchObject({ discovery: 'error', discoveryReason: 'busy', sourceLabel: 'opencode · 0', partialEvents: 0 })
      expect(failed.lastSuccessfulParseAt).toEqual(expect.any(String))

      const surfaced = JSON.stringify([
        instance.providerDoctor(emptyCanonicalStore),
        getSqliteAgentSourceStatus('opencode'),
        getSqliteAgentSourceStatus('zcode'),
        warn.mock.calls
      ])
      for (const secret of [dbPath, path.dirname(dbPath), 'ses_DoctorGood', 'ses_DoctorBad', 'database is locked', 'malformed', 'Parse error']) {
        expect(surfaced).not.toContain(secret)
      }
      expect(warn.mock.calls.map((args) => args.join(' '))).toEqual([
        '[sqlite-agent] opencode: 1 session read(s) failed (corrupt); 0 carried over',
        '[sqlite-agent] opencode: discovery unavailable (busy, attempts 2)'
      ])
    } finally {
      warn.mockRestore()
      instance.close()
      rmSync(path.join(process.env.HOME!, '.local'), { recursive: true, force: true })
    }
  }, 30_000)
})
