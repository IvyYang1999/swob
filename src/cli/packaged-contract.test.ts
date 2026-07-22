import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { CLI_COMMANDS, CLI_VERSION } from './command-registry'

const packagedApp = process.env.SWOB_PACKAGED_APP
const describePackaged = packagedApp ? describe.sequential : describe.skip
const SESSION_A = '92000000-0000-4000-8000-000000000117'
const SESSION_B = '93000000-0000-4000-8000-000000000117'

interface Invocation {
  code: number
  stdout: string
  stderr: string
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
let childProcess: ChildProcess | null = null
let commandEnvironment: NodeJS.ProcessEnv = {}
const exercised = new Set<string>()

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

function minimalInheritedEnvironment(): NodeJS.ProcessEnv {
  const inherited: NodeJS.ProcessEnv = {}
  for (const name of ['PATH', 'LANG', 'LC_ALL', 'SHELL', 'USER', 'LOGNAME']) {
    const value = process.env[name]
    if (value) inherited[name] = value
  }
  return inherited
}

function invokeRaw(executable: string, args: string[], stdin = ''): Invocation {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    env: commandEnvironment,
    input: stdin,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60_000
  })
  if (result.error) throw result.error
  return { code: result.status ?? 1, stdout: result.stdout || '', stderr: result.stderr || '' }
}

function invokeBootstrap(args: string[], stdin = ''): Invocation {
  return invokeRaw(process.execPath, [packagedCli, ...args], stdin)
}

function invokeInstalled(usage: string, args: string[], stdin = ''): Invocation {
  exercised.add(usage)
  return invokeRaw(installedCommand, args, stdin)
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
  const appPath = packagedApp
  packagedCli = path.join(appPath, 'Contents', 'Resources', 'cli', 'cli.js')
  unpackedNodeModules = path.join(appPath, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules')
  expect(fs.existsSync(packagedCli)).toBe(true)
  expect(fs.existsSync(path.join(unpackedNodeModules, 'better-sqlite3'))).toBe(true)

  sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-packaged-cli-'))
  fixtureHome = path.join(sandboxRoot, 'home')
  libraryRoot = path.join(sandboxRoot, 'Library')
  projectRoot = path.join(sandboxRoot, 'project with space')
  const cliTargetDir = path.join(fixtureHome, 'bin')
  const tempDir = path.join(sandboxRoot, 'tmp')
  for (const dirPath of [fixtureHome, libraryRoot, projectRoot, cliTargetDir, tempDir]) {
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
    SWOB_LIBRARY_ROOT: libraryRoot,
    SWOB_PACKAGED_APP: appPath,
    SWOB_SEARCH_INDEX_DIR: path.join(sandboxRoot, 'search-index'),
    SWOB_TEST_APP_CLI_PATH: packagedCli,
    SWOB_TEST_CLI_TARGET_DIR: cliTargetDir,
    SWOB_TEST_HOME: fixtureHome,
    TEMP: tempDir,
    TMP: tempDir,
    TMPDIR: tempDir,
    VITEST: 'false'
  }
  installedCommand = path.join(cliTargetDir, 'swob')
})

afterAll(() => {
  if (childProcess && childProcess.exitCode === null) childProcess.kill('SIGTERM')
  if (sandboxRoot) fs.rmSync(sandboxRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
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
  })

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
  })

  it('resolves lineage and exercises resume surfaces through the installed command', async () => {
    const lineageDry = parseSuccess(invokeInstalled('lineage [--dry-run]', ['lineage', '--dry-run', '--json']))
    expect(lineageDry).toHaveProperty('aliases')
    parseSuccess(invokeInstalled('lineage [--dry-run]', ['lineage', '--json']))
    expect(fs.existsSync(path.join(libraryRoot, '.session-lineage.json'))).toBe(true)

    const resolved = parseSuccess(invokeInstalled('resolve <sessionId> [--json]', ['resolve', SESSION_A, '--json']))
    expect(resolved).toMatchObject({ matched: true, resolved: SESSION_B })

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
    childProcess = spawn(fakeClaude, ['--resume', SESSION_A], { env: commandEnvironment, stdio: 'ignore' })
    await waitForProcessStart()
    const active = parseSuccess(invokeInstalled('active', ['active', '--json']))
    expect(active.activeSessionIds).toContain(SESSION_A)
    childProcess.kill('SIGTERM')
    childProcess = null
  })

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
  })

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
  })

  it('persists config and executes analytics/transcript/redaction maintenance', () => {
    expect(parseSuccess(invokeInstalled('config set <key> <value>', ['config', 'set', 'terminalApp', 'iTerm2', '--json']))).toMatchObject({ terminalApp: 'iTerm2' })
    expect(parseSuccess(invokeInstalled('config get [key]', ['config', 'get', 'terminalApp', '--json']))).toEqual({ terminalApp: 'iTerm2' })

    const insights = parseSuccess(invokeInstalled('insights [--json] [--summary]', ['insights', '--summary', '--json']))
    expect(insights).toMatchObject({ totalSessions: 2, totalTokensMetric: 'input_plus_output' })

    const rebuilt = parseSuccess(invokeInstalled(
      'transcript rebuild --all [--dry-run] [--missing-only]',
      ['transcript', 'rebuild', '--all', '--missing-only', '--json']
    ))
    expect(rebuilt).toMatchObject({ dryRun: false, missingOnly: true, sessionCount: 2, failed: 0 })
    expect(rebuilt.written).toBeGreaterThan(0)

    const redacted = parseSuccess(invokeInstalled('redact [--dry-run]', ['redact', '--json']))
    expect(redacted).toMatchObject({ files: expect.any(Number), hits: expect.any(Number) })
  })

  it('covers every command definition through the real installed wrapper', () => {
    expect([...exercised].sort()).toEqual(CLI_COMMANDS.map((command) => command.usage).sort())
  })
})
