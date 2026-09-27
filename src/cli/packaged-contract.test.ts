import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { performance } from 'node:perf_hooks'
import Ajv2020 from 'ajv/dist/2020.js'
import checkupReportSchema from '../checkup/contract/kernel-checkup-report-v1.schema.json'
import { createEvidenceBundle } from '../main/integrity/evidence-bundle'
import { TRUTH_KERNEL_GOLDEN_FIXTURE, truthKernelCanonicalUtf8Bytes } from '../shared/contracts/truth-kernel'
import { CLI_COMMANDS, CLI_VERSION } from './command-registry'

const packagedApp = process.env.SWOB_PACKAGED_APP
const describePackaged = packagedApp ? describe.sequential : describe.skip
const SESSION_A = '92000000-0000-4000-8000-000000000117'
const SESSION_B = '93000000-0000-4000-8000-000000000117'
const CLI_INVOCATION_TIMEOUT_MS = 5_000
const COMMAND_TEST_TIMEOUT_MS = 10_000
// doctor checkup spawns the isolated worker, runs the self-test, the census and the read-only kernel load.
const CHECKUP_INVOCATION_TIMEOUT_MS = 180_000
const CHECKUP_TEST_TIMEOUT_MS = 240_000
const CHECKUP_USAGE = 'doctor checkup [--report <目录|文件.md>] [--json] [--sources a,b] [--compare <上次.json>|none] [--fail-on fail|warn|never]'

interface Invocation {
  code: number
  stdout: string
  stderr: string
  durationMs: number
}

let sandboxRoot = ''
let fixtureHome = ''
let libraryRoot = ''
let projectRoot = ''
let packagedCli = ''
let unpackedNodeModules = ''
let installedCommand = ''
let sourceA = ''
let sourceB = ''
let packageA = ''
let packageB = ''
const childProcesses: ChildProcess[] = []
let commandEnvironment: NodeJS.ProcessEnv = {}
const exercised = new Set<string>()
const GLOBAL_CLI_PATHS = ['/usr/local/bin/swob', '/opt/homebrew/bin/swob']
let globalCliStateBefore: string[] = []
// F1l-c reverse-verification pin (deliverable 1): before the sandbox redirect,
// NODE_ENV=production made the packaged CLI's write commands fall through to
// the real host-identity primary despite SWOB_TEST_HOME/SWOB_E2E_SANDBOX_ROOT
// being set (this is exactly what regenerated the real identity on 2026-09-26
// at 22:22, the same minute a packaged-contract run executed write commands).
// This never writes to the real path itself - only a read-only lstat
// signature, taken before any CLI invocation and compared again at the end.
const REAL_HOST_IDENTITY_DIR = '/Users/Shared/Swob'
const REAL_HOST_IDENTITY_FILE = path.join(REAL_HOST_IDENTITY_DIR, 'host-identity-v1.json')
let realHostIdentityDirStateBefore = ''
let realHostIdentityFileStateBefore = ''

function inspectGlobalCliPath(filePath: string): string {
  try {
    const stat = fs.lstatSync(filePath)
    return stat.isSymbolicLink()
      ? `symlink:${fs.readlinkSync(filePath)}`
      : `file:${stat.mode}:${stat.size}:${stat.mtimeMs}`
  } catch {
    return 'missing'
  }
}

/** Like inspectGlobalCliPath, plus the inode: a stronger read-only before/after signature. */
function inspectRealPathSignature(filePath: string): string {
  try {
    const stat = fs.lstatSync(filePath)
    return stat.isSymbolicLink()
      ? `symlink:${fs.readlinkSync(filePath)}`
      : `file:${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.ino}`
  } catch {
    return 'missing'
  }
}

function writeJsonl(filePath: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
}

function sessionRows(sessionId: string, label: string): unknown[] {
  return [
    ...(label === 'beta' ? [{
      type: 'summary', sessionId, leafUuid: `${SESSION_A}-result`,
      timestamp: '2026-07-20T00:02:30.000Z'
    }] : []),
    {
      uuid: `${sessionId}-user`, parentUuid: null, sessionId, type: 'user',
      cwd: projectRoot, timestamp: '2026-07-20T00:00:00.000Z',
      message: { role: 'user', content: `packaged contract ${label}` }
    },
    {
      uuid: `${sessionId}-assistant`, parentUuid: `${sessionId}-user`, sessionId, type: 'assistant',
      cwd: projectRoot, timestamp: '2026-07-20T00:01:00.000Z',
      message: {
        role: 'assistant', model: 'packaged-test-model',
        content: label === 'alpha'
          ? [
              { type: 'thinking', thinking: 'packaged-thinking-needle' },
              { type: 'text', text: 'packaged assistant response' },
              { type: 'tool_use', id: 'tool-1', name: 'Write', input: { file_path: path.join(projectRoot, 'a.ts'), content: 'packaged-tool-needle' } }
            ]
          : 'packaged beta response',
        usage: { input_tokens: 10, output_tokens: 20 }
      }
    },
    ...(label === 'alpha' ? [{
      uuid: `${sessionId}-result`, parentUuid: `${sessionId}-assistant`, sessionId, type: 'user',
      cwd: projectRoot, timestamp: '2026-07-20T00:02:00.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'packaged-tool-result' }] }
    }] : [])
  ]
}

function createLibraryPackage(title: string, sessionId: string, sourcePath: string, rows: unknown[]): string {
  const dirPath = path.join(libraryRoot, title)
  fs.mkdirSync(dirPath, { recursive: true })
  fs.writeFileSync(path.join(dirPath, '.swob-session.json'), JSON.stringify({
    sessionId,
    sourceFilePaths: [sourcePath],
    customTitle: title,
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:02:00.000Z',
    projectPath: projectRoot
  }), 'utf8')
  fs.writeFileSync(path.join(dirPath, 'backup.jsonl'), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
  return dirPath
}

/** Writes a content-addressed Truth Kernel evidence bundle built from the golden fixture. */
function writeEvidenceBundle(root: string): { manifestPath: string; artifactPath: string } {
  const receipt = TRUTH_KERNEL_GOLDEN_FIXTURE.sourceIngestReceipts[0]
  const chain = TRUTH_KERNEL_GOLDEN_FIXTURE.canonicalEventChains[0]
  const events = chain.entries.map((entry) => ({
    eventId: entry.eventId,
    bytes: truthKernelCanonicalUtf8Bytes(TRUTH_KERNEL_GOLDEN_FIXTURE.timelineEvents
      .find((event) => event.sourceEventId === entry.eventId)!.providerEvent)
  }))
  const bundle = createEvidenceBundle({
    bundleId: 'packaged-cli-bundle', generatedAt: '2026-07-20T00:03:00.000Z', receipts: [receipt], chains: [chain], events
  })
  for (const [relativePath, bytes] of bundle.files) {
    const output = path.join(root, relativePath)
    fs.mkdirSync(path.dirname(output), { recursive: true })
    fs.writeFileSync(output, bytes)
  }
  return {
    manifestPath: path.join(root, 'manifest.json'),
    artifactPath: path.join(root, bundle.manifest.artifacts[0].relativePath)
  }
}

function minimalInheritedEnvironment(): NodeJS.ProcessEnv {
  const inherited: NodeJS.ProcessEnv = {}
  for (const name of ['PATH', 'LANG', 'LC_ALL', 'SHELL', 'USER', 'LOGNAME']) {
    const value = process.env[name]
    if (value) inherited[name] = value
  }
  return inherited
}

function invokeRaw(executable: string, args: string[], stdin = '', timeout = CLI_INVOCATION_TIMEOUT_MS): Invocation {
  const startedAt = performance.now()
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    env: commandEnvironment,
    input: stdin,
    maxBuffer: 16 * 1024 * 1024,
    timeout
  })
  const durationMs = performance.now() - startedAt
  if (result.error) throw result.error
  return { code: result.status ?? 1, stdout: result.stdout || '', stderr: result.stderr || '', durationMs }
}

function invokeBootstrap(args: string[], stdin = ''): Invocation {
  return invokeRaw(process.execPath, [packagedCli, ...args], stdin)
}

function invokeInstalled(usage: string, args: string[], stdin = '', timeout = CLI_INVOCATION_TIMEOUT_MS): Invocation {
  exercised.add(usage)
  const invocation = invokeRaw(installedCommand, args, stdin, timeout)
  process.stderr.write(`[packaged-cli timing] ${usage}: ${invocation.durationMs.toFixed(1)}ms\n`)
  return invocation
}

function parseSuccess(invocation: Invocation): any {
  expect(invocation.code, invocation.stderr).toBe(0)
  expect(invocation.stdout.trim()).not.toBe('')
  return JSON.parse(invocation.stdout)
}

function waitForProcessStart(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 200))
}

beforeAll(() => {
  if (!packagedApp) return
  globalCliStateBefore = GLOBAL_CLI_PATHS.map(inspectGlobalCliPath)
  realHostIdentityDirStateBefore = inspectRealPathSignature(REAL_HOST_IDENTITY_DIR)
  realHostIdentityFileStateBefore = inspectRealPathSignature(REAL_HOST_IDENTITY_FILE)
  const appPath = packagedApp
  packagedCli = path.join(appPath, 'Contents', 'Resources', 'cli', 'cli.js')
  unpackedNodeModules = path.join(appPath, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules')
  expect(fs.existsSync(packagedCli)).toBe(true)
  expect(fs.existsSync(path.join(unpackedNodeModules, 'better-sqlite3'))).toBe(true)

  sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-packaged-cli-'))
  fixtureHome = path.join(sandboxRoot, 'home')
  libraryRoot = path.join(fixtureHome, 'Library')
  projectRoot = path.join(sandboxRoot, 'project with space')
  const cliTargetDir = path.join(fixtureHome, 'bin')
  const tempDir = path.join(sandboxRoot, 'tmp')
  const userDataRoot = path.join(sandboxRoot, 'user-data')
  for (const dirPath of [fixtureHome, libraryRoot, projectRoot, cliTargetDir, tempDir, userDataRoot]) {
    fs.mkdirSync(dirPath, { recursive: true })
  }

  const projectBucket = path.join(fixtureHome, '.claude', 'projects', '-packaged-contract-project')
  sourceA = path.join(projectBucket, `${SESSION_A}.jsonl`)
  sourceB = path.join(projectBucket, `${SESSION_B}.jsonl`)
  const rowsA = sessionRows(SESSION_A, 'alpha')
  const rowsB = sessionRows(SESSION_B, 'beta')
  writeJsonl(sourceA, rowsA)
  writeJsonl(sourceB, rowsB)
  packageA = createLibraryPackage('Alpha Original', SESSION_A, sourceA, rowsA)
  packageB = createLibraryPackage('Beta Original', SESSION_B, sourceB, rowsB)

  commandEnvironment = {
    ...minimalInheritedEnvironment(),
    HOME: fixtureHome,
    NODE_ENV: 'production',
    NODE_PATH: unpackedNodeModules,
    SWOB_CLI_DISABLE_AUTO_RUN: '0',
    SWOB_E2E_RUNNER: 'packaged-cli-contract',
    SWOB_E2E_SANDBOX_ROOT: sandboxRoot,
    SWOB_LIBRARY_ROOT: libraryRoot,
    SWOB_PACKAGED_APP: appPath,
    SWOB_SEARCH_INDEX_DIR: path.join(fixtureHome, 'search-index'),
    SWOB_TEST_APP_CLI_PATH: packagedCli,
    SWOB_TEST_CLI_TARGET_DIR: cliTargetDir,
    SWOB_TEST_HOME: fixtureHome,
    SWOB_TEST_SYSTEM_TEMP_ROOT: os.tmpdir(),
    SWOB_USER_DATA_ROOT: userDataRoot,
    TEMP: tempDir,
    TMP: tempDir,
    TMPDIR: tempDir,
    VITEST: 'false'
  }
  installedCommand = path.join(cliTargetDir, 'swob')
})

afterAll(() => {
  for (const childProcess of childProcesses) {
    if (childProcess.exitCode === null) childProcess.kill('SIGTERM')
  }
  if (sandboxRoot) fs.rmSync(sandboxRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  if (packagedApp) {
    expect(GLOBAL_CLI_PATHS.map(inspectGlobalCliPath)).toEqual(globalCliStateBefore)
  }
})

describePackaged('packaged Swob CLI complete command contract', () => {
  it('installs an isolated real wrapper and generated Claude Skill', () => {
    exercised.add('install')
    const installed = parseSuccess(invokeBootstrap(['install', '--json']))
    expect(installed).toMatchObject({
      cliInstalled: true,
      cliPath: installedCommand,
      cliFallbackUsed: false,
      skillInstalled: true
    })
    expect(fs.readlinkSync(installedCommand)).toBe(installed.cliWrapperPath)
    expect(fs.readFileSync(installed.cliWrapperPath, 'utf8')).toContain(packagedCli)
    expect(fs.readFileSync(installed.cliWrapperPath, 'utf8')).toContain('app.asar.unpacked/node_modules')
    const skill = fs.readFileSync(path.join(fixtureHome, '.claude', 'skills', 'swob', 'SKILL.md'), 'utf8')
    for (const command of CLI_COMMANDS) expect(skill).toContain(`swob ${command.usage}`)

    const reinstalled = parseSuccess(invokeInstalled('install', ['install', '--json']))
    expect(reinstalled.cliPath).toBe(installedCommand)
  }, COMMAND_TEST_TIMEOUT_MS)

  it('honors the packaged machine interface and read/search/detail commands', () => {
    expect(parseSuccess(invokeRaw(installedCommand, ['--version', '--json']))).toMatchObject({ name: 'swob', version: CLI_VERSION })
    expect(parseSuccess(invokeRaw(installedCommand, ['--help', '--json']))).toMatchObject({ name: 'swob', commands: expect.any(Array) })

    const search = parseSuccess(invokeInstalled('search <query> [--limit N]', ['search', 'packaged alpha', '--limit', '1', '--json']))
    expect(search).toMatchObject([{ sessionId: SESSION_A, matchedFields: expect.any(Array) }])

    const listed = parseSuccess(invokeInstalled(
      'list [--folder ID|NAME] [--source SOURCE] [--project TEXT] [--limit N]',
      ['list', '--source', 'claude-code', '--project', 'project with space', '--limit', '10', '--json']
    ))
    expect(listed.map((item: any) => item.sessionId)).toEqual(expect.arrayContaining([SESSION_A, SESSION_B]))

    const shown = parseSuccess(invokeInstalled(
      'show <sessionId> [--full] [--format=jsonl]',
      ['show', SESSION_A, '--full', '--json']
    ))
    expect(shown.messages.find((message: any) => message.uuid.endsWith('-assistant'))).toMatchObject({
      thinking: ['packaged-thinking-needle'],
      toolCalls: [{ name: 'Write', result: 'packaged-tool-result' }]
    })
    const jsonl = invokeInstalled(
      'show <sessionId> [--full] [--format=jsonl]',
      ['show', SESSION_A, '--full', '--format=jsonl']
    )
    expect(jsonl.code, jsonl.stderr).toBe(0)
    expect(jsonl.stdout.trim().split('\n').map((line) => JSON.parse(line))[0]).toMatchObject({ event: 'session', sessionId: SESSION_A })

    const grep = parseSuccess(invokeInstalled(
      'grep <query> [--source SOURCE] [--folder ID|NAME] [--after DATE] [--before DATE] [--project TEXT] [--limit N]',
      ['grep', 'packaged-tool-needle', '--source', 'claude-code', '--project', 'project with space', '--after', '2026-07-20', '--before', '2026-07-20', '--limit', '10', '--json']
    ))
    expect(grep).toMatchObject({ sessionCount: 1, matchCount: 1, sessions: [{ sessionId: SESSION_A }] })
    expect(grep.sessions[0].matches[0].context).toHaveLength(3)
  }, COMMAND_TEST_TIMEOUT_MS)

  it('resolves lineage and exercises resume surfaces through the installed command', async () => {
    const manifestOnly = parseSuccess(invokeInstalled(
      'resolve <id-or-prefix> [--json]',
      ['resolve', SESSION_A, '--json']
    ))
    expect(manifestOnly).toMatchObject({ matched: true, resolved: SESSION_A })

    const lineageDry = parseSuccess(invokeInstalled('lineage [--dry-run]', ['lineage', '--dry-run', '--json']))
    expect(lineageDry).toHaveProperty('aliases')
    parseSuccess(invokeInstalled('lineage [--dry-run]', ['lineage', '--json']))
    expect(fs.existsSync(path.join(libraryRoot, '.session-lineage.json'))).toBe(true)

    const exactManifest = parseSuccess(invokeInstalled('resolve <id-or-prefix> [--json]', ['resolve', SESSION_A, '--json']))
    expect(exactManifest).toMatchObject({ matched: true, resolved: SESSION_A })

    const lineagePath = path.join(libraryRoot, '.session-lineage.json')
    const lineage = JSON.parse(fs.readFileSync(lineagePath, 'utf8'))
    lineage.aliases['legacy-packaged-alias'] = SESSION_B
    fs.writeFileSync(lineagePath, JSON.stringify(lineage))
    const resolved = parseSuccess(invokeInstalled(
      'resolve <id-or-prefix> [--json]',
      ['resolve', 'legacy-packaged-alias', '--json']
    ))
    expect(resolved).toMatchObject({ matched: true, resolved: SESSION_B })

    const located = parseSuccess(invokeInstalled(
      'where <id-or-prefix> [--json]',
      ['where', SESSION_B.slice(0, 12), '--json']
    ))
    expect(located).toMatchObject({ sessionId: SESSION_B, packagePath: packageB })

    const transcriptStatus = parseSuccess(invokeInstalled(
      'transcript status <id-or-prefix> [--json]',
      ['transcript', 'status', SESSION_B, '--json']
    ))
    expect(transcriptStatus).toMatchObject({
      sessionId: SESSION_B,
      sourceUpdatedAt: expect.any(String),
      backupUpdatedAt: expect.any(String),
      manifestUpdatedAt: expect.any(String)
    })

    expect(parseSuccess(invokeInstalled('doctor locks [--json]', ['doctor', 'locks', '--json']))).toMatchObject({ state: 'unlocked' })
    // Nothing to recover here: the read-only precheck answers before any machine identity is read.
    const recovery = invokeInstalled(
      'doctor locks --recover --evidence <hash> --confirm RECOVER_LIBRARY_WRITER_LOCK [--json]',
      ['doctor', 'locks', '--recover', '--evidence', '0'.repeat(64), '--confirm', 'RECOVER_LIBRARY_WRITER_LOCK', '--json']
    )
    expect(recovery.code, recovery.stderr).toBe(1)
    expect(JSON.parse(recovery.stdout)).toEqual({ recovered: false, reason: 'unlocked' })
    expect(parseSuccess(invokeInstalled('doctor library [--json]', ['doctor', 'library', '--json']))).toMatchObject({
      manifestCount: 2,
      staleCount: expect.any(Number)
    })

    const resumed = parseSuccess(invokeInstalled(
      'resume <sessionId> [--cwd PATH] [--skip-permissions]',
      ['resume', SESSION_A, '--cwd', projectRoot, '--json']
    ))
    expect(resumed.command).toContain('--resume')

    const audit = parseSuccess(invokeInstalled('resume-audit [--json]', ['resume-audit', '--json']))
    expect(audit).toMatchObject({ generatedAt: expect.any(String), readOnly: true, perSource: expect.any(Object) })

    const fakeClaude = path.join(sandboxRoot, 'claude')
    fs.writeFileSync(fakeClaude, '#!/bin/sh\nwhile :; do /bin/sleep 1; done\n', 'utf8')
    fs.chmodSync(fakeClaude, 0o755)
    childProcesses.push(
      spawn(fakeClaude, ['--resume', SESSION_A], { env: commandEnvironment, stdio: 'ignore' }),
      spawn(fakeClaude, [`--resume=${SESSION_B}`], { env: commandEnvironment, stdio: 'ignore' }),
      spawn(fakeClaude, [`--resume=${SESSION_B}`], { env: commandEnvironment, stdio: 'ignore' })
    )
    await waitForProcessStart()
    const active = parseSuccess(invokeInstalled('active', ['active', '--json']))
    expect(active.activeSessionIds).toEqual(expect.arrayContaining([SESSION_A, SESSION_B]))
    expect(active.activeSessionIds.filter((sessionId: string) => sessionId === SESSION_A)).toHaveLength(1)
    expect(active.activeSessionIds.filter((sessionId: string) => sessionId === SESSION_B)).toHaveLength(1)
    for (const childProcess of childProcesses.splice(0)) childProcess.kill('SIGTERM')
  }, COMMAND_TEST_TIMEOUT_MS)

  it('creates, renames and deletes nested folders', () => {
    const parent = parseSuccess(invokeInstalled('folder create <name> [--parent ID]', ['folder', 'create', 'Parent', '--json']))
    const child = parseSuccess(invokeInstalled(
      'folder create <name> [--parent ID]',
      ['folder', 'create', 'Child', '--parent', parent.folder.id, '--json']
    ))
    const tree = parseSuccess(invokeInstalled('folders', ['folders', '--json']))
    expect(tree).toEqual(expect.arrayContaining([expect.objectContaining({ id: parent.folder.id })]))

    const renamed = parseSuccess(invokeInstalled(
      'folder rename <id> <name>',
      ['folder', 'rename', child.folder.id, 'Renamed Child', '--json']
    ))
    expect(fs.existsSync(path.join(libraryRoot, renamed.folderId))).toBe(true)
    parseSuccess(invokeInstalled('folder delete <id>', ['folder', 'delete', renamed.folderId, '--json']))
    parseSuccess(invokeInstalled('folder delete <id>', ['folder', 'delete', parent.folder.id, '--json']))
    expect(fs.existsSync(path.join(libraryRoot, parent.folder.id))).toBe(false)
  }, COMMAND_TEST_TIMEOUT_MS)

  it('runs single and batch organization transactions with complete undo', () => {
    const target = parseSuccess(invokeInstalled('folder create <name> [--parent ID]', ['folder', 'create', 'Target', '--json']))
    const targetId = target.folder.id

    expect(parseSuccess(invokeInstalled('move <sessionId> <folderId>', ['move', SESSION_A, targetId, '--json']))).toMatchObject({ moved: 1 })
    expect(fs.existsSync(path.join(libraryRoot, targetId, 'Alpha Original'))).toBe(true)
    parseSuccess(invokeInstalled('undo', ['undo', '--json']))
    expect(fs.existsSync(packageA)).toBe(true)

    expect(parseSuccess(invokeInstalled('move --stdin', ['move', '--stdin', '--json'], JSON.stringify([
      { sessionId: SESSION_A, folderId: targetId },
      { sessionId: SESSION_B, folderId: targetId }
    ])))).toMatchObject({ count: 2, moved: 2 })
    parseSuccess(invokeInstalled('undo', ['undo', '--json']))
    expect(fs.existsSync(packageA)).toBe(true)
    expect(fs.existsSync(packageB)).toBe(true)

    expect(parseSuccess(invokeInstalled('rename <sessionId> <title>', ['rename', SESSION_A, 'Alpha Single Renamed', '--json']))).toMatchObject({ renamed: 1 })
    expect(fs.existsSync(path.join(libraryRoot, 'Alpha Single Renamed'))).toBe(true)
    parseSuccess(invokeInstalled('undo', ['undo', '--json']))
    expect(fs.existsSync(packageA)).toBe(true)

    expect(parseSuccess(invokeInstalled('rename --stdin', ['rename', '--stdin', '--json'], [
      JSON.stringify({ sessionId: SESSION_A, title: 'Alpha Batch Renamed' }),
      JSON.stringify({ sessionId: SESSION_B, title: 'Beta Batch Renamed' })
    ].join('\n')))).toMatchObject({ count: 2, renamed: 2 })
    parseSuccess(invokeInstalled('undo', ['undo', '--json']))
    expect(fs.existsSync(packageA)).toBe(true)
    expect(fs.existsSync(packageB)).toBe(true)

    const folderGrep = parseSuccess(invokeInstalled(
      'grep <query> [--source SOURCE] [--folder ID|NAME] [--after DATE] [--before DATE] [--project TEXT] [--limit N]',
      ['grep', 'packaged', '--folder', targetId, '--json']
    ))
    expect(folderGrep.sessionCount).toBe(0)
  }, COMMAND_TEST_TIMEOUT_MS)

  it('persists config, executes analytics/transcript/redaction maintenance and verifies evidence bundles', () => {
    expect(parseSuccess(invokeInstalled('config set <key> <value>', ['config', 'set', 'terminalApp', 'iTerm2', '--json']))).toMatchObject({ terminalApp: 'iTerm2' })
    expect(parseSuccess(invokeInstalled('config get [key]', ['config', 'get', 'terminalApp', '--json']))).toEqual({ terminalApp: 'iTerm2' })

    const insights = parseSuccess(invokeInstalled('insights [--json] [--summary]', ['insights', '--summary', '--json']))
    expect(insights).toMatchObject({ totalSessions: 2, totalTokensMetric: 'billing_total' })

    const rebuilt = parseSuccess(invokeInstalled(
      'transcript rebuild --all [--dry-run] [--missing-only]',
      ['transcript', 'rebuild', '--all', '--missing-only', '--json']
    ))
    expect(rebuilt).toMatchObject({ dryRun: false, missingOnly: true, sessionCount: 2, failed: 0 })
    expect(rebuilt.written).toBeGreaterThan(0)

    const rebuiltOne = parseSuccess(invokeInstalled(
      'transcript rebuild <id-or-prefix> [--dry-run]',
      ['transcript', 'rebuild', SESSION_A, '--dry-run', '--json']
    ))
    expect(rebuiltOne).toMatchObject({ sessionId: SESSION_A, dryRun: true, failed: 0 })

    const redacted = parseSuccess(invokeInstalled('redact [--dry-run]', ['redact', '--json']))
    expect(redacted).toMatchObject({ files: expect.any(Number), hits: expect.any(Number) })

    const bundleRoot = path.join(sandboxRoot, 'evidence bundle')
    const bundle = writeEvidenceBundle(bundleRoot)
    expect(parseSuccess(invokeInstalled(
      'verify <bundle-dir|manifest.json> [--json]',
      ['verify', bundleRoot, '--json']
    ))).toMatchObject({ target: { kind: 'bundle', id: 'packaged-cli-bundle' }, status: 'valid', failures: [] })
    fs.appendFileSync(bundle.artifactPath, 'x')
    const tampered = parseSuccess(invokeInstalled(
      'verify <bundle-dir|manifest.json> [--json]',
      ['verify', bundle.manifestPath, '--json']
    ))
    expect(tampered.status).toBe('invalid')
    expect(tampered.failures.length).toBeGreaterThan(0)
  }, COMMAND_TEST_TIMEOUT_MS)

  it('runs doctor checkup in the isolated worker shipped next to cli.js and writes the three report files', () => {
    expect(fs.existsSync(path.join(path.dirname(packagedCli), 'checkup-worker.js'))).toBe(true)
    const reportDir = path.join(sandboxRoot, 'checkup-reports')
    fs.mkdirSync(reportDir)
    const invocation = invokeInstalled(CHECKUP_USAGE, ['doctor', 'checkup', '--report', reportDir, '--json'], '', CHECKUP_INVOCATION_TIMEOUT_MS)
    const summary = parseSuccess(invocation)
    expect(summary).toMatchObject({ verdict: expect.any(String), compare: { status: 'none' }, worker: { stdoutLines: 0, stderrLines: 0 } })
    expect(summary.written).toHaveLength(3)
    expect(fs.readdirSync(reportDir).sort()).toEqual([...summary.written].sort())
    const jsonName = summary.written.find((name: string) => name.endsWith('.json'))
    const report = JSON.parse(fs.readFileSync(path.join(reportDir, jsonName), 'utf8'))
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(checkupReportSchema)
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true)
    expect(report.readout).toEqual({ status: 'ok' })
    expect(report.kernel).toMatchObject({ version: CLI_VERSION, readOnly: true, selfTest: { passed: 7, total: 7 } })
    expect(report.readoutBySource['claude-code'].sessions.label).toBe('reported')
    expect(report.readoutBySource['claude-code'].sessions.value).toBeGreaterThan(0)
    const canaries = [SESSION_A, SESSION_B, 'packaged contract alpha', 'packaged-thinking-needle', 'packaged-tool-needle', 'packaged-tool-result', 'Alpha Original', sandboxRoot]
    for (const text of [invocation.stdout, invocation.stderr, ...summary.written.map((name: string) => fs.readFileSync(path.join(reportDir, name), 'utf8'))]) {
      for (const canary of canaries) expect(text.includes(canary), canary).toBe(false)
    }
    // The one-shot stateDir (under this sandbox's TMPDIR) is gone.
    expect(fs.readdirSync(path.join(sandboxRoot, 'tmp')).filter((name) => name.startsWith('swob-checkup-'))).toEqual([])
  }, CHECKUP_TEST_TIMEOUT_MS)

  it('covers every command definition through the real installed wrapper', () => {
    expect([...exercised].sort()).toEqual(CLI_COMMANDS.map((command) => command.usage).sort())
  })

  it('F1l-c: every write command above ran under NODE_ENV=production without ever touching /Users/Shared/Swob', () => {
    // Positive control: the writer identity these commands actually needed was
    // created (and its machine-local backup written) inside this sandbox, so a
    // pass here is not merely "nothing was written anywhere".
    expect(fs.existsSync(path.join(fixtureHome, '.swob-machine', 'host-identity-v1.json'))).toBe(false)
    expect(fs.existsSync(path.join(sandboxRoot, '.swob-machine', 'host-identity-v1.json'))).toBe(true)
    expect(fs.existsSync(path.join(sandboxRoot, '.claude-session-manager', 'host-identity-v1.json'))).toBe(true)
    // The real path: read-only lstat signature, unchanged from before beforeAll
    // did any work. Never asserted absent outright - a real identity commonly
    // already exists on the machine running this test (it does on this one,
    // from the very 2026-09-26 22:22 incident this deliverable fixes).
    expect(inspectRealPathSignature(REAL_HOST_IDENTITY_FILE)).toBe(realHostIdentityFileStateBefore)
    expect(inspectRealPathSignature(REAL_HOST_IDENTITY_DIR)).toBe(realHostIdentityDirStateBefore)
  })
})
